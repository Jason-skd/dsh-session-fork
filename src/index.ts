/**
 * dsh-session-fork: git-style conversation branching for DeepSeek Harness.
 * @module dsh-session-fork
 *
 * v0.0.1 (ref layer): a per-workspace branch registry persisted through the
 * storage-domain facility, plus the `/branch` command family. Host-side
 * only; zero client/GUI changes (see docs/ROADMAP.md).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
// Type-only presence import: pulls in this package's Context augmentation
// (`ctx.sessionPersistence`) without any runtime dependency on it.
import type {} from '@deepseek-ai/dsh-session-persistence'
// Same presence pattern for the compaction services the squash pipeline
// consumes (`ctx.llm`, `ctx.tokenMeter`).
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { BranchPorts, SourceSessionView } from './branch.js'
import { BranchForkError } from './branch.js'
import { executeBranchAction, parseBranchAction, createNamedBranch } from './command.js'
import { loadRegistry, saveRegistry } from './registry.js'
import { createBranchRpcHandler, registerRpcChannel } from './rpc.js'
import type { BranchRpcPorts, ConnectionRpcLike } from './rpc.js'
import { executeSquashAction, parseSquashAction } from './squash-command.js'
import type { SquashAgent } from './squash-command.js'
import { createDomainStore, dshForkDomainSpec } from './store.js'
import type { DomainLike } from './store.js'
import { compactNow } from './vendor/compact.js'
import { composeAgent, forkWorkspace, getOrResumeAgent, getOrResumeDeps } from './vendor/fork.js'
import type { AgentPresetsLike, WorkspaceLike } from './vendor/fork.js'

export type * from './types.js'
export {
  BranchRegistryError,
  assertBranchNameFree,
  createBranch,
  createFileStore,
  emptyState,
  getBranch,
  listBranches,
  loadRegistry,
  removeBranch,
  renameBranch,
  saveRegistry,
  setBranchSession,
} from './registry.js'
export type { CreateBranchInput } from './registry.js'
export {
  BranchForkError,
  createBranchFrom,
  createRootBranch,
} from './branch.js'
export type {
  BranchPorts,
  CreateBranchOptions,
  SourceEvent,
  SourceSessionView,
} from './branch.js'
export {
  BRANCH_USAGE,
  branchErrorMessage,
  createNamedBranch,
  executeBranchAction,
  parseBranchAction,
} from './command.js'
export type { BranchAction, BranchCommandResult } from './command.js'
export {
  RPC_CHANNEL,
  createBranchRpcHandler,
  registerRpcChannel,
} from './rpc.js'
export type {
  BranchRpcPorts,
  BranchSnapshot,
  ConnectionRpcLike,
  ForkValue,
  RegistrySnapshot,
  RpcHandler,
  RpcInternalError,
  RpcResult,
} from './rpc.js'
export {
  SQUASH_USAGE,
  executeSquashAction,
  parseSquashAction,
} from './squash-command.js'
export type { SquashAction, SquashCommandDeps } from './squash-command.js'
export { createDomainStore, dshForkDomainSpec } from './store.js'
export type { DomainLike } from './store.js'

export const name = 'dsh-session-fork'

/** Host services this plugin needs; the web-app bundle provides all. */
export const inject = [
  'commands',
  'storageDomain',
  'sessions',
  'sessionPersistence',
  'agents',
  'tokenMeter',
  'llm',
  'apiProxy',
  'connection',
]

/**
 * Full log (header + events) of each view handed out by {@link makePorts},
 * retained so the seeded fork path can slice the real `SessionEvent`
 * objects and resolve the source's recorded preset. (The view itself only
 * promises `{ seq, type }` + cwd to keep boundary logic testable.)
 */
