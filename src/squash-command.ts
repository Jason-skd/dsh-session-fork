/**
 * `/squash` command: argument parsing and the execution pipeline that runs
 * the vendored compaction engine over the source branch's transfer region
 * (decided by the shared merge-region authority, issue #21: any two
 * registered branches) and queues the merge checkpoint into the target
 * branch via `agent.inject`. Pure and cordis-free, mirroring command.ts: the
 * plugin shell in index.ts feeds a parsed action plus
 * {@link SquashCommandDeps}; everything here is unit-testable with fake agents.
 * @module dsh-session-fork/src/squash-command
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { Session } from '@deepseek-ai/dsh-session'
import type { BranchCommandResult } from './command.js'
import { getBranch, loadRegistry } from './registry.js'
import { mergeRegion } from './merge-region.js'
import type { MergeRegionResult } from './merge-region.js'
import {
  buildMergeCheckpoint,
  extractCheckpointMessage,
  squashErrorText,
  SquashCoreError,
} from './squash.js'
import { turnRangeOf } from './squash.js'
import type { MergeProvenance } from './squash.js'
import type { RegistryStore, RegistryState } from './types.js'
import type { CompactRegionRequest } from './vendor/compact.js'

export const SQUASH_USAGE = [
  'Usage:',
  '  /squash into <branch>   squash this branch back into <branch> as one summary',
].join('\n')

/** One parsed `/squash` invocation. */
export type SquashAction =
  | { readonly kind: 'squash'; readonly target: string }
  | { readonly kind: 'usage'; readonly problem: string }

/**
 * Parse the text after `/squash`. Never throws; anything but
 * `into <branch>` becomes a `usage` action that renders {@link SQUASH_USAGE}.
 */
export function parseSquashAction(rawInput: string): SquashAction {
  const tokens = rawInput.trim().split(/\s+/).filter(t => t.length > 0)
  const [head, second] = tokens as [string | undefined, string | undefined]
  if (head === undefined) return { kind: 'usage', problem: 'missing target branch' }
  if (head !== 'into') {
    return { kind: 'usage', problem: `expected 'into <branch>', got '${head}'` }
  }
  if (second === undefined) return { kind: 'usage', problem: `'into' needs a branch name` }
  if (tokens.length > 2) return { kind: 'usage', problem: `'into' takes exactly one branch name` }
  return { kind: 'squash', target: second }
}

/** The public Agent surface used by squash. */
export type SquashChildAgent = Agent

/** Capabilities one `/squash` execution needs. */
export interface SquashCommandDeps {
  /** The child agent this command runs against (idle, per the command contract). */
  readonly childAgent: SquashChildAgent
  /** Cancellation signal owned by the dispatching UI request. */
  readonly signal: AbortSignal
  /** This command's identity, recorded in the merge provenance. */
  readonly commandId?: CommandId
  /** Per-workspace registry persistence. */
  readonly store: RegistryStore
  /** The vendored compaction shell (runMaintenance inside; see vendor/compact.ts). */
  readonly compact: (
    agent: Agent,
    signal: AbortSignal,
    request: CompactRegionRequest,
  ) => Promise<CompactionResult>
  /** Target-side agent resolution (vendored ensureSession kernel: resume, never create). */
  readonly resolveTargetAgent: (sessionId: string) => Promise<Agent>
  /** Durability checkpoint for one agent's session (`ctx.sessions.flush`). */
  readonly flush: (agent: Agent) => Promise<unknown>
}

/** Render one unknown-target registry failure. */
function unknownBranch(name: string): string {
  return `no branch named '${name}' in this workspace`
}

/**
 * Execute one parsed `/squash` action. All failures return `kind: 'error'`
 * results — a command must never crash the host.
 */
export async function executeSquashAction(
  action: SquashAction,
  deps: SquashCommandDeps,
): Promise<BranchCommandResult> {
  if (action.kind === 'usage') {
    return { kind: 'error', text: `${action.problem}\n${SQUASH_USAGE}` }
  }
  return executeSquash(action.target, deps)
}

/**
 * Everything `/squash` can reject on before compaction begins: target
 * existence, self-squash, the source's own registration, and the merge
 * region. Extracted (behavior-identical) from {@link executeSquash} so the
 * mid-turn handoff (src/squash-midturn.ts) can run the same checks BEFORE
 * ending the source's running turn — a bad target must not cost the turn.
 * The failing shape carries the user-facing `text`; the ok shape carries
 * the resolved target session id, the source branch's registry name, and
 * the decided merge region.
 *
 * `options.balance: false` skips the region's boundary-pairing gates:
 * they are time-sensitive (a running source's own dispatching call keeps
 * the surface's final step open), so the mid-turn dispatch cannot judge
 * execution-time balance — the executor re-validates on the
 * post-cancellation idle surface.
 */
