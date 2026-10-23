/**
 * VENDORED FROM: deepseek-harness@99f6f02fecdb7dff40c3fbc9470f5907c29f74ca
 * (copied 2026-08-21)
 *
 * - packages/host/apiproxy/src/api-proxy.ts:2303-2398 — the `session.fork`
 *   RPC handler: readSessionState, anchoredBoundary + cut-tail extension,
 *   forkWorkspace, composeAgent, agents.create, workspace.attachSession.
 * - packages/host/apiproxy/src/api-proxy.ts:1481-1492 — `forkWorkspace`
 *   helper (direct workspace, else nearest owning ancestor for a subagent
 *   source).
 * - packages/host/apiproxy/src/api-proxy.ts:1196-1217 — `composeAgent`
 *   helper (resolve the preset before creation; mount it in setup).
 *
 * The handler's `resolveSessionPreset` helper that used to live in
 * ./resolve-session-preset.ts is gone — upstream replaced the event-scan
 * with the `agentPreset` projection read in dsh 0.1.2-rc.1
 * (agent.ts:504-509, the same `presetForObservation(observation)`). The
 * projection fold is what the kernel now consumes; the plugin migrates
 * the default readState wiring to `ctx.sessionQuery.observeSession` and
 * resolves the preset from `observation.projections.values.agentPreset`
 * (with the header fallback when the projection registry is absent) — no
 * vendored scanner remains.
 *
 * `getOrResumeAgent` at the end of this file is a later addition carrying its
 * own VENDORED FROM header (deepseek-harness@528c682e…, api-proxy.ts:1078 +
 * 1569-1659): the checkout advanced past 99f6f02f before that kernel was
 * copied.
 *
 * Re-aligned against dsh 0.1.2-rc.1 (2026-09-04): the api-proxy helpers
 * moved into packages/api/session-controller (readSessionState at
 * commands.ts:478-485, forkWorkspace at commands.ts:487-500, composeAgent at
 * agent.ts:371-387, the fork handler at commands.ts:185-282). Semantics are
 * unchanged except the 0.1.2-rc.1 session boundary: the live log read is
 * `snapshotEvents()` and the fork lineage fact is `inheritedEventCount`
 * (beside the header, with `isSeeded` marking it) instead of
 * `header.seedLength`. The `agentPreset` projection now owns the
 * preset-resolution half of fork reconstruction.
 *
 * Vendor policy (dsh-session-fork vendor-replication standard): every deviation
 * from upstream carries exactly one marker —
 * - `[fork:adapt]`   mechanical adaptation, no semantic change (injected
 *   dependencies instead of closure capture, structural type slices, type
 *   import paths, plain Result returns instead of RPC envelopes);
 * - `[fork:surgery]` a semantic operation, with its reason inline.
 * `tests/vendor.test.ts` pins the marker counts.
 * @module dsh-session-fork/src/vendor/fork
 */

import type { SourceEvent } from '../branch.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
// Type-only presence import: pulls in this package's Context augmentation
// (`ctx.sessionPersistence`) without any runtime dependency on it.
import type {} from '@deepseek-ai/dsh-session-persistence'
// Same presence pattern for the session-query service (`ctx.sessionQuery`),
// and the projection augmentation that makes `.projections.values.agentPreset`
// typecheck here (mirroring api/session-controller/agent.ts:504-509).
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'

/** Header fields the vendored helpers consume. */
export interface VendoredSourceHeader {
  readonly cwd?: string
  readonly origin?: string
  readonly agentPreset?: string
}

// ---------------------------------------------------------------------------
// composeAgent — packages/host/apiproxy/src/api-proxy.ts:1196-1217
// ---------------------------------------------------------------------------

/** Structural slice of `ctx.get('agentPresets')` relied on. */
export interface AgentPresetsLike {
  resolve(id?: string): Promise<{ id: string }>
  mount(agentCtx: unknown, id?: string): Promise<unknown>
}

/** The composition an `agents.create` call inherits. */
export interface AgentComposition {
  readonly agentPreset?: string
  readonly setup: (agentCtx: unknown) => Promise<void>
}