interface SourceLog {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

const sourceLogs = new WeakMap<SourceSessionView, SourceLog>()

/** Structural slice of `ctx.get('agentDefaultModel')` relied on. */
interface AgentDefaultModelLike {
  currentSelection(): { provider: string; model: string }
}

/** Structural slice of `ctx.get('workspaceRegistry')` relied on. */
interface WorkspaceRegistryLike {
  list(): WorkspaceLike[]
}

/** Structural slice of `ctx.get('sessionQuery')` relied on. */
interface SessionQueryLike {
  traceSession(sessionId: string): Promise<{ ancestors: ReadonlyArray<{ header: { id: string } }> }>
}

/**
 * Structural slice of `ctx.apiProxy.sessions` relied on: the official
 * `session.rename` handler only. Calling it in-process drives the same
 * gateway instance (and the same SessionTitleService behind it) as the web
 * GUI's rename dialog; the result is the standard RPC shape —
 * `result.ok` true with `{ title, seq }`, or false with a coded error.
 */
interface ApiProxySessionsLike {
  rename(request: {
    rpcId: string
    payload: { sessionId: Session['id']; title: string }
  }): Promise<{
    result: { ok: boolean; value?: { title: string; seq: number }; error?: { code: string; message: string } }
  }>
}

/** Build the fork ports over live-first session reads. */
function makePorts(ctx: Context): BranchPorts {
  return {
    async readSession(sessionId) {
      const live = ctx.sessions.get(sessionId as Session['id'])
      if (live !== undefined) {
        const events = [...live.events]
        const view: SourceSessionView = {
          id: live.id,
          events,
          header: live.header.cwd === undefined ? {} : { cwd: live.header.cwd },
        }
        sourceLogs.set(view, { header: live.header, events })
        return view
      }
      // Cold path: persistence inspect, like api-proxy's readSessionState.
      // Any inspect failure (including not-found) reports as a missing
      // source; the command layer turns that into a clear user error.
      try {
        const inspected = await ctx.sessionPersistence.inspect(sessionId as Session['id'])
        const view: SourceSessionView = {
          id: inspected.meta.id,
          events: [...inspected.events],
          header: inspected.meta.cwd === undefined ? {} : { cwd: inspected.meta.cwd },
        }
        sourceLogs.set(view, { header: inspected.meta, events: inspected.events })
        return view
      } catch (error) {
        ctx.logger.debug(
          `dsh-session-fork: inspect of session "${sessionId}" failed: ${String(error)}`,
        )
        return null
      }
    },
    async createChildFromSeed(childId, source, cut) {
      const log = sourceLogs.get(source)
      if (log === undefined) {
        // Invariant: makePorts always pairs a view with its full log. A miss
        // means a port caller fabricated a view — slicing a fabricated seed
        // would silently fork from nothing.
        throw new Error(
          `dsh-session-fork invariant violation: no source log retained for session "${source.id}"`,
        )
      }
      const events = log.events
      // The vendored helpers from src/vendor/fork.ts mirror the host fork
      // handler's helper chain (forkWorkspace → composeAgent → agents.create
      // → workspace.attachSession); markers and upstream coordinates live
      // there. The host's installSelection is composed through agentOptions
      // here (the plugin seeds the default model selection the same way as
      // the host's entry points), so composeAgent receives a no-op installer
      // and mounting happens in setup exactly like upstream.
      const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
      const query = ctx.get('sessionQuery') as SessionQueryLike | undefined
      // Resolve the target workspace BEFORE creating the child, like the
      // official path: creation is the point of no return, so everything
      // that can be settled up front is.
      const workspace = registry === undefined
        ? undefined
        : await forkWorkspace(
          {
            listWorkspaces: () => registry.list(),
            // Without the query service no ancestor lookup is possible;
            // an ungrouped child is preferable to a failed fork.
            traceSession: async id => query?.traceSession(id) ?? { ancestors: [] },
          },
          { id: source.id, header: log.header },
        )
      const presets = ctx.get('agentPresets') as AgentPresetsLike | undefined
      const forkComposition = await composeAgent(
        { presets, installSelection: () => { } },
        resolveSessionPreset(log),
      )
      // Seed the same default model selection the host's entry points use.
      const defaultModel = ctx.get('agentDefaultModel') as AgentDefaultModelLike | undefined
      await ctx.agents.create({
        sessionId: childId as Session['id'],
        seed: events.slice(0, cut),
        meta: {
          ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
          parentSession: source.id as Session['id'],
          seedLength: cut,
          ...(forkComposition.agentPreset === undefined ? {} : { agentPreset: forkComposition.agentPreset }),
        },
        ...(defaultModel === undefined ? {} : { agentOptions: defaultModel.currentSelection() }),
        setup: forkComposition.setup,
      })
      // Attach failures are surfaced, not swallowed: an unattached child is
      // real but invisible in its workspace, which the user must hear about.
      await workspace?.attachSession(childId)
    },
    async renameSession(sessionId, title) {
      // The official rename handler, in process. The registry gate has
      // already proved the official normalizer holds this title to
      // identity, so an error result here is an internal anomaly — map it
      // onto BranchForkError so the command layer renders it like every
      // other branch-operation failure.
      const api = (ctx.get('apiProxy') as { sessions?: ApiProxySessionsLike } | undefined)?.sessions
      if (api === undefined) {
        throw new BranchForkError(
          'rename-failed',
          'the api-proxy gateway is not mounted in this deployment',
        )
      }
      const response = await api.rename({
        rpcId: `dsh-session-fork:rename:${sessionId}`,
        payload: { sessionId: sessionId as Session['id'], title },
      })
      if (!response.result.ok) {
        const error = response.result.error
        throw new BranchForkError(
          'rename-failed',
          `session rename rejected: ${error?.code ?? 'unknown'}: ${error?.message ?? 'no message'}`,
        )
      }
    },
  }
}

/** Whether a session exists live or on disk. */
async function sessionExists(ctx: Context, sessionId: string): Promise<boolean> {
  if (ctx.sessions.get(sessionId as Session['id']) !== undefined) return true
  try {
    await ctx.sessionPersistence.inspect(sessionId as Session['id'])
    return true
  } catch {
    return false
  }
}

/**
 * Live-first workspace-key resolution (the session's `cwd`, `''` when
 * unset): the live session store answers first, persistence inspect is the
 * cold fallback, and a failed inspect means the session is missing
 * (`null`). Shared by the RPC read endpoints and the `fork` endpoint's
 * store selection.
 */
async function resolveWorkspaceKey(ctx: Context, sessionId: string): Promise<string | null> {
  const live = ctx.sessions.get(sessionId as Session['id'])
  if (live !== undefined) return live.header.cwd ?? ''
  try {
    const inspected = await ctx.sessionPersistence.inspect(sessionId as Session['id'])
    return inspected.meta.cwd ?? ''
  } catch {
    return null
  }
}

/**
 * The `/branch` command definition registered by {@link apply}.
 *
 * The `input` descriptor is load-bearing: the web client's admission
 * (ui-commands matchEnter) treats a registered command without one as
 * bare-only — `/branch main` would fall through to a normal message. With
 * a hint the command claims its leading arguments, and the handler receives
 * them through `invocation.rawInput`.
 */
export const branchCommandDefinition = {
  name: 'branch',
  description: 'Git-style conversation branches: create, list, rm, rename',
  input: { hint: '[<name> | create <name> | adopt <name> | list | rm <name> --yes | rename <old> <new>]' },
} as const

/**
 * The `/squash` command definition registered by {@link apply}. The
 * `input` hint is load-bearing for the same bare-command reason as above.
 */
export const squashCommandDefinition = {
  name: 'squash',
  description: 'Squash this branch back into its parent as one summary checkpoint',
  input: { hint: 'into <branch>' },
} as const

/**
 * Register `/branch`, serve the GUI's custom RPC channel, and own the
 * storage-domain lifecycle — the same effect shape the command-compact
 * lifecycle uses. The yields run: command registration, RPC channel
 * registration, the in-flight command drain, the storage-domain close.
 * Cordis runs yielded disposers in reverse registration order (LIFO), so
 * the set tears down atomically with the plugin fiber.
 */
export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(dshForkDomainSpec)
  const active = new Set<Promise<CommandResult>>()

