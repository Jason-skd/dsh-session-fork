/**
 * Pure squash logic: region selection, checkpoint extraction, merge
 * provenance, and error mapping. No cordis, no I/O — every dsh touchpoint is
 * a plain typed parameter, so each function is unit-testable with fake
 * session objects.
 *
 * The region-boundary wording mirrors the vendored
 * `validateSurfaceRegion` diagnostics (deepseek-harness
 * compaction-basic/src/region.ts:314-336) so a squash failure reads exactly
 * like the official compaction seam's; the user-facing error mapping mirrors
 * command-compact/src/index.ts:23-55.
 * @module dsh-session-fork/src/squash
 */

import {
  CompactionId,
  compactCheckpointSource,
  isCompactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import type { ManualCompactionErrorCode } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { SessionSeq as sessionSeq } from '@deepseek-ai/dsh-session'
import { branchEnvelopeText } from './branch-events.js'

/** Typed failure codes of the pure squash logic. */
export type SquashCoreErrorCode =
  | 'missing-seed-boundary'
  | 'empty-fork-range'
  | 'unbalanced-range'
  | 'checkpoint-not-found'

/** Typed failure of the pure squash logic; the command layer maps codes to user text. */
export class SquashCoreError extends Error {
  /** Machine-readable failure code. */
  readonly code: SquashCoreErrorCode

  constructor(code: SquashCoreErrorCode, message: string) {
    super(message)
    this.name = 'SquashCoreError'
    this.code = code
  }
}

/**
 * The inclusive post-fork compaction region, named by surface position:
 * every surface node whose log seq is after the child's seed boundary.
 */
export interface PostForkRange {
  /** Inclusive first surface-node seq of the region. */
  readonly start: SessionSeq
  /** Inclusive last surface-node seq of the region. */
  readonly end: SessionSeq
}

/** Options for {@link postForkRange}. */
export interface PostForkRangeOptions {
  /**
   * Skip the boundary-pairing gates (default: enforced). The gates are
   * TIME-SENSITIVE: while the source agent is running, its own surface tail
   * sits inside the open step — the initiating squash call itself keeps
   * the step open — so the region end can never balance at dispatch time
   * (go-ce-v3 evidence: `squash_into` on a running self was refused with
   * "region end … the step is still open" before the handoff could start).
   * The mid-turn dispatch computes its region with `balance: false`; the
   * executor re-validates on the post-cancellation idle surface, where the
   * cancelled turn's official `turn/end` closes the step.
   */
  readonly balance?: boolean
}

/**
 * Select the child's post-fork region — the surface tail after the
 * session's fork construction boundary — and pre-validate both edges as
 * balanced tool-pairing boundaries.
 *
 * The boundary is NOT "the last `session/end-seed`": upstream appends that
 * marker on EVERY seeded construction — fork AND cold resume (harness
 * session/src/index.ts:543-546; "a cold session is resumed on first
 * touch"). A tail scan lands on the resume marker the host writes moments
 * before `/squash` itself runs on a cold branch, making the post-boundary
 * surface empty (`empty-fork-range`), or — for a mid-history resume —
 * silently truncating the region to the post-resume tail. The anchor is
 * `session.inheritedEventCount` (with `header.isSeeded` as the marker), the
 * durable fork-lineage boundary: markers below it
 * were inherited with the seed, and the construction marker is the first
 * end-seed at/after it. One absorbed case exists: a seed slice that
 * already ends with an end-seed is not re-marked, so the trailing marker
 * at `events[inheritedEventCount - 1]` IS the boundary. (Index addressing
 * is exact: the kernel log is contiguous — `append` assigns `seq:
 * log.length` and the constructor rejects non-contiguous seeds — so array
 * position and seq coincide; only the JSONL storage projection coalesces
 * chunk runs.)
 *
 * @param session - the child session being squashed.
 * @param options - `balance: false` skips the time-sensitive pairing gates.
 * @returns the inclusive region by surface position.
 * @throws {@link SquashCoreError} `missing-seed-boundary` (root session —
 * no fork lineage — or no construction marker), `empty-fork-range`
 * (nothing after the boundary), or `unbalanced-range` (an edge would
 * split a tool-call/result pair).
 */
export function postForkRange(
  session: Session,
  options?: PostForkRangeOptions,
): PostForkRange {
  const lineage = session.inheritedEventCount
  if (lineage === 0 && !session.header.isSeeded) {
    throw new SquashCoreError(
      'missing-seed-boundary',
      'squash: the session has no seed boundary — only a forked child can be squashed',
    )
  }
  // The absorbed trailing seed marker: the constructor found the seed
  // already ending with one and skipped re-marking, so no construction
  // marker exists — any later end-seed is a cold-resume marker of this
  // session and must not win over the seed's own trailing edge.
  const absorbed = lineage > 0 ? session.eventAt(sessionSeq(lineage - 1)) : undefined
  let endSeed: number | undefined
  if (absorbed !== undefined && absorbed.type === 'session/end-seed') {
    endSeed = absorbed.seq
  } else {
    for (let index: number = lineage; index < session.seq; index += 1) {
      const event = session.eventAt(sessionSeq(index))
      if (event !== undefined && event.type === 'session/end-seed') {
        endSeed = event.seq
        break
      }
    }
  }
  if (endSeed === undefined) {
    throw new SquashCoreError(
      'missing-seed-boundary',
      'squash: the session has no seed boundary — only a forked child can be squashed',
    )
  }
  const postFork = session.surface.nodes.filter(seq => seq > endSeed)
  const start = postFork[0]
  const end = postFork.at(-1)
  if (start === undefined || end === undefined) {
    throw new SquashCoreError(
      'empty-fork-range',
      'squash: the child has no post-fork surface region to compact',
    )
  }
  if (options?.balance !== false && !toolPairingBalancedBefore(session, start)) {
    throw new SquashCoreError(
      'unbalanced-range',
      `squash: region start seq ${start} is not a balanced boundary (would split a step's tool-call/result pair)`,
    )
  }
  if (options?.balance !== false && !toolPairingBalancedAfter(session, end)) {
    throw new SquashCoreError(
      'unbalanced-range',
      `squash: region end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`,
    )
  }
  return { start, end }
}

/**
 * Extract the compaction checkpoint message from a just-compacted child
 * surface: the last surface `user/message` node whose source satisfies
 * `isCompactCheckpointSource`.
 * @param session - the child session, compacted moments before this call.
 * @returns the checkpoint user message, content and source intact.
 * @throws {@link SquashCoreError} `checkpoint-not-found` when the surface
 * carries no compaction checkpoint.
 */
export function extractCheckpointMessage(session: Session): UserMessage {
  // Scan from the surface tail: the squash compaction just landed one
  // checkpoint node, so the newest match is the right one — a stale
  // checkpoint in the inherited prefix must never win.
  for (let index = session.surface.nodes.length - 1; index >= 0; index -= 1) {
    const seq = session.surface.nodes[index]!
    const event = session.eventAt(seq)
    if (event === undefined || event.type !== 'user/message') continue
    const message = session.deriveEventMessage(event)
    if (message !== null && message.role === 'user' && isCompactCheckpointSource(message.source)) {
      // A user/message node derives to a user-role message; the role guard
      // above is the runtime proof, so the cast only pins the subtype.
      return message as UserMessage
    }
  }
  throw new SquashCoreError(
    'checkpoint-not-found',
    'squash: the child surface has no compaction checkpoint — squash requires a completed compaction',
  )
}

/**
 * Merge provenance recorded on the target-appended checkpoint's source.
 *
 * Note: `atSeq` (the fork anchor in the target's log) was removed in the
 * issue #21 refactor. Under the new "any two registered branches" semantics
 * a single seq number can no longer point at a turn: for non-direct-parent
 * targets the relevant boundary is the leaving fork edge of a third
 * ancestor, not a seq in the target log. AI never read the field and no
 * in-tree consumer depended on it, so it is gone rather than refilled.
 *
 * Note: `childSessionId`, `shadowedRange`, and `shadowedSeqs` were removed
 * in the 2026-09-05 source re-baseline. They had zero readers, and carrying
 * them on the source violated the frozen plugin-source vocabulary (unknown
 * members make a session log refuse to load under the format read path).
 * The shadowed coordinates belong to the CHILD's log — the child's own
 * `compaction/summary` event keeps them durably in the right coordinate
 * space — and the merge edge is recovered from the envelope preamble.
 */
export interface MergeProvenance {
  /**
   * The compacted region in TURN coordinates, for the model-facing envelope
   * preamble (`covering its turns A–B`). Surface-seq coordinates must never
   * reach the preamble — the two coordinate systems diverge whenever
   * non-surface events (chunks, boundaries) sit inside the region. Absent
   * when no shadowed event carries a turn number.
   */
  readonly turnRange?: { readonly start: number; readonly end: number }
  /** The child compaction's durable transaction identity. */
  readonly compactionId: CompactionId
  /** The /squash command that initiated the compaction, when present. */
  readonly sourceCommandId?: CommandId
}

/**
 * Registry-resolved branch names for the merge envelope, resolved by the
 * command layer BEFORE building (names are point-in-time facts, exactly like
 * commit messages).
 */
export interface MergeBranchNames {
  /** Name of the child branch being squashed (the `from` of the event). */
  readonly child: string
  /** Name of the target branch the checkpoint is merged into (the `to`). */
  readonly target: string
}

/**
 * Derive the inclusive turn range covered by shadowed surface nodes: the min
 * and max `turn` over the events that carry one (`assistant/message`,
 * `tool/result`; `user/message` data is the message itself and has no turn
 * field). Used to state the squash region in the model-facing preamble in
 * turn coordinates rather than surface seqs.
 * @param session - the child session that owns the shadowed seqs.
 * @param seqs - shadowed surface-node seqs, in any order.
 * @returns the inclusive turn range, or undefined when no seq carries a turn.
 */
export function turnRangeOf(
  session: Session,
  seqs: readonly SessionSeq[],
): { readonly start: number; readonly end: number } | undefined {
  let start = Infinity
  let end = -Infinity
  for (const seq of seqs) {
    const data = session.eventAt(seq)?.data as { turn?: unknown } | undefined
    if (typeof data?.turn === 'number') {
      start = Math.min(start, data.turn)
      end = Math.max(end, data.turn)
    }
  }
  return start === Infinity ? undefined : { start, end }
}

/**
 * Build the message appended into the parent branch: the child checkpoint's
 * payload (the conclusion itself, tags and all — nested `<compacted-summary>`
 * tags inside `<branch-squash>` are honest about the material's origin)
 * wrapped in the shared branch-event envelope, with the official compaction
 * checkpoint identity riding the source.
 *
 * The source comes from the official correlated checkpoint constructor,
 * keeping the merged node recognizable by every compaction consumer. The
 * fork-merge facts ride the preamble text.
 * @param checkpointMessage - the child's checkpoint message from {@link extractCheckpointMessage}.
 * @param provenance - compaction facts to record on the source.
 * @param branchNames - registry-resolved child and target branch names.
 * @returns the parent-ready user message.
 */
export function buildMergeCheckpoint(
  checkpointMessage: UserMessage,
  provenance: MergeProvenance,
  branchNames: MergeBranchNames,
): UserMessage {
  const payload = checkpointMessage.content
    .map(block => block.type === 'text' ? block.text : `(opaque ${block.type} block)`)
    .join('\n')
  return createUserMessage({
    content: [{
      type: 'text',
      text: branchEnvelopeText(
        {
          kind: 'squash',
          from: branchNames.child,
          to: branchNames.target,
          ...provenance.turnRange === undefined ? {} : { range: { ...provenance.turnRange } },
        },
        payload,
      ),
    }],
    source: compactCheckpointSource(provenance.compactionId, provenance.sourceCommandId),
  })
}

/** Fail loudly if a locally closed union gains an unhandled member. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(value: never): never {
  throw new TypeError(`unknown manual compaction error code: ${String(value)}`)
}
/* v8 ignore stop */

/**
 * Convert one expected manual-compaction failure class into concise,
 * human-only squash wording. Mirrors the official `/compact` command's
 * phrasing (command-compact/src/index.ts:23-55) with the squash subject.
 * @param code - the stable ManualCompactionError failure class.
 * @returns the user-facing error text.
 */
export function squashErrorText(code: ManualCompactionErrorCode): string {
  switch (code) {
    case 'busy':
      return 'Squash is unavailable because this process has an active compaction, or the agent is not idle.'
    case 'cancelled':
      return 'Squash cancelled.'
    case 'changed':
      return 'The history selected for squash changed before it could be replaced. The conversation is unchanged; the attempt is recorded in the session log.'
    case 'summary':
      // TODO(v0.1.x): surface the error.message hint here instead of the
      // generic wording — a summary that would not shrink should suggest
      // rebased-into mode.
      return 'Squash could not produce a useful summary. The conversation is unchanged; the attempt is recorded in the session log.'
    case 'commit':
      return 'Squash did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.'
    case 'persistence':
      return 'Squash finished, but the session could not be saved.'
    /* v8 ignore next 2 -- ManualCompactionErrorCode is closed and every member is handled above */
    default:
      return assertNever(code)
  }
}