export type SquashPrecheck =
  | { readonly ok: false; readonly text: string }
  | {
    readonly ok: true
    readonly targetSessionId: string
    readonly childName: string
    readonly region: Exclude<MergeRegionResult, { kind: 'error' }>
  }

/** Run the pre-compaction rejection checks (see {@link SquashPrecheck}). */
export function precheckSquash(
  state: RegistryState,
  childSession: Session,
  target: string,
  options?: { readonly balance?: boolean },
): SquashPrecheck {
  let targetSessionId: string
  try {
    targetSessionId = getBranch(state, target).sessionId
  } catch {
    return { ok: false, text: unknownBranch(target) }
  }
  if (targetSessionId === childSession.id) {
    return { ok: false, text: 'cannot squash a branch into itself' }
  }

  // Branch names are point-in-time facts: resolve them from the registry now,
  // before building the merge envelope. The target is the registry key the
  // user named; the source must be a registered branch to be named in the
  // AI-visible provenance.
  const childRecord = Object.values(state.branches)
    .find(record => record.sessionId === childSession.id)
  const childName = childRecord?.name
  if (childName === undefined) {
    return {
      ok: false,
      text: 'cannot resolve this session\'s branch name — register the branch before squashing',
    }
  }

  const region = mergeRegion(state, childSession, targetSessionId, options)
  if (region.kind === 'error') {
    return { ok: false, text: region.message.replace(/^(?:squash|merge-region):/, 'squash:') }
  }
  return { ok: true, targetSessionId, childName, region }
}

/**
 * The squash pipeline proper (issue #8: extracted so the RPC `squash`
 * endpoint reuses the exact command semantics; issue #21: any two
 * registered branches): idle gate, registry target check, merge-region
 * decision (the shared lineage authority), vendored compaction, merge
 * checkpoint queue delivery into the target, durability flush. Pure over
 * the injected agents and capabilities — never throws business failures.
 */
export async function executeSquash(
  target: string,
  deps: SquashCommandDeps,
): Promise<BranchCommandResult> {
  // Idle gate: the vendored shell re-checks through runMaintenance, but a
  // fast local check gives the squash-specific wording immediately. (The
  // mid-turn handoff in src/squash-midturn.ts routes running sources here
  // only once they reach idle.)
  if (deps.childAgent.status !== 'idle') {
    return { kind: 'error', text: squashErrorText('busy') }
  }

  // Lineage (issue #21): squash runs between any two registered branches.
  // The merge-region authority decides which part of this branch transfers —
  // the direct-parent case still lands exactly on the seed boundary (old
  // postForkRange behavior, delegated inside mergeRegion).
  const childSession = deps.childAgent.session as Session

  const state = await loadRegistry(deps.store)
  const precheck = precheckSquash(state, childSession, target)
  if (!precheck.ok) {
    return { kind: 'error', text: precheck.text }
  }
  const { targetSessionId, childName, region } = precheck

  let result: CompactionResult
  try {
    result = await deps.compact(deps.childAgent, deps.signal, {
      start: region.start,
      end: region.end,
      flush: async () => { await deps.flush(deps.childAgent) },
      ...deps.commandId === undefined ? {} : { sourceCommandId: deps.commandId },
    })
  } catch (error) {
    if (error instanceof ManualCompactionError) {
      return { kind: 'error', text: squashErrorText(error.code) }
    }
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }

  let mergeMessage
  const provenance: MergeProvenance = {
    turnRange: turnRangeOf(childSession, result.shadowedSeqs),
    compactionId: result.compactionId,
    ...deps.commandId === undefined ? {} : { sourceCommandId: deps.commandId },
  }
  try {
    mergeMessage = buildMergeCheckpoint(
      extractCheckpointMessage(childSession),
      provenance,
      { child: childName, target },
    )
  } catch (error) {
    if (error instanceof SquashCoreError) return { kind: 'error', text: error.message }
    throw error
  }

  let targetAgent: Agent
  try {
    targetAgent = await deps.resolveTargetAgent(targetSessionId)
  } catch (error) {
    return {
      kind: 'error',
      text: `could not open the target branch's session: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // Queue delivery (issue #27): `inject` parks the envelope in the target's
  // inbox for the next pre-step without waking the driver — the same public
  // path other plugins use (agent-teams rides steer/followup on this very
  // interface). Squash takes no responsibility for target busyness: a busy
  // target claims the message at its next step boundary, an idle one at its
  // next wake. The inbox splice is a durable session event, hence the flush.
  targetAgent.inject(mergeMessage)
  await deps.flush(targetAgent)

  return {
    kind: 'success',
    text: `Squashed ${result.shadowedSeqs.length} surface nodes (~${result.shadowedTokenCount} tokens) into branch '${target}' as one checkpoint.`,
  }
}
