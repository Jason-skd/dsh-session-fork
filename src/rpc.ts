/**
 * Host-side custom RPC channel for the branch-graph GUI tab.
 * @module dsh-session-fork/src/rpc
 *
 * dsh exposes a generic unary RPC transport per logical channel
 * (`HostConnectionRpc.handle(channel, handler, options)` in
 * packages/client/connection/src/rpc.ts of the harness checkout, wired
 * through the HTTP route in packages/client/connection/src/rpc-host.ts).
 * This plugin owns one channel, `/dsh-session-fork`, and serves a single
 * `registry` endpoint: the branch-registry snapshot of the workspace a
 * given session belongs to.
 *
 * The channel name complies with the host's CHANNEL_PATTERN
 * (`/^\/[A-Za-z0-9._~-]+$/`, rpc-host.ts) and is not the reserved `/api`.
 * Trust is `loopback`: only the browser served by this very host may call
 * the endpoint — the GUI tab is rendered by the same web app, and a plugin
 * channel should never be reachable from other origins.
 *
 * Every dsh touchpoint here is a *structural* declaration (no host package
 * import), mirroring the pattern already used for `ctx.get('workspaceRegistry')`
 * etc. in index.ts: `RpcResult`/`RpcHandler` are declared to be
 * shape-compatible with the host's
 * `RpcResult<T>` (packages/host/apiproxy/src/api/rpc.ts:110) and
 * `ConnectionRpcHandler` (packages/client/connection/src/rpc.ts), so the
 * handler stays unit-testable without cordis and the plugin keeps its
 * no-host-imports dependency policy.
 */

import { z } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { branchErrorMessage } from './command.js'
import { assembleBranchGraph, extractTurns, summarizeTurnEvents } from './graph.js'
import type { BranchGraph, BranchLike, GraphNode, GraphNodeRef, GraphSessionLog } from './graph.js'
import { listBranches, removeBranch } from './registry.js'
import { executeSquash } from './squash-command.js'
import type { SquashAgent } from './squash-command.js'
import type { ForkOrigin, RegistryState, RegistryStore, SessionExists } from './types.js'
import type { CompactRegionRequest } from './vendor/compact.js'

/** Channel path this plugin owns on the host connection registry. */
export const RPC_CHANNEL = '/dsh-session-fork'

/**
 * Error branch of {@link RpcResult} as emitted by this plugin.
 *
 * dsh's `RpcError` is a closed union of codes (the keys of
 * `RpcErrorDetailsMap`); a plugin has no business inventing codes, so every
 * business failure folds into `internal` with `details: {}` — the same shape
 * the host's `transportError` produces (api/rpc.ts). Declared structurally:
 * `{ code: 'internal' }` is assignable to the host's closed union member for
 * `internal`, keeping the whole result assignable to the host's
 * `RpcResult<unknown>`.
 */
export interface RpcInternalError {
  readonly code: 'internal'
  readonly message: string
  readonly details: Record<string, never>
}

/** Structural mirror of the host's `RpcResult<T>`: methods never throw business errors. */
export type RpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RpcInternalError }

/** Structural mirror of the host's `ConnectionRpcHandler`. */
export type RpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<RpcResult<unknown>>

/** Structural slice of the host's `ConnectionRpcHandlerOptions`. */
export interface RpcChannelOptions {
  readonly authority: 'trusted-host' | 'loopback'
}

/**
 * Structural slice of the host's `HostConnectionHandle`: the handle nests the
 * channel registry under `rpc` (`HostConnectionService` implements
 * `HostConnectionHandle` = `{ rpc: HostConnectionRpc }`, rpc-host.ts), so the
 * slice must too — a flat slice compiles but finds `handle` undefined on the
 * real service.
 */
export interface ConnectionRpcLike {
  readonly rpc: {
    handle(
      channel: string,
      handler: RpcHandler,
      options: RpcChannelOptions,
    ): () => Promise<void>
  }
}

/**
 * Register this plugin's channel through the host connection registry.
 *
 * Pure with respect to dsh: takes a structural handle, hardcodes the channel
 * name and loopback trust, and returns the disposer produced by `handle`
 * (removing the channel and its physical route) for the caller's effect
 * layer to yield.
 */
export function registerRpcChannel(
  connection: ConnectionRpcLike,
  handler: RpcHandler,
): () => Promise<void> {
  return connection.rpc.handle(RPC_CHANNEL, handler, { authority: 'loopback' })
}

/** One branch as served by the `registry` endpoint: record fields + liveness flag. */
export interface BranchSnapshot {
  readonly name: string
  readonly sessionId: string
  readonly forkOrigin: ForkOrigin | null
  readonly createdAt?: string
  readonly dangling: boolean
}

