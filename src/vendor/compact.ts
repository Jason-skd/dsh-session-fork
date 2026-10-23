/**
 * VENDORED FROM: deepseek-harness@528c682e061696f5a160f363f236ecbf53cbd006
 * (copied 2026-08-21; re-aligned against dsh 0.1.2-rc.1 on 2026-09-04 —
 * upstream region.ts grew to 559 lines and summarizer.ts to 224)
 *
 * - packages/compaction/compaction-basic/src/index.ts:368-420 — the
 *   `compactNow` idle shell: runMaintenance wrap, AbortSignal.any fusion,
 *   busy/cancelled ManualCompactionError classification. (Upstream index.ts
 *   restructured its automatic-compaction halves since; the shell's cited
 *   semantics are those captured at 528c682e and are unchanged upstream.)
 * - packages/compaction/compaction-basic/src/region.ts:27-135 — the
 *   `compactSurfaceRegion` transaction and its helpers:
 *   validateSurfaceRegion / prepareCompaction / summarizeCompaction /
 *   assertSelectedSpanStable / commitCompactionBody / completeCompaction /
 *   inspectCompactionEntryState / assertCompactionInactive /
 *   throwManualFailure. The transaction's support types (SurfaceSelection,
 *   PreparedCompaction, SummarizedCompaction, CompactionTransactionOptions,
 *   CompactionEntryState, SurfaceChangedError, StabilityCheck,
 *   TransactionFailure) come from the block immediately above the cited span
 *   (region.ts:27-98), vendored verbatim.
 * - packages/compaction/compaction-basic/src/summarizer.ts:31-224 —
 *   summarizeWithLlm / COMPACTION_INSTRUCTION / CHECKPOINT_PREAMBLE /
 *   frameSummary / finishError / summaryText. SummaryConfig comes from
 *   summarizer.ts:14-18 and SummarizationInput from summarizer.ts:60-85,
 *   just above the cited span.
 *
 * The shell's `regionDependencies()` binding comes from
 * packages/compaction/compaction-basic/src/index.ts:423-428, immediately
 * below the cited span.
 *
 * Deliberately NOT vendored:
 * - `selectCompactableRange` (region.ts:98-135) — see the [fork:surgery]
 *   marker at `compactNow`: the entry takes an explicit region and there is
 *   no automatic selection fallback.
 * - `assertWholeSurfaceUnchanged` (region.ts:396-407) — see the [fork:adapt]
 *   marker at the transaction's stability check.
 * - `assertNoActiveCompaction` (region.ts:302-315) — an automatic-pressure
 *   recheck; squash is command-driven and the transaction's own entry-state
 *   check already gates it.
 * - the config layer (config.ts resolveConfig / resolveTargetPolicy and the
 *   modelPolicies schema) — see the [fork:adapt] marker at
 *   DEFAULT_SUMMARY_CONFIG: this plugin supports no model-level compaction
 *   overrides.
 * - the automatic-compaction halves of the engine (compactIfNeeded, the
 *   agent/pre-step and request-error listeners) — squash is an explicit
 *   command-driven operation; automatic pressure compaction is out of
 *   scope.
 *
 * Vendor policy (dsh-session-fork vendor-replication standard): every deviation
 * from upstream carries exactly one marker —
 * - `[fork:adapt]`   mechanical adaptation, no semantic change (injected
 *   dependencies instead of closure capture, structural type slices, type
 *   import paths);
 * - `[fork:surgery]` a semantic operation, with its reason inline.
 * `tests/vendor.test.ts` pins the marker counts.
 * @module dsh-session-fork/src/vendor/compact
 */

import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import {
  BlockAssembler,
  contentHasImage,
  createUserMessage,
  errorChain,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  Message,
  StreamChunk,
  TokenUsage,
  ToolSchema,
  UserMessage,
} from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import { SessionSeq as sessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement, TokenMeter } from '@deepseek-ai/dsh-token-meter'

// ---------------------------------------------------------------------------
// support types — region.ts:27-98 and summarizer.ts:14-18/60-85, verbatim
// ---------------------------------------------------------------------------