/** Dependencies `composeAgent` closes over upstream. */
export interface ComposeAgentDeps {
  /** `ctx.get('agentPresets')`, or `undefined` with no preset roster. */
  readonly presets: AgentPresetsLike | undefined
  /** Upstream `installSelection`: composes the default model selection. */
  readonly installSelection: (agentCtx: unknown) => void
}

/**
 * Resolve the preset an agent will be composed from, and the setup that
 * installs it.
 *
 * The id is resolved BEFORE the session exists because the session boundary
 * snapshots `meta` before asynchronous setup begins — a preset discovered
 * during setup could never reach the header. Mounting still happens in
 * setup, where a failure rolls the whole creation back rather than leaving a
 * published session whose capabilities are half-installed.
 *
 * A deployment with no preset roster composes nothing and every session
 * shares the host composition, which is the behavior before presets existed.
 * @param deps - injected closure environment.
 * @param presetId - the requested preset, or `undefined` for the default.
 * @returns the id to record on the header (absent without a roster) and the setup callback.
 * @throws when the roster supplies no such preset.
 */
export async function composeAgent(
  deps: ComposeAgentDeps,
  presetId: string | undefined,
): Promise<AgentComposition> {
  // [fork:adapt] upstream closes over `ctx.get('agentPresets')` and
  // `installSelection`; the vendor copy receives them as dependencies.
  const presets = deps.presets
  if (presets === undefined) {
    return {
      setup: (agentCtx) => {
        deps.installSelection(agentCtx)
        return Promise.resolve()
      },
    }
  }
  const resolvedId = (await presets.resolve(presetId)).id
  return {
    agentPreset: resolvedId,
    setup: async (agentCtx) => {
      deps.installSelection(agentCtx)
      await presets.mount(agentCtx, resolvedId)
    },
  }
}

// ---------------------------------------------------------------------------
// forkWorkspace — packages/host/apiproxy/src/api-proxy.ts:1481-1492
// ---------------------------------------------------------------------------

/** Structural slice of `ctx.get('workspaceRegistry')` workspaces relied on. */
export interface WorkspaceLike {
  readonly id: string
  readonly sessionIds: readonly string[]
  attachSession(sessionId: string): Promise<unknown>
}

/** Structural slice of `ctx.get('sessionQuery')` relied on. */
export interface SessionQueryLike {
  traceSession(sessionId: string): Promise<{ ancestors: ReadonlyArray<{ header: { id: string } }> }>
}

/** Dependencies `forkWorkspace` closes over upstream. */
export interface ForkWorkspaceDeps {
  listWorkspaces(): WorkspaceLike[]
  traceSession(sessionId: string): Promise<{ ancestors: ReadonlyArray<{ header: { id: string } }> }>
}

/**
 * Resolve the Workspace inherited by a fork without making ordinary loose
 * lineage grouped.
 */
// [fork:adapt] upstream reads `ctx.workspaceRegistry.list()` /
// `ctx.sessionQuery.traceSession()`; the vendor copy receives a structural
// `deps` slice, and the source is the vendor header shape instead of
// `Pick<Session, 'id' | 'header'>`.
export async function forkWorkspace(
  deps: ForkWorkspaceDeps,
  source: { id: string; header: VendoredSourceHeader },
): Promise<WorkspaceLike | undefined> {
  const workspaces = deps.listWorkspaces()
  const direct = workspaces.find(workspace => workspace.sessionIds.includes(source.id))
  if (direct !== undefined || source.header.origin !== 'subagent') return direct

  const lineage = await deps.traceSession(source.id)
  for (const ancestor of lineage.ancestors) {
    const workspace = workspaces.find(candidate =>
      candidate.sessionIds.includes(ancestor.header.id),
    )
    if (workspace !== undefined) return workspace
  }
  return undefined
}

// ---------------------------------------------------------------------------
// anchoredBoundary + cut extension — packages/host/apiproxy/src/api-proxy.ts:2318-2344
// (the inlined boundary half of the session.fork handler)
// ---------------------------------------------------------------------------

/** Result of {@link anchoredBoundaryOf}: the anchoring turn end and the seed cut. */
export interface AnchoredBoundary {
  /** Seq of the anchoring `turn/end` event. */
  readonly boundarySeq: number
  /** Exclusive end of the seed slice (index into the event array). */
  readonly cut: number
}

