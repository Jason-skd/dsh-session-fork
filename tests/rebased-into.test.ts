/**
 * Tests for the pure rebase logic: verbatim transcript serialization of a
 * pre-decided region. The region itself lives in merge-region.ts and has its
 * own test file (merge-region.test.ts).
 *
 * Pure: no cordis, fake session objects.
 * @module dsh-session-fork/tests/rebased-into.test
 */

import { describe, expect, test } from 'bun:test'
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { serializeTranscript } from '../src/rebased-into.js'

interface FakeEvent {
  type: string
  data?: unknown
}

function fakeSession(rawEvents: readonly FakeEvent[], surfaceSeqs: readonly number[]): Session {
  const events = rawEvents.map((raw, seq) => ({ seq, ...raw })) as unknown as SessionEvent[]
  const deriveEventMessage = (event: SessionEvent): Message | null => {
    const data = event.data as { message?: Message } | undefined
    return data?.message ?? null
  }
  return {
    snapshotEvents: () => Object.freeze([...events]),
    eventAt: (seq: number) => events[seq],
    get seq() { return events.length },
    surface: { nodes: [...surfaceSeqs], replaceGeneration: 1 },
    deriveEventMessage,
  } as unknown as Session
}

function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('serializeTranscript', () => {
  test('renders every message verbatim, in order, with role prefixes', () => {
    const session = fakeSession(
      [
        { type: 'user/message' },
        { type: 'session/end-seed' },
        { type: 'user/message', data: { message: userMessage('do the thing'), turn: 1 } },
        {
          type: 'assistant/message',
          data: {
            message: {
              id: 'm1',
              role: 'assistant',
              content: [
                { type: 'reasoning', text: 'think it through' },
                { type: 'text', text: 'working on it' },
                { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
              ],
              source: { kind: 'model', provider: 'p', model: 'm' },
            },
          },
        },
        {
          type: 'tool/result',
          data: {
            message: {
              id: 'm2',
              role: 'tool',
              toolCallId: 'call-1',
              content: [{ type: 'text', text: 'file-a file-b' }],
              source: { kind: 'tool', callId: 'call-1' },
            },
          },
        },
      ],
      [0, 2, 3, 4],
    )
    const transcript = serializeTranscript(session, { start: 2, end: 4 })
    expect(transcript.nodeCount).toBe(3)
    expect(transcript.turns).toEqual({ start: 1, end: 1 })
    expect(transcript.text).toContain('user: do the thing')
    expect(transcript.text).toContain('assistant: (thinking) think it through')
    expect(transcript.text).toContain('working on it')
    expect(transcript.text).toContain('tool call bash({"command":"ls"})')
    expect(transcript.text).toContain('tool result for call call-1:')
    expect(transcript.text).toContain('file-a file-b')
    expect(transcript.text.indexOf('do the thing')).toBeLessThan(transcript.text.indexOf('working on it'))
  })

  test('marks an errored tool result', () => {
    const session = fakeSession(
      [
        { type: 'session/end-seed' },
        {
          type: 'tool/result',
          data: {
            message: {
              id: 'm1',
              role: 'tool',
              toolCallId: 'c',
              isError: true,
              content: [{ type: 'text', text: 'boom' }],
              source: { kind: 'tool', callId: 'c' },
            },
          },
        },
      ],
      [1],
    )
    const transcript = serializeTranscript(session, { start: 1, end: 1 })
    expect(transcript.text).toContain('tool result (error)')
  })

  test('an opaque plugin block states its type instead of vanishing', () => {
    const session = fakeSession(
      [
        { type: 'session/end-seed' },
        {
          type: 'user/message',
          data: {
            message: {
              id: 'm1',
              role: 'user',
              content: [{ type: 'custom-widget' } as never],
              source: { kind: 'user' },
            },
          },
        },
      ],
      [1],
    )
    const transcript = serializeTranscript(session, { start: 1, end: 1 })
    expect(transcript.text).toContain('(opaque custom-widget block)')
  })

  test('omits turn coordinates when no event carries a turn', () => {
    const session = fakeSession(
      [
        { type: 'session/end-seed' },
        { type: 'user/message', data: { message: userMessage('hello') } },
      ],
      [1],
    )
    expect(serializeTranscript(session, { start: 1, end: 1 }).turns).toEqual({})
  })
})