// [fork:adapt] RegionDependencies restated: upstream declares this interface
// module-private (region.ts:27-30); the vendor copy re-declares it so the
// transaction and the injected dependencies are nameable here.
export interface RegionDependencies {
  readonly meter: TokenMeter
  summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult>
}

/** One validated inclusive span of current surface positions. */
interface SurfaceSelection {
  readonly start: SessionSeq
  readonly end: SessionSeq
  readonly startIdx: number
  readonly endIdx: number
  readonly shadowedSeqs: readonly SessionSeq[]
}

/** A selection with its priced snapshot and the replay input built from it. */
interface PreparedCompaction extends SurfaceSelection {
  readonly measurement: TokenMeasurement
  readonly selectedNodes: TokenMeasurement['nodes']
  readonly shadowedTokenCount: number
  /** Route-priced total of the selected span; the shrink comparison's unit. */
  readonly shadowedRouteTokenCount: number
  readonly input: SummarizationInput
}

type SummarizedCompaction = PreparedCompaction & SummaryResult & {
  readonly checkpointMessage: UserMessage
}

interface CompactionTransactionOptions {
  /** `current-turn` derives a numbered owner; `null` writes a standalone bracket. */
  readonly owner: 'current-turn' | null
  /** Surface relationship that must survive asynchronous summarization. */
  readonly stability: 'whole-surface' | 'selected-span'
  /** Optional durability checkpoint after a successfully closed bracket. */
  readonly flush?: () => Promise<void>
  /** Manual command that initiated this transaction, when present. */
  readonly sourceCommandId?: CommandId
}

interface CompactionEntryState {
  readonly openTurn: number | null
  readonly unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined
  readonly latestEndSeedSeq: SessionSeq | undefined
}

/**
 * Rejects a summary whose replacement boundaries are no longer the ones it was
 * built from, distinguished from summarizer and shrink failures so a manual
 * caller can report the two causes differently.
 */
class SurfaceChangedError extends Error {}

/** Whether the summary may still replace the span it was built from. */
type StabilityCheck = (
  dependencies: RegionDependencies,
  session: Session,
  prepared: PreparedCompaction,
) => void

/** Failure captured after `compaction/start` has committed. */
interface TransactionFailure {
  readonly error: unknown
  readonly stage: 'summary' | 'commit'
}

/** Summarizer support type — summarizer.ts:14-18, just above the cited span. */
interface SummaryConfig {
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
}

/** Tags wrapping the structured summary inside the landed checkpoint node. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/**
 * The summarization directive, delivered as the FINAL user message after the
 * replayed conversation rather than as a distinct summarizer system prompt.
 * Keeping the conversation's own system prompt, tools, and message prefix in
 * front of it makes the auxiliary call a genuine prefix of the last routed
 * request, so the provider's KV cache is reused instead of invalidated.
 *
 * Rewritten per the [fork:surgery] note at `buildSummarizationInput` below:
 * the FINAL M messages are the compaction target (M = region node count,
 * injected here) and all earlier messages are established context to absorb,
 * not restate. The eight-section template structure is preserved.
 */
function compactionInstruction(targetMessageCount: number): string {
  return [
    'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
    '',
    `The conversation above has two parts. The FINAL ${targetMessageCount} message${targetMessageCount === 1 ? '' : 's'} ${targetMessageCount === 1 ? 'is' : 'are'} the compaction target: condense ${targetMessageCount === 1 ? 'it' : 'them'} faithfully and completely. ALL earlier messages are established context, not compaction material: absorb their facts, decisions, and constraints so the checkpoint stays consistent with them, but do NOT restate or re-summarize them.`,
    '',
    'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
    '',
    '## Primary Request and Intent',
    "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
    '',
    '## Key Technical Concepts',
    '- [technologies, frameworks, patterns, and conventions in play]',
    '',
    '## Files and Code',
    '- [exact path: why it matters, key changes or snippets]',
    '',
    '## Errors and Fixes',
    '- [error: how it was resolved, plus any related user feedback]',
    '',
    '## Pending Jobs',
    '- [explicitly requested work not yet completed]',
    '',
    '## Current Work',
    '- [precisely what was in progress at this checkpoint]',
    '',
    '## Next Step',
    '- [the single next action, directly in line with the most recent request, or "(none)"]',
    '',
    '## Critical Context',
    '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
    '',
    'Rules:',
    '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
    '- Capture user feedback and explicit instructions faithfully, especially corrections.',
    '- Do NOT mention this summarization request or that the context was compacted.',
    '- Output only the checkpoint text: do not call any tool or take any other action.',
    `- If the established context already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint: absorb the facts that are still true, drop stale ones, and merge newer information — never copy it forward verbatim.`,
  ].join('\n')
}

