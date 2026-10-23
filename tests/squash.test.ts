/**
 * Tests for the pure squash logic: post-fork region selection with edge
 * validation, checkpoint extraction, merge provenance, and the error text
 * mapping — all against fake session objects, no cordis.
 * @module dsh-session-fork/tests/squash.test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { CompactionId, compactCheckpointSource, isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import type { ManualCompactionErrorCode } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  buildMergeCheckpoint,
  extractCheckpointMessage,
  postForkRange,
  squashErrorText,
  SquashCoreError,
  turnRangeOf,
} from '../src/squash.js'

/** One raw fake log event; its array index becomes its seq. */
interface FakeEvent {
  type: string
  data?: unknown
}

/**
 * Build a structural fake Session over raw events and a surface node list.
 * `deriveEventMessage` serves `user/message` events from `data.message`;
 * tool-pairing balance is computed by the real
 * `toolPairingBalancedBefore/After` imports over these events.
 *
 * `inheritedEventCount` defaults to 0 (a forked child with an empty prefix —
 * the first end-seed in the log is the construction marker, matching every
 * single-marker fixture); pass `null` for a ROOT session (no fork lineage).
 */
function fakeSession(
  rawEvents: readonly FakeEvent[],
  surfaceSeqs: readonly number[],
  inheritedEventCount?: number | null,
): Session {
  const events = rawEvents.map((raw, seq) => ({ seq, ...raw })) as unknown as SessionEvent[]
  const deriveEventMessage = (event: SessionEvent): Message | null => {
    if (event.type !== 'user/message') return null
    const data = event.data as { message?: Message } | undefined
    return data?.message ?? null
  }
  return {
    snapshotEvents: () => Object.freeze([...events]),
    eventAt: (seq: number) => events[seq],
    get seq() { return events.length },
    surface: { nodes: [...surfaceSeqs], replaceGeneration: 1 },
    deriveEventMessage,
    ...(inheritedEventCount === null
      ? { header: {}, inheritedEventCount: 0 }
      : {
        header: { isSeeded: true, inheritedEventCount: inheritedEventCount ?? 0 },
        inheritedEventCount: inheritedEventCount ?? 0,
      }),
  } as unknown as Session
}

/** A real checkpoint user message, like the one a compaction replacement lands. */
function checkpointUserMessage(compactionId: string, text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: compactCheckpointSource(CompactionId(compactionId)),
  })
}

/** Run `fn` and return the thrown SquashCoreError code. */
function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as SquashCoreError).code
  }
  throw new Error('expected a throw')
}

