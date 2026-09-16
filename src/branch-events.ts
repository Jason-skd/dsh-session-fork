/**
 * Branch event envelopes: the single, shared way every branch operation
 * (fork, squash, rebased-into, adopt, rename, message) renders an AI-visible
 * provenance message.
 *
 * Design contract (agreed 2026-08-22; source shape re-baselined 2026-09-05):
 *
 * - Every branch event is ONE `user/message`. The message `source` carries
 *   ONLY members of the frozen session-format plugin-source vocabulary —
 *   `kind`, `plugin`, `form`, `summary` (plus `compactionId`/
 *   `sourceCommandId` under `plugin: 'compact'`; deepseek-harness
 *   session-format-v0-to-v1/src/payload-validation.ts `pluginSourceValue`).
 *   The format's read path rejects unknown source members and thereby makes
 *   the whole session log unloadable, so structured provenance must NOT
 *   ride the source (2026-09-05 incident: `branchEvent` poisoned 66 logs).
 * - The `content` text is ALWAYS self-describing — and for the transfer
 *   kinds (squash, rebased-into) the preamble additionally is the MACHINE
 *   contract: {@link parseTransferPreamble} recovers `{kind, fromName}`
 *   from it, which is how the branch graph (src/graph.ts) recognizes
 *   transfer rows without any source extensions.
 * - Two shapes exist:
 *   - `buildBranchNotice` — a one-line account of something that happened
 *     (fork notifications both directions, adopt, rename). No payload, no tags.
 *   - `buildBranchEnvelope` — an English preamble plus an XML-style
 *     `<branch-<kind>>` tag pair wrapping a payload (squash summary, rebased-into
 *     transcript pages), mirroring the official compaction checkpoint shape
 *     (compaction-basic/src/summarizer.ts: `CHECKPOINT_PREAMBLE` +
 *     `<compacted-summary>` tags). The tags delimit material that
 *     ORIGINATED ON ANOTHER BRANCH, for the model and the human reader alike.
 * - This module owns the wording; the delivery workstreams own the transport
 *   (seed embedding, inbox injection, maintenance-window append). Keeping
 *   the text here keeps the branches merge-conflict-free.
 * Pure text construction, no cordis, no I/O — unit-testable with plain
 * assertions, mirroring the purity discipline of `squash.ts`.
 * @module dsh-session-fork/src/branch-events
 */

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** The branch operations that emit AI-visible provenance messages. */
export type BranchEventKind = 'fork' | 'squash' | 'rebased-into' | 'adopt' | 'rename' | 'message'

/**
 * The facts a branch event states. Every field names durable truth at write
 * time — the builders render them verbatim, so callers must resolve branch
 * names from the registry BEFORE building (names are point-in-time, exactly
 * like commit messages).
 */
export interface BranchEventFacts {
  /** Which operation this event records. */
  readonly kind: BranchEventKind
  /**
   * Name of the branch the event came FROM: the parent for fork, the child
   * for squash/rebased-into, the OLD name for rename, and the adopted
   * session's id for adopt (it had no branch name until this event).
   */
  readonly from: string
  /** Name of the branch this message is written INTO (the NEW name for rename). */
  readonly to: string
  /** Fork point: the parent's turn number at which `from` diverged. Present on every event once known. */
  readonly atTurn?: number
  /** The child-side turn range this event covers (squash region, rebased-into graft). */
  readonly range?: { readonly start: number; readonly end: number }
}

/**
 * The message source of a branch event: EXACTLY the frozen plugin-source
 * vocabulary of the session format (`kind`/`plugin`/`form`, with `summary`
 * admitted only on the notice form; deepseek-harness
 * session-format-v0-to-v1 `pluginSourceValue`). Unknown members make a
 * session log refuse to load under the format read path, so
 * machine-readable provenance lives in the preamble text instead — see
 * {@link parseTransferPreamble}.
 */