/** Framing that makes the replacement user message established context. */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/**
 * The replayed conversation surface the summarizer condenses. Reproducing the
 * last routed request's system prompt, tools, and leading messages verbatim
 * lets the auxiliary call reuse the provider's warm prefix cache; the trailing
 * compaction instruction is then the only novel input.
 */
// [fork:adapt] upstream's input carries only the shadowed region; the vendor
// copy feeds the FULL surface (see the [fork:surgery] note at
// buildSummarizationInput), so `messages` is the complete conversation, and
// additionally carries the compaction target's message count so
// summarizeWithLlm can delimit the region inside the rewritten instruction.
export interface SummarizationInput {
  /** The conversation's own system prompt, reused for prefix-cache alignment; absent for a system-less request. */
  readonly system?: string
  /** The conversation's tool schemas, reused for prefix-cache alignment; absent when the request carried none. */
  readonly tools?: readonly ToolSchema[]
  /** The FULL replayed surface, in order, that precedes the compaction instruction. */
  readonly messages: readonly Message[]
  /** Message count of the compaction target: the FINAL `targetMessageCount` messages are the region being compacted. */
  readonly targetMessageCount: number
}

/** Safe summary content plus the exact auxiliary call envelope recorded with it. */
export type SummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  /** Provider-reported usage for this summarization request. */
  usage?: TokenUsage
} & (
  | {
    /** Complete provider output before the text-only summary projection. */
    rawOutput: ContentBlock[]
    /** Identifies exactly one call through this context's `ctx.llm.stream()`. */
    llmStreamCall: true
  }
  | {
    /** Optional complete output from an unmarked template, remote, or other summarizer. */
    rawOutput?: ContentBlock[]
    /** An unmarked result does not identify a call through this context's LLM seam. */
    llmStreamCall?: never
  }
)

/**
 * Run the default cache-reusing `ctx.llm.stream()` summarization call: replay
 * the conversation prefix, then append the compaction instruction as the final
 * user message so the provider's warm prefix cache is reused.
 * @param llm - LLM service slice providing the stream.
 * @param config - resolved backend configuration.
 * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
 * @param agent - supplies routed-model history, fallback model, and session id.
 * @param signal - optional cancellation forwarded to the adapter.
 * @returns safe text-only summary blocks and the exact call envelope and output.
 */
// [fork:adapt] upstream summarizeWithLlm closes over the full cordis Context
// and streams through `ctx.llm`; the vendor copy receives a structural LLM
// service slice so the command wiring (and tests) can inject it without
// constructing a context. The rest is verbatim, including the target
// fallback chain: configured pair → session.requestHeader()?.config →
// agent.options (summarizer.ts:128-143).
export async function summarizeWithLlm(
  llm: LlmServiceLike,
  config: SummaryConfig,
  input: SummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const latest = agent.session.requestHeader()?.config
  const configured = config.summarizationProvider.length === 0
    ? undefined
    : { provider: config.summarizationProvider, model: config.summarizationModel }
  const agentTarget = agent.options.provider !== undefined
    && agent.options.provider.length > 0
    && agent.options.model !== undefined
    && agent.options.model.length > 0
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  const target = configured ?? latest ?? agentTarget
  if (target === undefined) {
    throw new Error(
      'no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields',
    )
  }

  const assembler = new BlockAssembler()
  const messages: Message[] = [
    ...input.messages,
    createUserMessage({
      content: [{ type: 'text', text: compactionInstruction(input.targetMessageCount) }],
      // Upstream marks this auxiliary message with the compaction-basic
      // plugin id; kept verbatim — the instruction message is a side call
      // that never lands in any persisted log.
      source: { kind: 'compact-basic' },
    }),
  ]
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages,
    ...input.system === undefined ? {} : { system: input.system },
    ...input.tools === undefined ? {} : { tools: [...input.tools] },
    maxTokens: config.maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...signal === undefined ? {} : { signal },
  }
  for await (const chunk of llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error

  const rawOutput = assembler.blocks()
  const summary = summaryText(rawOutput)
  if (!summary.some(block => block.text.trim().length > 0)) {
    throw new Error('summarization produced no text summary content')
  }
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    maxTokens: config.maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

/**
 * Wrap raw summary blocks in the durable checkpoint framing.
 * @param summary - safe text-only model output.
 * @returns content for the synthesized replacement user message.
 */
export function frameSummary(summary: readonly ContentBlock[]): ContentBlock[] {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}

/** Map a terminal summarization finish to its fail-closed error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/** Reject visual output and keep only text before synthesizing a user message. */
function summaryText(
  blocks: readonly ContentBlock[],
): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}