describe('postForkRange', () => {
  test('selects the surface tail after the seed boundary', () => {
    const session = fakeSession(
      [
        { type: 'user/message' },
        { type: 'session/end-seed' },
        { type: 'user/message' },
        { type: 'user/message' },
      ],
      [0, 2, 3],
    )
    expect(postForkRange(session)).toEqual({ start: 2, end: 3 })
  })

  test('a single post-fork node is a valid region', () => {
    const session = fakeSession(
      [
        { type: 'user/message' },
        { type: 'session/end-seed' },
        { type: 'user/message' },
      ],
      [0, 2],
    )
    expect(postForkRange(session)).toEqual({ start: 2, end: 2 })
  })

  test('no seed boundary fails with missing-seed-boundary', () => {
    const session = fakeSession(
      [{ type: 'user/message' }, { type: 'user/message' }],
      [0, 1],
    )
    expect(codeOf(() => postForkRange(session))).toBe('missing-seed-boundary')
  })

  test('nothing after the seed boundary fails with empty-fork-range', () => {
    const session = fakeSession(
      [
        { type: 'user/message' },
        { type: 'session/end-seed' },
      ],
      [0],
    )
    expect(codeOf(() => postForkRange(session))).toBe('empty-fork-range')
  })

  test('a region start inside an open tool pair fails with unbalanced-range', () => {
    // The assistant tool-call at seq 0 is still open when the region starts
    // at seq 3 (its tool/result lands at seq 4, inside the region).
    const session = fakeSession(
      [
        { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } },
        { type: 'user/message' },
        { type: 'session/end-seed' },
        { type: 'user/message' },
        { type: 'tool/result' },
      ],
      [0, 1, 3, 4],
    )
    expect(codeOf(() => postForkRange(session))).toBe('unbalanced-range')
  })

  test('a region end that opens a tool call fails with unbalanced-range', () => {
    // The assistant tool-call at seq 2 (the region end) never closes.
    const session = fakeSession(
      [
        { type: 'user/message' },
        { type: 'session/end-seed' },
        { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } },
        { type: 'user/message' },
      ],
      [0, 2, 3],
    )
    expect(codeOf(() => postForkRange(session))).toBe('unbalanced-range')
  })

  test('balance: false returns the unbalanced region for the mid-turn dispatch', () => {
    // Same shape as the test above — the running source's own initiating
    // call keeps the step open — but the mid-turn dispatch computes its
    // region WITHOUT the time-sensitive pairing gates: the executor
    // re-validates on the post-cancellation idle surface.
    const session = fakeSession(
      [
        { type: 'user/message' },
        { type: 'session/end-seed' },
        { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } },
        { type: 'user/message' },
      ],
      [0, 2, 3],
    )
    expect(postForkRange(session, { balance: false })).toEqual({ start: 2, end: 3 })
  })

  test('balanced tool pairs inside the region pass both edge checks', () => {
    // The tool-call at seq 2 closes at seq 3, fully inside the region.
    const session = fakeSession(
      [
        { type: 'user/message' },
        { type: 'session/end-seed' },
        { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } },
        { type: 'tool/result' },
        { type: 'user/message' },
      ],
      [0, 2, 3, 4],
    )
    expect(postForkRange(session)).toEqual({ start: 2, end: 4 })
  })

  test('a mid-history cold-resume marker does not truncate the region', () => {
    // Construction marker at 1; the branch went cold and was resumed at 4.
    // The region must still span the child's whole post-fork surface, not
    // just the post-resume tail.
    const session = fakeSession(
      [
        { type: 'user/message' },        // 0: inherited
        { type: 'session/end-seed' },    // 1: construction
        { type: 'user/message' },        // 2: own work
        { type: 'user/message' },        // 3: own work
        { type: 'session/end-seed' },    // 4: cold-resume marker
        { type: 'user/message' },        // 5: own work after resume
      ],
      [0, 2, 3, 5],
      1,
    )
    expect(postForkRange(session)).toEqual({ start: 2, end: 5 })
  })

  test('squashing a cold branch finds the region before its own resume marker', () => {
    // The real-world shape (go-ce-v3 feat/rm): inherited markers below the
    // lineage, the construction marker at it, and a resume marker written
    // moments before /squash itself ran on the cold branch — nothing but
    // the command follows it. A tail scan reports empty-fork-range.
    const session = fakeSession(
      [
        { type: 'user/message' },        // 0: inherited
        { type: 'session/end-seed' },    // 1: inherited (parent's history)
        { type: 'user/message' },        // 2: inherited
        { type: 'user/message' },        // 3: inherited
        { type: 'session/end-seed' },    // 4: construction
        { type: 'user/message' },        // 5: own work
        { type: 'user/message' },        // 6: own work
        { type: 'session/end-seed' },    // 7: resume before the command
      ],
      [0, 2, 3, 5, 6],
      4,
    )
    expect(postForkRange(session)).toEqual({ start: 5, end: 6 })
  })

  test('a root session fails with missing-seed-boundary even with resume markers', () => {
    const session = fakeSession(
      [
        { type: 'user/message' },
        { type: 'session/end-seed' },    // the root's own resume marker
        { type: 'user/message' },
      ],
      [0, 2],
      null,
    )
    expect(codeOf(() => postForkRange(session))).toBe('missing-seed-boundary')
  })

  test('an absorbed seed marker (seed slice already ends with one) anchors the boundary', () => {
    // The constructor skips re-marking a seed that ends with an end-seed;
    // that trailing marker is the boundary — a later resume must not win.
    const session = fakeSession(
      [
        { type: 'user/message' },        // 0: inherited
        { type: 'session/end-seed' },    // 1: the seed's trailing marker
        { type: 'user/message' },        // 2: own work
        { type: 'session/end-seed' },    // 3: later resume
        { type: 'user/message' },        // 4: own work after resume
      ],
      [0, 2, 4],
      2,
    )
    expect(postForkRange(session)).toEqual({ start: 2, end: 4 })
  })
})

describe('extractCheckpointMessage', () => {
  test('returns the newest checkpoint node on the surface', () => {
    const stale = checkpointUserMessage('old-compaction', 'older summary')
    const fresh = checkpointUserMessage('new-compaction', 'fresh summary')
    const session = fakeSession(
      [
        { type: 'user/message', data: { message: stale } },
        { type: 'session/end-seed' },
        { type: 'user/message', data: { message: fresh } },
      ],
      [0, 2],
    )
    expect(extractCheckpointMessage(session)).toBe(fresh)
  })

  test('skips non-checkpoint nodes and non-message events', () => {
    const fresh = checkpointUserMessage('new-compaction', 'fresh summary')
    const plain = createUserMessage({
      content: [{ type: 'text', text: 'ordinary' }],
      source: { kind: 'user' },
    })
    const session = fakeSession(
      [
        { type: 'user/message', data: { message: plain } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'assistant' }] } } },
        { type: 'session/end-seed' },
        { type: 'user/message', data: { message: fresh } },
      ],
      [0, 1, 3],
    )
    expect(extractCheckpointMessage(session)).toBe(fresh)
  })

  test('no checkpoint fails with checkpoint-not-found', () => {
    const plain = createUserMessage({
      content: [{ type: 'text', text: 'ordinary' }],
      source: { kind: 'user' },
    })
    const session = fakeSession(
      [
        { type: 'user/message', data: { message: plain } },
        { type: 'session/end-seed' },
      ],
      [0],
    )
    expect(codeOf(() => extractCheckpointMessage(session))).toBe('checkpoint-not-found')
  })
})