export type BranchEventSource =
  | {
    readonly kind: 'plugin'
    readonly plugin: 'dsh-session-fork'
    readonly form: 'notice'
    /** One-line UI account, bounded to the official 120-char notice limit. */
    readonly summary: string
  }
  | {
    readonly kind: 'plugin'
    readonly plugin: 'dsh-session-fork'
    /** Recall-form material lifted from another session's log carries no summary. */
    readonly form: 'recall'
  }

/**
 * Build a one-line branch event notice: no payload, no tags. Used for fork
 * notifications in both directions (the parent learns it was forked; the
 * child's seed marker is a notice too — a fork carries no payload, only the
 * fact of divergence), and for adopt/rename announcements.
 * @param facts - the event facts; `kind` must be a payload-less kind.
 * @param line - the complete one-line statement.
 * @returns a user message whose source stays inside the frozen vocabulary.
 */
export function buildBranchNotice(
  facts: BranchEventFacts,
  line: string,
): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: line }],
    source: {
      kind: 'plugin',
      plugin: 'dsh-session-fork',
      form: 'notice',
      summary: boundContextSummary(`${facts.kind}: ${facts.from} → ${facts.to}`),
    } satisfies BranchEventSource,
  })
}

/**
 * The standard notice lines. Centralized so every producer states the same
 * fact in the same words — the model learns one vocabulary, tests assert one
 * string. The phrasing follows the official checkpoint preamble: state the
 * fact, mark inherited material as background, tell the model to continue.
 */
export const branchNoticeLines = {
  /** Written into the CHILD's seed: the history above is inherited, not the child's own. */
  forkChild: (facts: BranchEventFacts): string =>
    `You are branch "${facts.to}", forked from branch "${facts.from}" at turn ${facts.atTurn ?? '?'}. ` +
    `The conversation above was inherited from "${facts.from}" — you did not produce it. ` +
    `Treat it as established background and continue the task from here.`,
  /** Written into the PARENT: a branch diverged from you here. */
  forkParent: (facts: BranchEventFacts): string =>
    `Branch "${facts.to}" forked from you at turn ${facts.atTurn ?? '?'}.`,
  /** Written into the ADOPTED session: you are now a registered root branch (issue #37). */
  adopted: (facts: BranchEventFacts): string =>
    `This session is now branch "${facts.to}" — the root branch of this workspace (adopted via /branch adopt). ` +
    `The conversation is your own work. Treat branch-scoped operations (fork from here, squash into you, ` +
    `rebased into you) as applying to this session.`,
  /** Written into the RENAMED branch's session: your branch changed its name (issue #37). */
  renamed: (facts: BranchEventFacts): string =>
    `Your branch was renamed: "${facts.from}" is now "${facts.to}". ` +
    `Use "${facts.to}" in branch commands (/squash into, /rebased into, /branch rm). ` +
    `Earlier notices may still say "${facts.from}" — they were true when written.`,
} as const

/** The material noun each envelope kind delivers. */
const MATERIAL_NOUN: Readonly<Record<BranchEventKind, string>> = {
  fork: 'notice',
  squash: 'summary',
  'rebased-into': 'transcript',
  message: 'message',
  // adopt/rename are payload-less facts — they ride `buildBranchNotice`
  // and never reach the envelope path; the entries keep the Record total.
  adopt: 'notice',
  rename: 'notice',
}

/**
 * How each envelope kind tells the reader to treat the payload — the
 * preamble's closing clause. Settled material (a summary, a transcript) is
 * established background; a message is live peer input that may carry a
 * request the target should act on (issue #47: task dispatch, handling
 * requests), so it must not be filed away as background.
 */
const TREAT_AS: Readonly<Record<BranchEventKind, string>> = {
  fork: 'Treat it as established background.',
  squash: 'Treat it as established background.',
  'rebased-into': 'Treat it as established background.',
  adopt: 'Treat it as established background.',
  rename: 'Treat it as established background.',
  message: 'It may carry a request or information from that branch\'s agent — act on it or reply as appropriate.',
}