// ---------------------------------------------------------------------------
// fixed summarization config + region dependencies
// (index.ts:423-428, immediately below the cited span)
// ---------------------------------------------------------------------------

// [fork:adapt] fixed summarization config. Upstream resolves a per-target
// policy override (config.ts resolveConfig / resolveTargetPolicy) before
// calling summarizeWithLlm; the vendor copy supports no model-level
// overrides, so those are deliberately not vendored and one fixed config is
// used for every call: an empty summarization provider/model pair (target
// resolution then falls back through session.requestHeader()?.config and
// agent.options, mirroring summarizer.ts:128-143) and the upstream default
// maxTokens of 8192.
const DEFAULT_SUMMARY_CONFIG: SummaryConfig = {
  summarizationProvider: '',
  summarizationModel: '',
  maxTokens: 8192,
}

// [fork:adapt] upstream binds this pair in the private
// BasicCompactionEngine.regionDependencies() method, dispatching the
// protected summarize hook; the vendor copy builds the same pair from the
// injected deps, with the summarize hook wired straight to summarizeWithLlm
// through the fixed default config.
function regionDependencies(deps: CompactNowDeps): RegionDependencies {
  return {
    meter: deps.meter,
    summarize: (input, agent, abort) =>
      summarizeWithLlm(deps.llm, DEFAULT_SUMMARY_CONFIG, input, agent, abort),
  }
}

// ---------------------------------------------------------------------------
// compactNow — packages/compaction/compaction-basic/src/index.ts:368-420
// ---------------------------------------------------------------------------

/** Structural slice of the LLM service `summarizeWithLlm` streams through. */
export interface LlmServiceLike {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** Dependencies the vendored compactNow shell closes over. */
export interface CompactNowDeps {
  /** The conversation meter for all pricing and shrink checks (`ctx.tokenMeter`). */
  readonly meter: TokenMeter
  /** The LLM service slice for the summarization call (`ctx.llm`). */
  readonly llm: LlmServiceLike
}

/** One explicit compaction request, naming the region by surface position. */
export interface CompactRegionRequest {
  /** Inclusive first surface-node seq of the region to compact. */
  readonly start: SessionSeq
  /** Inclusive last surface-node seq of the region to compact. */
  readonly end: SessionSeq
  /** Optional durability checkpoint after a successfully closed bracket. */
  readonly flush?: () => Promise<void>
  /** Manual command that initiated this transaction, when present. */
  readonly sourceCommandId?: CommandId
}

/**
 * Run one useful idle-session compaction over an explicit surface-position
 * region, and resolve only after its standalone marker pair is durably
 * checkpointed.
 * @param deps - injected conversation meter and LLM service slice.
 * @param agent - idle agent whose session is mutated.
 * @param signal - cancellation scoped to this compaction request.
 * @param request - the region to compact plus optional flush/source identity.
 * @returns the committed result.
 */
// [fork:surgery] explicit region. Upstream compactNow (index.ts:368-420)
// auto-selects its span with selectCompactableRange, which anchors at the
// HEAD of the surface and keeps only a priced tail: it would swallow the
// inherited fork prefix and can never name the post-fork region, and its
// `null` no-op return is meaningless for an explicit request. The vendor
// copy therefore takes a required {start,end} surface-position region
// (computed by the caller from the seed boundary), deletes
// selectCompactableRange entirely (no automatic fallback), and always
// returns a CompactionResult — a request either compacts exactly the named
// region or throws.
export async function compactNow(
  deps: CompactNowDeps,
  agent: Agent,
  signal: AbortSignal,
  request: CompactRegionRequest,
): Promise<CompactionResult> {
  signal.throwIfAborted()
  try {
    return agent.runMaintenance(async (agentSignal) => {
      const operationSignal = AbortSignal.any([agentSignal, signal])
      try {
        operationSignal.throwIfAborted()
        return await compactSurfaceRegion(
          regionDependencies(deps),
          agent.session,
          request.start,
          request.end,
          agent,
          // [fork:adapt] upstream fixes these options inside the shell and
          // closes `flush` over ctx.sessions.flush; the vendor copy fixes
          // the same option shape but receives the durability flush from
          // the caller (the /squash command passes a bound
          // ctx.sessions.flush).
          {
            owner: null,
            stability: 'selected-span',
            ...request.sourceCommandId === undefined ? {} : { sourceCommandId: request.sourceCommandId },
            ...request.flush === undefined ? {} : { flush: request.flush },
          },
          operationSignal,
        )
      } catch (error: unknown) {
        if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
          throw new ManualCompactionError(
            'cancelled',
            'manual compaction was cancelled',
            { cause: error },
          )
        }
        operationSignal.throwIfAborted()
        throw error
      }
    })
  } catch (error: unknown) {
    throw new ManualCompactionError(
      'busy',
      'manual compaction requires an idle agent with no waking queued work',
      { cause: error },
    )
  }
}