describe('turnRangeOf', () => {
  test('min/max over events that carry a turn, ignoring the rest', () => {
    const session = fakeSession(
      [
        { type: 'user/message' },
        { type: 'assistant/message', data: { turn: 4, step: 1 } },
        { type: 'tool/result', data: { turn: 2, step: 1 } },
        { type: 'assistant/message', data: { turn: 6, step: 2 } },
      ],
      [0, 1, 2, 3],
    )
    expect(turnRangeOf(session, [1, 2, 3])).toEqual({ start: 2, end: 6 })
    expect(turnRangeOf(session, [1])).toEqual({ start: 4, end: 4 })
  })

  test('undefined when no shadowed event carries a turn', () => {
    const session = fakeSession([{ type: 'user/message' }, { type: 'user/message' }], [0, 1])
    expect(turnRangeOf(session, [0, 1])).toBeUndefined()
    expect(turnRangeOf(session, [])).toBeUndefined()
  })
})

describe('buildMergeCheckpoint', () => {
  const checkpoint = checkpointUserMessage('child-compaction', 'the conclusion')
  const names = { child: 'review', target: 'main' }

  test('wraps the checkpoint payload in the squash envelope, keeping the compaction checkpoint marker', () => {
    const merged = buildMergeCheckpoint(checkpoint, {
      // Deliberate turn numbers: the preamble must speak turns, the source
      // keeps only the compaction identity.
      turnRange: { start: 2, end: 5 },
      compactionId: CompactionId('child-compaction'),
    }, names)
    expect(merged.role).toBe('user')
    const text = merged.content.find(b => b.type === 'text')?.text ?? ''
    expect(text.startsWith(
      'This is a squash from branch "review" (covering its turns 2–5) into branch "main". ',
    )).toBe(true)
    expect(text).toContain('<branch-squash>\nthe conclusion\n</branch-squash>')
    // Guard compatibility: plugin must stay 'compact' so official consumers
    // keep recognizing this node as a compaction checkpoint.
    expect(isCompactCheckpointSource(merged.source)).toBe(true)
    // The source stays inside the frozen plugin-source vocabulary: exactly
    // the official compaction-checkpoint members, notice-formed for the UI
    // row — no fork-merge extensions (they would make the log unloadable
    // under the format read path; 2026-09-05 incident).
    expect(merged.source).toEqual(compactCheckpointSource(CompactionId('child-compaction')))
  })

  test('omits the range clause when no turn range is known', () => {
    const merged = buildMergeCheckpoint(checkpoint, {
      compactionId: CompactionId('child-compaction'),
    }, names)
    const text = merged.content.find(b => b.type === 'text')?.text ?? ''
    expect(text.startsWith('This is a squash from branch "review" into branch "main". ')).toBe(true)
  })

  test('non-text checkpoint blocks surface as opaque placeholders instead of vanishing', () => {
    const mixed = createUserMessage({
      content: [
        { type: 'text', text: 'the conclusion' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' } as never,
      ],
      source: compactCheckpointSource(CompactionId('child-compaction')),
    })
    const merged = buildMergeCheckpoint(mixed, {
      compactionId: CompactionId('child-compaction'),
    }, names)
    const text = merged.content.find(b => b.type === 'text')?.text ?? ''
    expect(text).toContain('<branch-squash>\nthe conclusion\n(opaque image block)\n</branch-squash>')
  })

  test('records the initiating command id when present', () => {
    const merged = buildMergeCheckpoint(checkpoint, {
      compactionId: CompactionId('child-compaction'),
      sourceCommandId: 'cmd-7' as CommandId,
    }, names)
    const source = merged.source as ReturnType<typeof compactCheckpointSource>
    expect(source.sourceCommandId).toBe('cmd-7')
    expect(isCompactCheckpointSource(merged.source)).toBe(true)
  })
})

describe('squashErrorText', () => {
  test('maps every ManualCompactionErrorCode to the mirrored wording', () => {
    expect(squashErrorText('busy')).toBe(
      'Squash is unavailable because this process has an active compaction, or the agent is not idle.',
    )
    expect(squashErrorText('cancelled')).toBe('Squash cancelled.')
    expect(squashErrorText('changed')).toBe(
      'The history selected for squash changed before it could be replaced. The conversation is unchanged; the attempt is recorded in the session log.',
    )
    expect(squashErrorText('summary')).toBe(
      'Squash could not produce a useful summary. The conversation is unchanged; the attempt is recorded in the session log.',
    )
    expect(squashErrorText('commit')).toBe(
      'Squash did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.',
    )
    expect(squashErrorText('persistence')).toBe('Squash finished, but the session could not be saved.')
  })

  test('covers the whole closed union', () => {
    const codes: ManualCompactionErrorCode[] = ['busy', 'cancelled', 'changed', 'summary', 'commit', 'persistence']
    for (const code of codes) {
      expect(squashErrorText(code).length).toBeGreaterThan(0)
    }
  })

  test('the summary wording carries the v0.1.x rebased-into-hint TODO', () => {
    const source = readFileSync(new URL('../src/squash.ts', import.meta.url), 'utf8')
    expect(source).toContain('TODO(v0.1.x)')
  })
})