/**
 * Locate the fork boundary and seed cut in a source log, replicating the
 * api-proxy `session.fork` anchor semantics:
 *
 * - With `atSeq`: the first `turn/end` at or after that seq (an in-log
 *   anchor belongs to its whole turn). `null` means the containing turn has
 *   not completed yet.
 * - Without `atSeq` (or past the last event): the last completed `turn/end`;
 *   `null` means the session has no completed turn to fork from.
 *
 * The returned `cut` additionally extends through trailing standalone events
 * (`session/title`, injections) up to the next `turn/start`, so the seed
 * stays balanced.
 *
 * @returns `null` when no completed turn anchors the fork.
 */
export function anchoredBoundaryOf(
  events: readonly SourceEvent[],
  atSeq?: number,
): AnchoredBoundary | null {
  // An in-log anchor belongs to the turn containing it and must never clip
  // backward to an earlier completed turn. Omitted and past-end anchors
  // retain the last-completed-turn shortcut.
  const lastSeq = events.at(-1)?.seq ?? -1
  const anchoredBoundary = atSeq === undefined
    ? undefined
    : events.find(e => e.type === 'turn/end' && e.seq >= atSeq)
  const boundary = anchoredBoundary
    ?? (atSeq === undefined || atSeq > lastSeq
      ? events.findLast(e => e.type === 'turn/end')
      : undefined)
  if (boundary === undefined) return null
  // Extend the cut through trailing out-of-band appends (session/title,
  // injections) up to the next turn/start: they are standalone events, so
  // the seed stays balanced, and the child inherits a title generated right
  // after the boundary turn.
  let cut = boundary.seq + 1
  while (cut < events.length && events[cut]?.type !== 'turn/start') cut++
  // [fork:surgery] seed-balance invariant. Upstream the fork handler runs
  // between turns (web GUI button, RPC from an idle client), so any
  // `command/run` in the sliced log already has its `command/done`. Our
  // entry point runs INSIDE a command handler: the host appends
  // `command/run` before invoking the handler and `command/done` only after
  // it returns, so at slicing time the tail legitimately contains an
  // unpaired `command/run`. Seeding it would give the child an orphan run,
  // which the client renders as a command still executing forever (a run
  // without done is "in flight" in conversation rendering). Therefore: if
  // the seed slice contains a `command/run` whose `commandId` has no
  // matching `command/done`, back the cut up to before the earliest such
  // orphan. (Orphans can only trail the anchoring turn/end — a completed
  // turn pairs all runs inside it — so in practice this trims the tail
  // extension, never completed turns.)
  //
  // Pairing is one single-pass sweep, parenthesis-matching per commandId:
  // each `command/run` opens a slot for its id (count +1), each
  // `command/done` closes the most recent open slot (count −1; a done with
  // no open slot is ignored, so counts never go negative). `firstOpenAt`
  // remembers where each id opened its earliest unmatched run. After the
  // sweep a non-empty `openRuns` means orphan runs exist, and the cut backs
  // up to before the earliest of them. Interleaved commands pair by id
  // (runA runB doneA doneB is fully balanced; runA runB doneB leaves runA
  // orphaned at its own index), which a whole-slice done-id set could not
  // express.
  const openRuns = new Map<string, number>()
  const firstOpenAt = new Map<string, number>()
  for (let index = 0; index < cut; index += 1) {
    const event = events[index]
    const commandId = (event?.data as { commandId?: string } | undefined)?.commandId
    if (commandId === undefined || event === undefined) continue
    if (event.type === 'command/run') {
      if (!openRuns.has(commandId)) firstOpenAt.set(commandId, index)
      openRuns.set(commandId, (openRuns.get(commandId) ?? 0) + 1)
    } else if (event.type === 'command/done') {
      const remaining = (openRuns.get(commandId) ?? 0) - 1
      if (remaining > 0) {
        openRuns.set(commandId, remaining)
      } else {
        openRuns.delete(commandId)
        firstOpenAt.delete(commandId)
      }
    }
  }
  let earliestOrphan = Infinity
  for (const index of firstOpenAt.values()) earliestOrphan = Math.min(earliestOrphan, index)
  if (Number.isFinite(earliestOrphan)) cut = earliestOrphan
  return { boundarySeq: boundary.seq, cut }
}