  // Structural read of the host connection registry (the web-app bundle
  // provides the connection service). When absent — a non-web host — the
  // /branch command family still works and only the RPC channel is skipped.
  const connection = ctx.get('connection') as ConnectionRpcLike | undefined

  ctx.effect(function* () {
    yield ctx.commands.register({
      ...branchCommandDefinition,
      handler: (invocation: CommandInvocation): Promise<CommandResult> => {
        const workspaceKey = invocation.agent.session.header.cwd ?? ''
        const operation = Promise.resolve(
          executeBranchAction(parseBranchAction(invocation.rawInput), {
            currentSessionId: invocation.agent.session.id,
            store: createDomainStore(domain as unknown as DomainLike, workspaceKey),
            ports: makePorts(ctx),
            sessionExists: (id) => sessionExists(ctx, id),
          }),
        ) as Promise<CommandResult>
        active.add(operation)
        const retire = (): void => { active.delete(operation) }
        void operation.then(retire, retire)
        return operation
      },
    })

    if (connection !== undefined) {
      const rpcPorts: BranchRpcPorts = {
        // Live-first workspace resolution, the same order makePorts uses.
        resolveWorkspaceKey: (sessionId) => resolveWorkspaceKey(ctx, sessionId),
        // One domain record per workspace, exactly like the /branch path.
        async loadRegistry(workspaceKey) {
          return loadRegistry(createDomainStore(domain as unknown as DomainLike, workspaceKey))
        },
        // The `removeBranch` endpoint's write path: the same domain store
        // as the load above, so load-modify-save lands in one record.
        async saveRegistry(workspaceKey, state) {
          await saveRegistry(createDomainStore(domain as unknown as DomainLike, workspaceKey), state)
        },
        // Graph assembly reads whole logs: live store first, persistence
        // inspect as the cold fallback — the same order makePorts.readSession
        // uses, but returning the header lineage facts (seedLength /
        // parentSession) instead of a fork view.
        async readSession(sessionId) {
          const live = ctx.sessions.get(sessionId as Session['id'])
          if (live !== undefined) {
            return {
              header: {
                ...(live.header.seedLength === undefined ? {} : { seedLength: live.header.seedLength }),
                ...(live.header.parentSession === undefined
                  ? {}
                  : { parentSession: live.header.parentSession as string }),
              },
              events: [...live.events],
            }
          }
          try {
            const inspected = await ctx.sessionPersistence.inspect(sessionId as Session['id'])
            return {
              header: {
                ...(inspected.meta.seedLength === undefined ? {} : { seedLength: inspected.meta.seedLength }),
                ...(inspected.meta.parentSession === undefined
                  ? {}
                  : { parentSession: inspected.meta.parentSession as string }),
              },
              events: [...inspected.events],
            }
          } catch {
            return null
          }
        },
        sessionExists: (id) => sessionExists(ctx, id),
        // The hijacked fork button's write path: the exact /branch create
        // pipeline, with the source session's workspace registry as the
        // authority. A missing source fails before any store selection.
        async createBranch({ name, sourceSessionId, atSeq }) {
          const workspaceKey = await resolveWorkspaceKey(ctx, sourceSessionId)
          if (workspaceKey === null) {
            throw new BranchForkError(
              'source-not-found',
              `no session named '${sourceSessionId}' exists`,
            )
          }
          return createNamedBranch(name, {
            currentSessionId: sourceSessionId,
            store: createDomainStore(domain as unknown as DomainLike, workspaceKey),
            ports: makePorts(ctx),
            sessionExists: (id) => sessionExists(ctx, id),
          }, atSeq === undefined ? {} : { atSeq })
        },
        // The right-click squash action (issue #8): the same execution
        // capabilities the /squash command handler injects. Child-agent
        // resolution is live-first; a cold session resumes through the
        // vendored ensureSession kernel — resume, never create (2026-08-21
        // squash 定案), and the resumed agent is flushed after the write
        // but never destroyed here (it stays registered for later reads).
        squash: {
          async resolveChildAgent(sessionId) {
            const live = ctx.agents.get(sessionId as Session['id'])
            if (live !== undefined) return live as SquashAgent
            // `null` is reserved for a session that does not exist at all;
            // an existing-but-unresolvable session (a resume I/O failure,
            // for instance) propagates its real error instead of being
            // misreported as "no session exists" downstream.
            if (!(await sessionExists(ctx, sessionId))) return null
            return getOrResumeAgent(
              getOrResumeDeps(ctx), sessionId as Session['id'],
            ) as Promise<SquashAgent>
          },
          openStore: (workspaceKey) =>
            createDomainStore(domain as unknown as DomainLike, workspaceKey),
          compact: (agent, signal, request) =>
            compactNow({ meter: ctx.tokenMeter, llm: ctx.llm }, agent, signal, request),
          resolveParentAgent: (sessionId) =>
            getOrResumeAgent(getOrResumeDeps(ctx), sessionId as Session['id']) as Promise<SquashAgent>,
          flush: (agent) => ctx.sessions.flush(agent.session),
        },
      }
      yield registerRpcChannel(connection, createBranchRpcHandler(rpcPorts))
    }

    yield ctx.commands.register({
      ...squashCommandDefinition,
      handler: (invocation: CommandInvocation): Promise<CommandResult> => {
        const workspaceKey = invocation.agent.session.header.cwd ?? ''
        const operation = Promise.resolve(
          executeSquashAction(parseSquashAction(invocation.rawInput), {
            childAgent: invocation.agent as SquashAgent,
            signal: invocation.signal,
            ...invocation.commandId === undefined ? {} : { commandId: invocation.commandId },
            store: createDomainStore(domain as unknown as DomainLike, workspaceKey),
            compact: (agent, signal, request) =>
              compactNow({ meter: ctx.tokenMeter, llm: ctx.llm }, agent, signal, request),
            resolveParentAgent: (sessionId) =>
              getOrResumeAgent(getOrResumeDeps(ctx), sessionId as Session['id']) as Promise<SquashAgent>,
            flush: (agent) => ctx.sessions.flush(agent.session),
          }),
        ) as Promise<CommandResult>
        active.add(operation)
        const retire = (): void => { active.delete(operation) }
        void operation.then(retire, retire)
        return operation
      },
    })
    yield async () => { await Promise.allSettled(active) }
    yield async () => { await domain.close() }
  }, 'dsh-session-fork lifecycle')
}
