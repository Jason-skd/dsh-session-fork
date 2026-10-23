/**
 * Host-side custom RPC channel for the branch-graph GUI tab.
 * @module dsh-session-fork/src/rpc
 *
 * dsh authenticates requests through its Connection service, but reserves
 * the only `/api` interceptor for the core API. This plugin owns one Web
 * route, `/dsh-session-fork`, and reuses Connection admission before
 * decoding the same unary RPC envelope.
 *
 * The channel name complies with the host's CHANNEL_PATTERN
 * (`/^\/[A-Za-z0-9._~-]+$/`, rpc-host.ts) and is not the reserved `/api`.
 * Only owner principals may call the decoded endpoints. Browser requests
 * still pass through Connection's configured authority fence.
 *
 * Every dsh touchpoint here is a *structural* declaration (no host package
 * import), mirroring the pattern already used for `ctx.get('workspaceRegistry')`
 * etc. in index.ts: `RpcResult`/`RpcHandler` are declared to be
 * shape-compatible with the host's
 * `RpcResult<T>` (packages/host/apiproxy/src/api/rpc.ts:110) and
 * `ConnectionRpcHandler` (packages/client/connection/src/rpc.ts), so the
 * handler stays unit-testable without cordis.
 */

import { z } from 'zod'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { branchErrorMessage } from './command.js'
import type { ArchiveOutcome } from './branch.js'
import { assembleBranchGraph, extractTurns, summarizeTurnEvents } from './graph.js'
import type { BranchGraph, BranchLike, GraphNode, GraphNodeRef, GraphSessionLog } from './graph.js'
import { getBranch, listBranches, removeBranch } from './registry.js'
import { dispatchSquash } from './squash-midturn.js'
import type { SquashChildAgent } from './squash-command.js'
import type { ForkOrigin, RegistryState, RegistryStore, SessionExists } from './types.js'
import type { CompactRegionRequest } from './vendor/compact.js'
import { RPC_CHANNEL } from './rpc-contract.js'

export { RPC_CHANNEL } from './rpc-contract.js'

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
  peer?: { readonly principal: { readonly kind: string } },
) => Promise<RpcResult<unknown>>

/** Authenticated peer admission exposed by the Connection service. */
export interface ConnectionRpcLike {
  admit(request: Pick<IncomingMessage, 'headers'>): RpcPeerAdmission
}

/** Minimal authenticated Web route registry. */
export interface WebServerLike {
  register(route: {
    readonly kind: 'prefix'
    readonly path: string
    readonly handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  }): () => unknown
}

type RpcPeerAdmission =
  | { readonly peer: { readonly principal: { readonly kind: string } } }
  | { readonly rejection: 401 | 403 }

/**
 * Register this plugin's authenticated HTTP route.
 *
 * The current Connection service shares one interceptor on `/api`, so a
 * plugin-owned custom channel cannot use it without replacing the core API
 * dispatcher. This adapter carries the same Connection request envelope over
 * its own trusted route and reuses Connection's Host/Origin and session
 * authentication through `admit()`.
 */
export function registerRpcChannel(
  connection: ConnectionRpcLike,
  webServer: WebServerLike,
  handler: RpcHandler,
): () => unknown {
  return webServer.register({
    kind: 'prefix',
    path: RPC_CHANNEL,
    async handler(request, response) {
      const admission = connection.admit(request)
      if ('rejection' in admission) {
        response.writeHead(admission.rejection, { 'content-type': 'text/plain; charset=utf-8' })
        response.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      if (admission.peer.principal.kind !== 'owner') {
        response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('forbidden')
        return
      }
      let envelope: z.infer<typeof rpcRequestSchema> | undefined
      try {
        envelope = await readRpcRequest(request, response)
      } catch {
        if (!request.aborted && !response.headersSent) {
          response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('request body read failed')
        }
        return
      }
      if (envelope === undefined) return
      const controller = new AbortController()
      request.once('aborted', () => { controller.abort() })
      let result: RpcResult<unknown>
      try {
        result = await handler(envelope.method, envelope.payload, controller.signal, admission.peer)
      } catch (error) {
        result = {
          ok: false,
          error: {
            code: 'internal',
            message: error instanceof Error ? error.message : String(error),
            details: {},
          },
        }
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({
        type: 'server-response',
        rpcId: envelope.rpcId,
        result,
      }))
    },
  })
}

const rpcRequestSchema = z.object({
  type: z.literal('client-request'),
  rpcId: z.string(),
  method: z.string(),
  payload: z.unknown(),
})

const MAX_RPC_BODY_BYTES = 1024 * 1024

async function readRpcRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<z.infer<typeof rpcRequestSchema> | undefined> {
  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' })
    response.end('method not allowed')
    return undefined
  }
  const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    response.writeHead(415, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('content type must be application/json')
    return undefined
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_RPC_BODY_BYTES) {
      response.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('request body too large')
      return undefined
    }
    chunks.push(bytes)
  }
  let body: unknown
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('body is not JSON')
    return undefined
  }
  const parsed = rpcRequestSchema.safeParse(body)
  if (!parsed.success) {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('invalid client-request envelope')
    return undefined
  }
  const endpoint = new URL(request.url ?? '/', 'http://localhost').pathname.slice(RPC_CHANNEL.length + 1)
  if (endpoint !== parsed.data.method || !/^[A-Za-z0-9._~-]+$/.test(endpoint)) {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('method does not match endpoint')
    return undefined
  }
  return parsed.data
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
 * {@link dispatchSquash}, minus the command-bound child agent.
 */