/**
 * The envelope text: an English preamble plus an XML-style tag pair,
 * mirroring the official compaction checkpoint. The payload is material
 * from ANOTHER branch: a squash summary, one page of a rebased-into
 * transcript, or a live message. The preamble states full provenance and
 * marks the material per kind (settled material as background, a message
 * as peer input); the close tag keeps later grafted material from blurring
 * into the target's own history.
 *
 * The preamble's head is a MACHINE contract — {@link parseTransferPreamble}
 * keys on it — so its wording must not drift; tests round-trip every
 * builder output through the parser.
 * @param facts - the event facts; `kind` is 'squash', 'rebased-into', or
 *   'message' (fork has no payload).
 * @param payload - the verbatim payload text (summary or transcript).
 * @returns the complete envelope text.
 */
export function branchEnvelopeText(
  facts: BranchEventFacts,
  payload: string,
): string {
  const rangePart = facts.range !== undefined ? `, covering its turns ${facts.range.start}–${facts.range.end}` : ''
  const originPart = facts.atTurn !== undefined ? ` (forked at turn ${facts.atTurn}${rangePart})` : rangePart !== '' ? ` (${rangePart.slice(2)})` : ''
  const preamble =
    `This is a ${facts.kind} from branch "${facts.from}"${originPart} into branch "${facts.to}". ` +
    `The ${MATERIAL_NOUN[facts.kind]} below happened on "${facts.from}" and was transferred by dsh-session-fork; ` +
    `it is not part of this branch's own conversation. ${TREAT_AS[facts.kind]}`
  return (
    `${preamble}\n` +
    `<branch-${facts.kind}>\n` +
    `${payload}\n` +
    `</branch-${facts.kind}>`
  )
}

/**
 * Build a branch event envelope message around a payload. The source stays
 * inside the frozen plugin-source vocabulary (see {@link BranchEventSource});
 * machine consumers recognize transfer envelopes through the preamble
 * ({@link parseTransferPreamble}), never through source extensions.
 * @param facts - the event facts; `kind` is 'squash', 'rebased-into', or
 *   'message' (fork has no payload).
 * @param payload - the verbatim payload text (summary or transcript).
 * @returns a user message whose source carries only legal members.
 */
export function buildBranchEnvelope(
  facts: BranchEventFacts,
  payload: string,
): UserMessage {
  // The frozen vocabulary admits `summary` only on the notice form, so the
  // recall-form rebased-into envelope carries none — its preamble line is
  // the self-describing account.
  const source: BranchEventSource = facts.kind === 'rebased-into'
    ? { kind: 'plugin', plugin: 'dsh-session-fork', form: 'recall' }
    : {
      kind: 'plugin',
      plugin: 'dsh-session-fork',
      form: 'notice',
      summary: boundContextSummary(`${facts.kind}: ${facts.from} → ${facts.to}`),
    }
  return createUserMessage({
    content: [{ type: 'text', text: branchEnvelopeText(facts, payload) }],
    source,
  })
}

/** The transfer facts recoverable from an envelope preamble. */
export interface TransferPreamble {
  /** Which transfer produced the envelope. */
  readonly kind: 'squash' | 'rebased-into' | 'message'
  /** The source branch's NAME at event time (point-in-time, like a commit message). */
  readonly fromName: string
}

/**
 * Machine contract of the transfer preamble: recover the transfer kind and
 * the source branch name from message text. The template lives in
 * {@link branchEnvelopeText} and the pair is pinned by round-trip tests, so
 * detection cannot drift from the wording. Branch names follow the official
 * session-title pipeline, which does not forbid double quotes; a name that
 * contains one simply fails the anchored match (the row then degrades to a
 * non-transfer plugin message — no row, no edge — never a wrong fact).
 * Non-transfer texts (notices, user prose) yield null.
 * @param text - complete message text of any user message.
 * @returns the transfer facts for squash/rebased-into/message envelopes, else null.
 */
export function parseTransferPreamble(text: string): TransferPreamble | null {
  const match = /^This is a (squash|rebased-into|message) from branch "([^"]+)"(?: \([^)]*\))? into branch "/.exec(text)
  return match === null ? null : { kind: match[1] as TransferPreamble['kind'], fromName: match[2]! }
}