// ---------------------------------------------------------------------------
// compactSurfaceRegion + helpers — packages/compaction/compaction-basic/src/region.ts:142-559
// ---------------------------------------------------------------------------

/**
 * Run the single compaction transaction over one selected positional span.
 * Selection and validation are read-only. Idle/log validation and
 * `compaction/start` are synchronously adjacent, so the durable opening marker is
 * the compaction lock before summarization yields. Every later failure makes
 * exactly one `compaction/end` attempt; a failed close deliberately leaves the
 * unmatched start detectable.
 * @param dependencies - conversation meter and dynamically dispatched summarizer hook.
 * @param session - session whose surface is mutated.
 * @param start - inclusive first surface-node seq.
 * @param end - inclusive last surface-node seq.
 * @param agent - agent used by the summarizer.
 * @param options - bracket owner, stability rule, and optional durability checkpoint.
 * @param signal - optional summarization cancellation signal.
 * @returns the successful durable compaction result.
 */
export async function compactSurfaceRegion(
  dependencies: RegionDependencies,
  session: Session,
  start: SessionSeq,
  end: SessionSeq,
  agent: Agent,
  options: CompactionTransactionOptions,
  signal?: AbortSignal,
): Promise<CompactionResult> {
  if (options.owner === null) signal?.throwIfAborted()
  const selection = validateSurfaceRegion(session, start, end)
  const entryState = inspectCompactionEntryState(session)
  assertCompactionInactive(
    entryState.unmatchedCompactionStart,
    entryState.latestEndSeedSeq,
    'compaction',
  )

  let owner: number | null
  if (options.owner === null) {
    if (entryState.openTurn !== null) {
      throw new ManualCompactionError('busy', 'manual compaction: the session already has an open turn')
    }
    owner = null
  } else {
    if (entryState.openTurn === null) {
      throw new Error('compactRegion: no open turn — automatic compaction events must be enclosed in a turn')
    }
    owner = entryState.openTurn
  }

  const compactionId = CompactionId(randomUUID())
  const lifecycle = {
    compactionId,
    ...options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId },
    turn: owner,
  }
  const startEvent = session.append('compaction/start', lifecycle)
  // [fork:adapt] upstream selects the stability check from
  // `options.stability`; the vendor copy's only entry point fixes
  // `stability: 'selected-span'`, so assertWholeSurfaceUnchanged is
  // deliberately not vendored — a whole-surface equality check is dead code
  // for a fixed selected-span run (it would only reject legitimate
  // out-of-span growth), and the selected-span check below is the only
  // reachable branch.
  const assertStable: StabilityCheck = assertSelectedSpanStable
  let failure: TransactionFailure | undefined
  let flushFailure: unknown
  let result: CompactionResult | undefined
  let closed = false
  let closing = false
  let stage: TransactionFailure['stage'] = 'summary'

  try {
    const prepared = prepareCompaction(dependencies, session, selection)
    const summarized = await summarizeCompaction(
      dependencies,
      prepared,
      agent,
      compactionId,
      options.sourceCommandId,
      signal,
    )
    if (options.owner === null) signal?.throwIfAborted()
    assertStable(dependencies, session, summarized)
    stage = 'commit'
    const pending = commitCompactionBody(session, startEvent, summarized)
    closing = true
    const endEvent = session.append('compaction/end', lifecycle)
    closed = true
    result = completeCompaction(pending, endEvent)
  } catch (error: unknown) {
    failure = { error, stage: closing ? 'commit' : stage }
    if (!closing) {
      closing = true
      try {
        session.append('compaction/end', { ...lifecycle, error: errorChain(error) })
        closed = true
      } catch (closeError: unknown) {
        failure = { error: closeError, stage: 'commit' }
      }
    }
  }

  if (closed && options.flush !== undefined) {
    try {
      await options.flush()
    } catch (error: unknown) {
      flushFailure = error
    }
  }

  if (options.owner === null) signal?.throwIfAborted()
  if (failure !== undefined) {
    if (options.owner === null) throwManualFailure(failure)
    throw failure.error
  }
  if (flushFailure !== undefined) {
    throw new ManualCompactionError(
      'persistence',
      'manual compaction durability checkpoint failed',
      { cause: flushFailure },
    )
  }
  /* v8 ignore next -- every path without a result records and throws a failure above. */
  if (result === undefined) throw new Error('compaction committed without a result')
  return result
}