// ---------------------------------------------------------------------------
// getOrResumeAgent — the api-proxy ensureSession kernel
//
// VENDORED FROM: deepseek-harness@528c682e061696f5a160f363f236ecbf53cbd006
// (copied 2026-08-21)
//
// - packages/host/apiproxy/src/api-proxy.ts:1078 — the `sessionCreations`
//   memo: client-chosen identity creation/resume, deduplicated across
//   concurrent retries.
// - packages/host/apiproxy/src/api-proxy.ts:1569-1659 — `ensureSession`:
//   live-first lookup, full-composition persisted resume, and the
//   concurrent-publication recovery catch.
//
// The three helpers above were vendored while this checkout sat at 99f6f02f
// and keep that historical citation; this kernel was copied after the
// checkout advanced to 528c682e, which shifted api-proxy line numbers
// without changing ensureSession's semantics.
// ---------------------------------------------------------------------------

/** Live-first session state the resume kernel needs (header + event log + fork cut + resolved preset). */
export interface ReadSessionState {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
  /** Leading events inherited from the fork parent (0.1.2-rc.1 session boundary). */
  readonly inheritedEventCount: number
  /**
   * The preset the source actually runs under, resolved from the agentPreset
   * projection at read time (the dsh 0.1.2-rc.1 canonical path — the same
   * `presetForObservation(observation)` upstream applies). `undefined`
   * when the deployment composes none.
   */
  readonly agentPreset?: string
}

/** What the kernel contributes to a resume: the identity and the composed setup. */
export interface ResumeRequest {
  readonly resumeSessionId: Session['id']
  readonly setup: (agentCtx: unknown) => Promise<void>
}

// [fork:adapt] injection seam. Upstream ensureSession closes over the
// api-proxy constructor's ctx services (sessions / agents /
// sessionPersistence / agentPresets / agentDefaultModel) and over the
// closure-level `sessionCreations` memo; the vendor copy receives an
// injectable deps object instead, and keeps one creation memo per deps
// instance — a module-level WeakMap with the same lifetime semantics as the
// upstream closure (one entry per production wiring, isolated per injected
// test deps).
export interface GetOrResumeDeps {
  /** `ctx.agents.get` — the live-agent lookup. */
  get(sessionId: Session['id']): Agent | undefined
  /** `ctx.agents.resume` with the caller's default model selection pre-bound. */
  resume(request: ResumeRequest): Promise<{ agent: Agent }>
  /** Live-first state read (`ctx.sessions.get`, else persistence inspect); `null` = not found. */
  readState(sessionId: Session['id']): Promise<ReadSessionState | null>
  /** The stored preset's composition via the vendored {@link composeAgent}. */
  composeSetup(presetId: string | undefined): Promise<AgentComposition>
}

/** One session-creation memo per injected deps instance (see the [fork:adapt] note above). */
const creationsByDeps = new WeakMap<GetOrResumeDeps, Map<Session['id'], Promise<Agent>>>()

/** Structural slice of `ctx.get('agentDefaultModel')` relied on. */
export interface AgentDefaultModelLike {
  currentSelection(): { provider: string; model: string }
}

/**
 * Get the live agent for a session id, or cold-resume it from its persisted
 * log — the parent-side write entry for /squash.
 *
 * Mirrors the api-proxy ensureSession kernel: live lookup first, then one
 * memoized full-composition resume shared by concurrent callers, with a
 * recovery catch that returns an agent published by a competing path
 * instead of surfacing the registry's `already registered`.
 * @param deps - injected session/agent capabilities (default wiring: {@link getOrResumeDeps}).
 * @param sessionId - the persisted session to obtain a live agent for.
 * @returns the live agent.
 * @throws when the session does not exist — this kernel never creates one.
 */