/** Success value of the `registry` endpoint. */
export interface RegistrySnapshot {
  readonly branches: readonly BranchSnapshot[]
}

export type { BranchGraph, GraphNode, GraphNodeRef, GraphSessionLog }

/** Payload contract shared by the read endpoints. */
const registryPayloadSchema = z.object({
  sessionId: z.string().min(1),
})

/**
 * Payload contract of the `fork` endpoint (the hijacked official fork
 * button's wire shape): which session, optional in-log turn anchor, and
 * the mandatory branch name the dialog collected.
 */
const forkPayloadSchema = z.object({
  sessionId: z.string().min(1),
  name: z.string(),
  atSeq: z.number().int().nonnegative().optional(),
})

/** Success value of the `fork` endpoint: the created child session id. */
export interface ForkValue {
  readonly sessionId: string
}

/** Payload contract of the `turnEvents` endpoint (row expansion, issue #8). */
const turnEventsPayloadSchema = z.object({
  sessionId: z.string().min(1),
  turn: z.number().int().nonnegative(),
})

/** Success value of the `turnEvents` endpoint: the turn's event rows. */
export interface TurnEventsValue {
  readonly events: readonly { readonly seq: number; readonly type: string; readonly text: string }[]
}

/** Payload contract of the `squash` endpoint (issue #8 right-click squash). */
const squashPayloadSchema = z.object({
  sessionId: z.string().min(1),
  target: z.string().min(1),
})

/** Success value of the `squash` endpoint: the command-shaped summary. */
export interface SquashValue {
  readonly message: string
}

/** Payload contract of the `removeBranch` endpoint (issue #23 GUI remove). */
const removeBranchPayloadSchema = z.object({
  sessionId: z.string().min(1),
  name: z.string().min(1),
})

/** Success value of the `removeBranch` endpoint: the command-shaped summary. */
export interface RemoveBranchValue {
  readonly message: string
}

/**
 * The squash execution capabilities the `squash` endpoint needs — the same
 * injection face the `/squash` command handler feeds into
 * {@link executeSquash}, minus the command-bound child agent.
 */
export interface SquashPorts {
  /**
   * Resolve the child agent of one session: live agent store first; a
   * cold (never-live or closed) session resumes through the vendored
   * kernel path — resume, never create (2026-08-21 squash 定案), and the
   * resumed agent is flushed after the write but never destroyed.
   * `null` when the session does not exist at all.
   */
  resolveChildAgent(sessionId: string): Promise<SquashAgent | null>
  /** Open the workspace-keyed registry store for the pipeline. */
  openStore(workspaceKey: string): RegistryStore
  /** The vendored compaction shell (runMaintenance inside). */
  compact(
    agent: Agent,
    signal: AbortSignal,
    request: CompactRegionRequest,
  ): Promise<CompactionResult>
  /** Parent-side agent resolution (vendored ensureSession kernel). */
  resolveParentAgent(sessionId: string): Promise<SquashAgent>
  /** Durability checkpoint for one agent's session (`ctx.sessions.flush`). */
  flush(agent: Agent): Promise<unknown>
}

/**
 * Capabilities the RPC handler needs. Production wires live ctx reads in
 * index.ts (live-first cwd resolution, domain-store-backed registry loads,
 * and the shared session liveness check); tests inject in-memory fakes.
 */
export interface BranchRpcPorts {
  /**
   * Resolve the workspace key (the session's `cwd`, `''` when unset) of a
   * session — live session store first, persistence inspect as fallback.
   * `null` when the session does not exist at all.
   */
  resolveWorkspaceKey(sessionId: string): Promise<string | null>
  /** Load the branch registry of one workspace key (never-written → empty state). */
  loadRegistry(workspaceKey: string): Promise<RegistryState>
  /** Persist the branch registry of one workspace key (the `removeBranch` endpoint). */
  saveRegistry(workspaceKey: string, state: RegistryState): Promise<void>
  /**
   * Read one session's log (header lineage facts + events) for graph
   * assembly — live session store first, persistence inspect as fallback.
   * `null` when the session does not exist (its branch degrades by omission).
   */
  readSession(sessionId: string): Promise<GraphSessionLog | null>
  /** Liveness check used for dangling marking. */
  readonly sessionExists: SessionExists
  /**
   * Create a named branch fork — the `/branch create` pipeline
   * ({@link createNamedBranch}) with the source session's workspace
   * registry as the authority. Serves the `fork` endpoint the hijacked
   * official fork button calls.
   * @throws with a user-facing message (see `branchErrorMessage`) on an
   *   invalid/duplicate name (before any fork side effect), a missing
   *   source session, or a fork/rename failure.
   */
  createBranch(request: {
    readonly name: string
    readonly sourceSessionId: string
    readonly atSeq?: number
  }): Promise<ForkValue>
  /** Squash execution capabilities (the `squash` endpoint, issue #8). */
  readonly squash: SquashPorts
}