/** Classify one closed manual attempt without weakening cancellation precedence. */
function throwManualFailure(failure: TransactionFailure): never {
  if (failure.stage === 'commit') {
    throw new ManualCompactionError(
      'commit',
      'manual compaction did not commit cleanly',
      { cause: failure.error },
    )
  }
  if (failure.error instanceof SurfaceChangedError) {
    throw new ManualCompactionError(
      'changed',
      'the compacted history changed during manual compaction',
      { cause: failure.error },
    )
  }
  throw new ManualCompactionError(
    'summary',
    'manual compaction could not produce a smaller summary',
    { cause: failure.error },
  )
}

/**
 * Reject a durable unmatched compaction marker unless a later constructor-seed
 * boundary proves that its owner belongs to an earlier session lifecycle.
 * @param unmatchedCompactionStart - latest unmatched opening marker, if any.
 * @param latestEndSeedSeq - newest constructor-seed boundary, if any.
 * @param stage - operation label included in the busy diagnostic.
 */
function assertCompactionInactive(
  unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined,
  latestEndSeedSeq: SessionSeq | undefined,
  stage: string,
): void {
  if (unmatchedCompactionStart === undefined
    || (latestEndSeedSeq !== undefined
      && latestEndSeedSeq > unmatchedCompactionStart.seq)) return
  throw new ManualCompactionError(
    'busy',
    `${stage}: compaction already in progress; the session compaction lock is already active`,
  )
}

/** Validate one requested surface-position span before asynchronous work begins. */
function validateSurfaceRegion(session: Session, start: SessionSeq, end: SessionSeq): SurfaceSelection {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(start)
  const endIdx = nodes.indexOf(end)
  if (startIdx === -1) throw new Error(`compactRegion: start seq ${start} not found in surface`)
  if (endIdx === -1) throw new Error(`compactRegion: end seq ${end} not found in surface`)
  if (startIdx > endIdx) {
    throw new Error(
      `compactRegion: start seq ${start} (position ${startIdx}) is after end seq ${end} (position ${endIdx}) on the surface`,
    )
  }
  if (!toolPairingBalancedBefore(session, nodes[startIdx]!)) {
    throw new Error(`compactRegion: start seq ${start} is not a balanced boundary (would split a step's tool-call/result pair)`)
  }
  if (!toolPairingBalancedAfter(session, nodes[endIdx]!)) {
    throw new Error(`compactRegion: end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`)
  }

  return { start, end, startIdx, endIdx, shadowedSeqs: nodes.slice(startIdx, endIdx + 1) }
}