export interface SquashPorts {
  /**
   * Resolve the child agent of one session: live agent store first; a
   * cold (never-live or closed) session resumes through the vendored
   * kernel path — resume, never create (2026-08-21 squash 定案), and the
   * resumed agent is flushed after the write but never destroyed.
   * `null` when the session does not exist at all.
   */
  resolveChildAgent(sessionId: string): Promise<SquashChildAgent | null>
  /** Open the workspace-keyed registry store for the pipeline. */
  openStore(workspaceKey: string): RegistryStore
  /** The vendored compaction shell (runMaintenance inside). */
  compact(
    agent: Agent,
    signal: AbortSignal,
    request: CompactRegionRequest,
  ): Promise<CompactionResult>
  /** Target-side agent resolution (vendored ensureSession kernel); public `Agent` only — delivery goes through `inject`. */
  resolveTargetAgent(sessionId: string): Promise<Agent>
  /** Durability checkpoint for one agent's session (`ctx.sessions.flush`). */
  flush(agent: Agent): Promise<unknown>
  /**
   * Track one detached mid-turn handoff continuation (the RPC twin of the
   * command path's in-flight bookkeeping); when absent the continuation
   * runs untracked (fire-and-forget with rejection safety).
   */
  trackDetached?(operation: Promise<void>): void
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
   * Archive one session through the official `workspace.archiveSession`
   * handler (the `removeBranch` endpoint's companion): `'missing'` for a
   * session neither live nor persisted (dangling ref — no archive step);
   * infrastructure failures throw with the command-layer wording and
   * abort the removal before the registry write.
   */
  archiveSession(sessionId: string): Promise<ArchiveOutcome>
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
 *   ({@link dispatchSquash}) against the named target branch. This stage
 *   keeps the command's lineage constraint: the target must be the branch
 *   owning the child's parent session. Returns `{ message }` on success;
 *   every failure (busy child/parent, non-parent target, unknown branch)
 *   carries the pipeline's user-facing wording.
 * - `removeBranch` — payload `{ sessionId, name }` (issue #23 GUI remove):
 *   the exact `/branch rm --yes` semantics over the RPC face — archive the
 *   named branch's session (official handler, data kept), then delete the
 *   ref; a session that exists neither live nor on disk (a dangling ref)
 *   skips the archive. The confirmation lives client-side (the official
 *   RiskConfirmation checkbox gates this call). Returns `{ message }` on
 *   success; unknown names and archive failures carry the command's
 *   user-facing wording.
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
      // RiskConfirmation checkbox gates this call), and the host archives
      // the session (the one fallible side effect, BEFORE the registry
      // write — an archive failure leaves the ref in place and the removal
      // retryable) and deletes the ref. Dangling refs are removable
      // identically: the archive returns 'missing' and the ref alone goes.
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
        const outcome = await ports.archiveSession(getBranch(state, parsed.data.name).sessionId)
        const next = removeBranch(state, parsed.data.name) // throws on unknown names
        await ports.saveRegistry(workspaceKey, next)
        const value: RemoveBranchValue = {
          message: outcome === 'archived'
            ? `Removed branch '${parsed.data.name}'; its session is archived (data kept, hidden from the sidebar).`
            : `Removed branch '${parsed.data.name}' (session already missing; ref deleted).`,
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
        // Mid-turn sources (the branch's agent still running its turn) take
        // the squash handoff: official turn cancellation, deferred idle
        // execution, follow-up report (src/squash-midturn.ts).
        const result = await dispatchSquash(parsed.data.target, {
          childAgent,
          signal,
          store: ports.squash.openStore(workspaceKey),
          compact: ports.squash.compact,
          resolveTargetAgent: ports.squash.resolveTargetAgent,
          flush: ports.squash.flush,
        }, ports.squash.trackDetached ?? ((operation) => { void operation.then(() => {}, () => {}) }))
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