/**
 * Build the channel handler. Cordis-free: everything dsh-shaped arrives
 * through {@link BranchRpcPorts}. Endpoints:
 *
 * - `registry` — payload `{ sessionId }`; resolves the session's workspace
 *   key, loads that workspace's registry, and returns
 *   `{ branches: [{ name, sessionId, forkOrigin, createdAt, dangling }] }`
 *   (sorted by name, dangling refs marked through `sessionExists`).
 * - `graph` — payload `{ sessionId }`; assembles the workspace's branch
 *   graph ({@link BranchGraph}: newest-first turn nodes with lineage and
 *   branch-name refs, plus the payload session's head node id) from the
 *   registry plus the branch sessions' logs.
 * - `fork` — payload `{ sessionId, name, atSeq? }`; runs the full
 *   `/branch create` pipeline host-side (name gate against the registry
 *   BEFORE forking, official agent-path fork, official rename, record
 *   write) and returns `{ sessionId }` of the created child. Serves the
 *   hijacked official fork button.
 * - `turnEvents` — payload `{ sessionId, turn }` (issue #8 row expansion);
 *   locates the turn through {@link extractTurns} and returns
 *   `{ events: [{ seq, type, text }] }` — every event of the turn's
 *   `startSeq..endSeq` span (tool calls included), each with a one-line
 *   summary text ({@link summarizeTurnEvents}). Unknown session, unknown
 *   turn, or a synthetic (row-less) turn folds into a readable error.
 * - `squash` — payload `{ sessionId, target }` (issue #8 right-click
 *   squash): resolves the child agent (live first, cold sessions resume —
 *   never create), then runs the exact `/squash` command pipeline
 *   ({@link executeSquash}) against the named target branch. This stage
 *   keeps the command's lineage constraint: the target must be the branch
 *   owning the child's parent session. Returns `{ message }` on success;
 *   every failure (busy child/parent, non-parent target, unknown branch)
 *   carries the pipeline's user-facing wording.
 * - `removeBranch` — payload `{ sessionId, name }` (issue #23 GUI remove):
 *   the exact `/branch rm --yes` registry semantics over the RPC face —
 *   delete the named ref only, never session data; dangling refs are
 *   removable the same way (their sessions are gone, the ref stays until
 *   explicitly removed). Returns `{ message }` on success; unknown names
 *   carry the command's user-facing wording.
 *
 * Anything else — unknown endpoints, malformed payloads, missing sessions,
 * thrown port failures — folds into `{ ok: false, error: { code: 'internal',
 * message, details: {} } }`. A handler must never throw: the host would turn
 * a thrown error into an opaque HTTP 500 instead of a business result.
 */