/** Snapshot pricing and replay input for a validated surface range. */
function prepareCompaction(
  dependencies: RegionDependencies,
  session: Session,
  selection: SurfaceSelection,
): PreparedCompaction {
  const measurement = dependencies.meter.measure(session)
  const selectedNodes = measurement.nodes.slice(selection.startIdx, selection.endIdx + 1)
  if (selectedNodes.length !== selection.shadowedSeqs.length
    || selectedNodes.some((node, index) => node.seq !== selection.shadowedSeqs[index])) {
    throw new SurfaceChangedError('compaction: selected surface changed before summarization began')
  }
  return {
    ...selection,
    measurement,
    selectedNodes,
    // The shadow-price protocol prices replacements with the fixed heuristic
    // so the O(1) projection fold stays in agreement with its own appends;
    // retention, range selection, and the shrink comparison read the
    // route-priced `tokens` instead.
    shadowedTokenCount: selectedNodes.reduce((total, node) => total + node.heuristicTokens, 0),
    shadowedRouteTokenCount: selectedNodes.reduce((total, node) => total + node.tokens, 0),
    input: buildSummarizationInput(session, selection.shadowedSeqs),
  }
}

/** Run the summarizer and frame its replacement checkpoint. */
async function summarizeCompaction(
  dependencies: RegionDependencies,
  prepared: PreparedCompaction,
  agent: Agent,
  compactionId: CompactionResult['compactionId'],
  sourceCommandId: CommandId | undefined,
  signal?: AbortSignal,
): Promise<SummarizedCompaction> {
  const summaryResult = await dependencies.summarize(prepared.input, agent, signal)
  const checkpointMessage = createUserMessage({
    content: frameSummary(summaryResult.summary),
    source: compactCheckpointSource(compactionId, sourceCommandId),
  })
  const framedSummaryTokenCount = dependencies.meter.estimateMessage(checkpointMessage)
  // The checkpoint is text-only, so its fixed-heuristic price IS its route
  // price; comparing it against the span's route price asks the real
  // question — does the replacement lower the next request's pressure.
  if (framedSummaryTokenCount >= prepared.shadowedRouteTokenCount) {
    throw new Error(
      `summary is not smaller than the shadowed content (${framedSummaryTokenCount} estimated framed tokens >= ${prepared.shadowedRouteTokenCount})`,
    )
  }
  return {
    ...prepared,
    ...summaryResult,
    checkpointMessage,
  }
}

/**
 * Require only that the selected span remain the same present, contiguous,
 * equally priced, balanced replacement target. Nodes added outside it remain
 * visible and do not invalidate the summary.
 */
function assertSelectedSpanStable(
  dependencies: RegionDependencies,
  session: Session,
  prepared: PreparedCompaction,
): void {
  let current: SurfaceSelection
  try {
    current = validateSurfaceRegion(session, prepared.start, prepared.end)
  } catch (error: unknown) {
    throw new SurfaceChangedError(
      'compaction: the selected span is no longer a valid replacement target',
      { cause: error },
    )
  }
  if (!isDeepStrictEqual([...current.shadowedSeqs], [...prepared.shadowedSeqs])) {
    throw new SurfaceChangedError('compaction: the selected span changed during summarization')
  }
  const measured = dependencies.meter.measure(session).nodes.slice(current.startIdx, current.endIdx + 1)
  if (!isDeepStrictEqual(measured, prepared.selectedNodes)) {
    throw new SurfaceChangedError('compaction: the selected span was rewritten during summarization')
  }
}

