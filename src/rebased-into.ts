/**
 * Pure rebased-into logic: serialize the source branch's post-fork surface region
 * into a verbatim transcript for the shared branch-event envelope.
 *
 * The region itself is decided by `mergeRegion()` (see merge-region.ts) so
 * squash, merge, and rebased-into can never disagree about what "this branch's
 * own conversation" means. This module only owns the rendering half:
 * turning derived messages into a human-readable transcript that preserves
 * order, reasoning, tool calls, and tool results — never truncated, never
 * dropped. Opaque plugin blocks state their type instead of vanishing.
 *
 * No cordis, no I/O — unit-testable with fake session objects, mirroring the
 * purity discipline of squash.ts. See docs/design/rebased-into.md for the design
 * contract this implements (2026-08-23).
 * @module dsh-session-fork/src/rebase
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PostForkRange } from './squash.js'

/** One serialized turn boundary: the turn numbers the transcript spans. */
export interface TranscriptTurns {
  /** First turn number seen in the region, when any event carries one. */
  readonly start?: number
  /** Last turn number seen in the region, when any event carries one. */
  readonly end?: number
}

/** The serialized post-fork region. */
export interface Transcript {
  /** Role-prefixed, order-preserving rendering of every derived message. */
  readonly text: string
  /** Turn coordinates the region spans, for the envelope's `range` facts. */
  readonly turns: TranscriptTurns
  /** How many surface nodes were serialized. */
  readonly nodeCount: number
}

/** Render one content block as transcript text; unknown blocks state their type. */
function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'reasoning':
      return `(thinking) ${block.text}`
    case 'tool-call':
      return `tool call ${block.name}(${block.arguments})`
    default:
      // Merge-extensible union: an unknown plugin block is opaque content —
      // state that honestly rather than dropping it silently.
      return `(opaque ${(block as { type: string }).type} block)`
  }
}

/** Render one derived message with its role prefix. */
function renderMessage(message: Message): string {
  const body = message.content.map(renderBlock).join('\n')
  if (message.role === 'tool') {
    return `tool result${message.isError === true ? ' (error)' : ''} for call ${message.toolCallId}:\n${body}`
  }
  return `${message.role}: ${body}`
}

/**
 * Serialize the post-fork surface region of one session into a verbatim
 * transcript: every surface node in the region, in order, rendered with a
 * role prefix; reasoning, tool calls, and tool results ride along. Nothing
 * is truncated (the design contract's "complete transfer" promise) — the
 * only true bound is the target branch's context window, stated by the
 * envelope preamble, not by this serializer.
 * @param session - the source session whose region was decided upstream.
 * @param range - the region to serialize.
 * @returns the transcript plus turn coordinates for the envelope facts.
 */
export function serializeTranscript(session: Session, range: PostForkRange): Transcript {
  const lines: string[] = []
  const turns: number[] = []
  let nodeCount = 0
  for (const seq of session.surface.nodes) {
    if (seq < range.start || seq > range.end) continue
    const event = session.eventAt(seq)
    if (event === undefined) continue
    const turn = (event.data as { turn?: number } | undefined)?.turn
    if (typeof turn === 'number') turns.push(turn)
    const message = session.deriveEventMessage(event)
    if (message === null) continue
    lines.push(renderMessage(message))
    nodeCount += 1
  }
  return {
    text: lines.join('\n\n'),
    turns: turns.length === 0 ? {} : { start: Math.min(...turns), end: Math.max(...turns) },
    nodeCount,
  }
}