export function createBranchRpcHandler(ports: BranchRpcPorts): RpcHandler {
  return async (endpoint, payload, signal) => {
    if (endpoint === 'removeBranch') {
      // The GUI remove action (issue #23): the `/branch rm --yes`
      // semantics — the confirmation lives client-side (the official
      // RiskConfirmation checkbox gates this call), and the host deletes
      // the ref only. Dangling refs are removable identically: the
      // registry transform never consults session liveness.
      try {
        const parsed = removeBranchPayloadSchema.safeParse(payload)
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; ')
          return internalError(`invalid "removeBranch" payload: ${issues}`)
        }
        const workspaceKey = await ports.resolveWorkspaceKey(parsed.data.sessionId)
        if (workspaceKey === null) {
          return internalError(`no session named ${JSON.stringify(parsed.data.sessionId)} exists`)
        }
        const state = await ports.loadRegistry(workspaceKey)
        const next = removeBranch(state, parsed.data.name) // throws on unknown names
        await ports.saveRegistry(workspaceKey, next)
        const value: RemoveBranchValue = {
          message: `Removed branch '${parsed.data.name}'. Sessions are untouched.`,
        }
        return { ok: true, value }
      } catch (error) {
        return internalError(branchErrorMessage(error))
      }
    }
    if (endpoint === 'squash') {
      // The right-click squash action (issue #8): the exact `/squash`
      // command pipeline, entered through the RPC face. The child agent
      // resolves live-first (cold sessions resume — never create, and the
      // resumed agent is flushed after the write but never destroyed, per
      // the 2026-08-21 squash 定案); every pipeline failure carries its
      // command-shaped, user-facing wording into the dialog's error row.
      try {
        const parsed = squashPayloadSchema.safeParse(payload)
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; ')
          return internalError(`invalid "squash" payload: ${issues}`)
        }
        const workspaceKey = await ports.resolveWorkspaceKey(parsed.data.sessionId)
        if (workspaceKey === null) {
          return internalError(`no session named ${JSON.stringify(parsed.data.sessionId)} exists`)
        }
        const childAgent = await ports.squash.resolveChildAgent(parsed.data.sessionId)
        if (childAgent === null) {
          return internalError(`no session named ${JSON.stringify(parsed.data.sessionId)} exists`)
        }
        const result = await executeSquash(parsed.data.target, {
          childAgent,
          signal,
          store: ports.squash.openStore(workspaceKey),
          compact: ports.squash.compact,
          resolveParentAgent: ports.squash.resolveParentAgent,
          flush: ports.squash.flush,
        })
        return result.kind === 'success'
          ? { ok: true, value: { message: result.text ?? '' } satisfies SquashValue }
          : internalError(result.text)
      } catch (error) {
        return internalError(error)
      }
    }
    if (endpoint === 'fork') {
      // The write endpoint: the hijacked fork button's single round trip.
      // Everything that can reject a bad request (payload shape, name
      // validity/uniqueness, source existence) happens before any fork
      // side effect, and every failure renders through the shared
      // command-layer message mapping so dialog and /branch read alike.
      try {
        const parsed = forkPayloadSchema.safeParse(payload)
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; ')
          return internalError(`invalid "fork" payload: ${issues}`)
        }
        const value = await ports.createBranch({
          name: parsed.data.name,
          sourceSessionId: parsed.data.sessionId,
          ...(parsed.data.atSeq === undefined ? {} : { atSeq: parsed.data.atSeq }),
        })
        return { ok: true, value }
      } catch (error) {
        return internalError(branchErrorMessage(error))
      }
    }
    if (endpoint === 'turnEvents') {
      // Row expansion (issue #8): the full event list of one turn — the
      // graph's own rows are human-prompt turns only, so a turn that has
      // no row (synthetic injections) is as absent as an unknown session.
      try {
        const parsed = turnEventsPayloadSchema.safeParse(payload)
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; ')
          return internalError(`invalid "turnEvents" payload: ${issues}`)
        }
        const log = await ports.readSession(parsed.data.sessionId)
        if (log === null) {
          return internalError(`no session named ${JSON.stringify(parsed.data.sessionId)} exists`)
        }
        const slice = extractTurns(log.events)
          .find(turn => turn.turn === parsed.data.turn)
        if (slice === undefined) {
          return internalError(
            `session ${JSON.stringify(parsed.data.sessionId)} has no turn ${parsed.data.turn} on the branch graph`,
          )
        }
        // extractTurns only returns closed turns; guard for future shapes.
        if (slice.endSeq === null) {
          return internalError(
            `turn ${parsed.data.turn} of session ${JSON.stringify(parsed.data.sessionId)} is still open`,
          )
        }
        const value: TurnEventsValue = {
          events: summarizeTurnEvents(log.events, slice.startSeq, slice.endSeq),
        }
        return { ok: true, value }
      } catch (error) {
        return internalError(error)
      }
    }
    if (endpoint !== 'registry' && endpoint !== 'graph') {
      return internalError(
        `unknown endpoint ${JSON.stringify(endpoint)} on channel ${JSON.stringify(RPC_CHANNEL)}`,
      )
    }
    try {
      const parsed = registryPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')
        return internalError(`invalid "${endpoint}" payload: ${issues}`)
      }
      const workspaceKey = await ports.resolveWorkspaceKey(parsed.data.sessionId)
      if (workspaceKey === null) {
        return internalError(`no session named ${JSON.stringify(parsed.data.sessionId)} exists`)
      }
      const state = await ports.loadRegistry(workspaceKey)
      if (endpoint === 'graph') {
        const branches: BranchLike[] = Object.values(state.branches).map(record => ({
          name: record.name,
          sessionId: record.sessionId,
          forkOrigin: record.forkOrigin === null ? null : { ...record.forkOrigin },
        }))
        const value: BranchGraph = await assembleBranchGraph(
          branches,
          parsed.data.sessionId,
          ports.readSession,
        )
        return { ok: true, value }
      }
      const listings = await listBranches(state, ports.sessionExists)
      const value: RegistrySnapshot = {
        branches: listings.map(({ record, dangling }) => ({
          name: record.name,
          sessionId: record.sessionId,
          forkOrigin: record.forkOrigin === null ? null : { ...record.forkOrigin },
          ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
          dangling,
        })),
      }
      return { ok: true, value }
    } catch (error) {
      return internalError(error)
    }
  }
}

/** Fold any failure into the host's `transportError` shape for the closed `internal` code. */
function internalError(error: unknown): RpcResult<never> {
  return {
    ok: false,
    error: {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}