/** Append one completed summary record and replacement body without yielding. */
function commitCompactionBody(
  session: Session,
  startEvent: SessionEvent<'compaction/start'>,
  summarized: SummarizedCompaction,
): Omit<CompactionResult, 'endSeq'> {
  const {
    start,
    end,
    shadowedSeqs,
    shadowedTokenCount,
    summary,
    provider,
    model,
    maxTokens,
    usage,
    checkpointMessage,
  } = summarized
  const callProvenance = summarized.llmStreamCall === true
    ? { rawOutput: summarized.rawOutput, llmStreamCall: true as const }
    : summarized.rawOutput === undefined ? {} : { rawOutput: summarized.rawOutput }
  const summaryEvent = session.append('compaction/summary', {
    compactionId: startEvent.data.compactionId,
    ...startEvent.data.sourceCommandId === undefined
      ? {}
      : { sourceCommandId: startEvent.data.sourceCommandId },
    summary,
    ...callProvenance,
    shadowedRange: { start, end },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount,
    provider,
    model,
    ...maxTokens === undefined ? {} : { maxTokens },
    ...usage === undefined ? {} : { usage },
  })
  session.append('user/message', checkpointMessage, {
    surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
  })
  return {
    compactionId: startEvent.data.compactionId,
    ...startEvent.data.sourceCommandId === undefined
      ? {}
      : { sourceCommandId: startEvent.data.sourceCommandId },
    startSeq: startEvent.seq,
    summarySeq: summaryEvent.seq,
    summary,
    shadowedRange: { start, end },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount,
  }
}

/** Attach the successfully appended close event to a pending result. */
function completeCompaction(
  pending: Omit<CompactionResult, 'endSeq'>,
  endEvent: SessionEvent<'compaction/end'>,
): CompactionResult {
  return { ...pending, endSeq: endEvent.seq }
}

/**
 * Reconstruct the last routed request's cacheable prefix: its system prompt
 * and tool schemas, then EVERY surface message in order. The summarizer
 * appends only the compaction instruction after this, so the call is a
 * genuine prefix of the conversation and reuses the provider's KV cache.
 * @param session - session supplying the request header and per-node projection.
 * @param shadowedSeqs - the surface-node seqs of the region, in order; only their COUNT is used.
 * @returns the replayed conversation prefix to condense.
 */
// [fork:surgery] full-surface summarization input. Upstream
// buildSummarizationInput (region.ts:508-523) replays ONLY the shadowed
// region after the header: for an automatic head compaction that prefix is
// byte-identical to the last routed request and hits the provider's warm KV
// cache, but a post-fork region sits at the mid/tail of the surface, the
// replayed prefix never lines up, and the cache is missed. The vendor copy
// feeds EVERY surface node in order, so [system, tools, full conversation,
// instruction] is a genuine prefix of the last routed request — full
// KV-cache reuse plus the inherited prefix as summarization context (better
// summary quality). The rewritten compactionInstruction above delimits the
// compaction target as the FINAL M messages, where M = the region node count
// injected here, so the model condenses exactly the post-fork region and
// treats everything earlier as established context.
function buildSummarizationInput(
  session: Session,
  shadowedSeqs: readonly SessionSeq[],
): SummarizationInput {
  const header = session.requestHeader()
  const messages = session.surface.nodes
    // surface nodes are current surface seqs, so each is a valid log index.
    .map(seq => session.deriveEventMessage(session.eventAt(seq)!))
    .filter((message): message is Message => message !== null)
  return {
    ...header?.system === undefined ? {} : { system: header.system },
    ...header?.tools === undefined ? {} : { tools: header.tools },
    messages,
    targetMessageCount: shadowedSeqs.length,
  }
}

/** Inspect open-turn, unmatched-compaction, and latest seed-boundary state independently. */
function inspectCompactionEntryState(session: Session): CompactionEntryState {
  let openTurn: number | null = null
  let openTurnStateKnown = false
  let unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined
  let compactionEntryStateKnown = false
  let latestEndSeedSeq: SessionSeq | undefined
  for (let offset: number = session.seq - 1; offset >= 0; offset -= 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const event = session.eventAt(sessionSeq(offset))!
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') {
      latestEndSeedSeq = event.seq
    }
    if (!compactionEntryStateKnown) {
      if (event.type === 'compaction/start') {
        unmatchedCompactionStart = event
        compactionEntryStateKnown = true
      } else if (event.type === 'compaction/end') {
        compactionEntryStateKnown = true
      }
    }
    if (!openTurnStateKnown) {
      if (event.type === 'turn/start') {
        openTurn = event.data.turn
        openTurnStateKnown = true
      } else if (event.type === 'turn/end') {
        openTurnStateKnown = true
      }
    }
    if (openTurnStateKnown
      && compactionEntryStateKnown
      && latestEndSeedSeq !== undefined) break
  }
  return { openTurn, unmatchedCompactionStart, latestEndSeedSeq }
}