export async function getOrResumeAgent(
  deps: GetOrResumeDeps,
  sessionId: Session['id'],
): Promise<Agent> {
  const creations = creationsByDeps.get(deps) ?? (() => {
    const fresh = new Map<Session['id'], Promise<Agent>>()
    creationsByDeps.set(deps, fresh)
    return fresh
  })()
  let creation = creations.get(sessionId)
  if (creation === undefined) {
    creation = (async () => {
      // [fork:adapt] web RPC admission logic deliberately not vendored: the
      // subagent-ownership checks, the cwd-conflict validation, the
      // preset-unchanged assertions, and the whole post-await guard block
      // are request-entry guards for the remote session wire; an
      // in-process caller has already resolved the workspace scope, and the
      // parent is resumed exactly as its log records, so none of them
      // applies.
      const live = deps.get(sessionId)
      if (live !== undefined) return live
      const stored = await deps.readState(sessionId)
      // [fork:surgery] create branch deleted. Upstream ensureSession falls
      // through to mkdir + ctx.agents.create when nothing persists; a squash
      // parent must ALREADY exist — fabricating a fresh session would
      // silently write the conclusion into a brand-new empty branch instead
      // of the real parent — so the vendor copy throws when readState
      // reports the session missing, and there is no create path at all.
      if (stored === null) {
        throw new Error(
          `getOrResumeAgent: session "${sessionId}" not found — a squash parent must already exist`,
        )
      }
      const storedPreset = stored.agentPreset
      return (await deps.resume({
        resumeSessionId: sessionId,
        setup: (await deps.composeSetup(storedPreset)).setup,
      })).agent
    })().catch((error: unknown) => {
      // Another Host entry path may have published the same identity while
      // this operation crossed an asynchronous persistence step.
      const live = deps.get(sessionId)
      if (live !== undefined) return live
      throw error
    }).finally(() => {
      creations.delete(sessionId)
    })
    creations.set(sessionId, creation)
  }
  return await creation
}

/**
 * Default production wiring for {@link getOrResumeAgent}: the api-proxy
 * closures the vendored kernel captures upstream, rebuilt over one cordis
 * context. `resume` pre-binds the host default model selection as
 * agentOptions, `readState` reads live-first via the session-query
 * observation (matching api/session-controller/agent.ts:422-457 — one
 * read carries header, fork cut, frozen events, and the resolved
 * agentPreset projection), and `composeSetup` resolves the recorded
 * preset through the vendored composeAgent.
 * @param ctx - host context providing agents/sessionQuery/agentPresets/agentDefaultModel.
 * @returns deps bound to the context services.
 */
export function getOrResumeDeps(ctx: Context): GetOrResumeDeps {
  const presets = ctx.get('agentPresets') as AgentPresetsLike | undefined
  const sessionQuery = ctx.get('sessionQuery') as { observeSession(sessionId: Session['id']): Promise<SessionObservation> } | undefined
  return {
    get: sessionId => ctx.agents.get(sessionId),
    resume: async (request) => {
      const defaultModel = ctx.get('agentDefaultModel') as AgentDefaultModelLike | undefined
      return ctx.agents.resume({
        resumeSessionId: request.resumeSessionId,
        ...(defaultModel === undefined ? {} : { agentOptions: defaultModel.currentSelection() }),
        setup: request.setup,
      })
    },
    readState: async (sessionId) => {
      // [fork:adapt] mirrors agent.ts:resumeObserved (commands.ts:244 for the
      // fork path). One observation covers live-first lookup, the fork cut,
      // and the preset projection — the previous live/inspect split is gone.
      // `null` propagates to the kernel's "not found" throw.
      let observation: SessionObservation | undefined
      try {
        try {
          observation = await sessionQuery!.observeSession(sessionId)
        } catch (error) {
          if (error instanceof SessionQueryError
            && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return null
          return null
        }
        return {
          header: observation.header,
          events: observation.events,
          inheritedEventCount: observation.inheritedEventCount,
          agentPreset: observation.projections?.values.agentPreset ?? observation.header.agentPreset,
        }
      } finally {
        observation?.[Symbol.dispose]()
      }
    },
    composeSetup: (presetId) => composeAgent(
      {
        presets,
        // The plugin seeds the default model through the resume call's
        // agentOptions (the same pattern as the /branch fork path), so the
        // vendored composeAgent receives a no-op installer here.
        installSelection: () => { },
      },
      presetId,
    ),
  }
}
