/**
 * Tests for the send-message executor (issue #47): registry-named
 * addressing, fail-fast refusals BEFORE any delivery, the waking `steer`
 * transport (never `inject`), no busy gate on the target, and no gate on
 * the sender either (only the sender's session id is read). Fake agents
 * and a memory registry store, no cordis.
 * @module dsh-session-fork/tests/send-message.test
 */

import { describe, expect, test } from 'bun:test'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { executeSendMessage } from '../src/send-message.js'
import type { MessageTargetAgent, SendMessageDeps } from '../src/send-message.js'
import type { RegistryState, RegistryStore } from '../src/types.js'

const SOURCE_SESSION_ID = 'session-review'
const TARGET_SESSION_ID = 'session-main'

/** The sending session: only its id is read — a bare stub suffices. */
function sourceSession(): Session {
  return { id: SOURCE_SESSION_ID } as unknown as Session
}

/** A fake target recording steer (and proving inject is never the transport). */
function fakeTarget(
  sessionId: string,
  steered: UserMessage[],
  injected: UserMessage[] = [],
): MessageTargetAgent {
  return {
    session: { id: sessionId },
    steer: (message: UserMessage) => { steered.push(message) },
    inject: (message: UserMessage) => { injected.push(message) },
  } as unknown as MessageTargetAgent
}

function memoryStore(initial: RegistryState): RegistryStore {
  let state: RegistryState | null = initial
  return {
    load: async () => state,
    save: async (next) => { state = next },
  }
}

function registryFixture(): RegistryState {
  return {
    branches: {
      review: {
        name: 'review',
        sessionId: SOURCE_SESSION_ID,
        forkOrigin: { parentSessionId: TARGET_SESSION_ID, atSeq: 0 },
      },
      main: { name: 'main', sessionId: TARGET_SESSION_ID, forkOrigin: null },
    },
  }
}

function depsFixture(
  target: MessageTargetAgent,
  flushed: unknown[],
  state: RegistryState = registryFixture(),
): SendMessageDeps {
  return {
    sourceSession: sourceSession(),
    store: memoryStore(state),
    resolveTargetAgent: async () => target,
    flush: async (agent) => { flushed.push(agent) },
  }
}

/** Extract the text block of a built user message. */
function textOf(message: UserMessage): string {
  return (message.content.find(block => block.type === 'text') as { text: string } | undefined)?.text ?? ''
}

describe('executeSendMessage', () => {
  test('happy path: one steered <branch-message> envelope, flushed once, peer-input wording', async () => {
    const steered: UserMessage[] = []
    const injected: UserMessage[] = []
    const flushed: unknown[] = []
    const result = await executeSendMessage(
      'main',
      'please process the review checkpoint you received',
      depsFixture(fakeTarget(TARGET_SESSION_ID, steered, injected), flushed),
    )
    expect(result.kind).toBe('success')
    expect(steered).toHaveLength(1)
    expect(injected).toHaveLength(0)
    expect(flushed).toHaveLength(1)
    const text = textOf(steered[0]!)
    expect(text).toContain('<branch-message>')
    expect(text.endsWith('</branch-message>')).toBe(true)
    expect(text).toContain('This is a message from branch "review" into branch "main"')
    // A message is peer input, not settled history.
    expect(text).toContain('act on it or reply as appropriate')
    expect(text).not.toContain('Treat it as established background')
    // The payload rides verbatim.
    expect(text).toContain('please process the review checkpoint you received')
    // The source stays inside the frozen plugin vocabulary; both endpoints
    // are named by the self-describing preamble (2026-09-05 re-baseline).
    const source = steered[0]!.source as Record<string, unknown>
    expect(Object.keys(source).sort()).toEqual(['form', 'kind', 'summary'])
    expect(source.kind).toBe('dsh-session-fork')
    expect(source.form).toBe('notice')
  })

  test('empty text is refused before any delivery', async () => {
    const steered: UserMessage[] = []
    const result = await executeSendMessage('main', '   ', depsFixture(fakeTarget(TARGET_SESSION_ID, steered), []))
    expect(result.kind).toBe('error')
    expect((result as { text: string }).text).toContain('empty')
    expect(steered).toHaveLength(0)
  })

  test('unknown branch name fails fast with the shared wording', async () => {
    const steered: UserMessage[] = []
    const result = await executeSendMessage('nope', 'hello', depsFixture(fakeTarget(TARGET_SESSION_ID, steered), []))
    expect(result.kind).toBe('error')
    expect((result as { text: string }).text).toContain("no branch named 'nope'")
    expect(steered).toHaveLength(0)
  })

  test('self-send is refused (misuse guard)', async () => {
    const steered: UserMessage[] = []
    const result = await executeSendMessage('review', 'note to self', depsFixture(fakeTarget(SOURCE_SESSION_ID, steered), []))
    expect(result.kind).toBe('error')
    expect((result as { text: string }).text).toContain('itself')
    expect(steered).toHaveLength(0)
  })

  test('an unregistered sender is rejected (register before messaging)', async () => {
    const steered: UserMessage[] = []
    const deps = depsFixture(fakeTarget(TARGET_SESSION_ID, steered), [])
    const result = await executeSendMessage('main', 'hello', {
      ...deps,
      sourceSession: { id: 'session-anonymous' } as unknown as Session,
    })
    expect(result.kind).toBe('error')
    expect((result as { text: string }).text).toContain('not registered as a branch')
    expect(steered).toHaveLength(0)
  })

  test('target resolution failure surfaces as an error, never a throw', async () => {
    const deps: SendMessageDeps = {
      sourceSession: sourceSession(),
      store: memoryStore(registryFixture()),
      resolveTargetAgent: async () => { throw new Error('storage offline') },
      flush: async () => undefined,
    }
    const result = await executeSendMessage('main', 'hello', deps)
    expect(result.kind).toBe('error')
    expect((result as { text: string }).text).toContain('could not open the target branch\'s session')
  })

  test('any two registered branches may message: unrelated roots included', async () => {
    const OTHER_ID = 'session-draft'
    const state = registryFixture()
    state.branches.draft = { name: 'draft', sessionId: OTHER_ID, forkOrigin: null }
    const steered: UserMessage[] = []
    const flushed: unknown[] = []
    const result = await executeSendMessage(
      'draft',
      'unrelated but registered',
      depsFixture(fakeTarget(OTHER_ID, steered), flushed, state),
    )
    expect(result.kind).toBe('success')
    expect(steered).toHaveLength(1)
    expect(textOf(steered[0]!)).toContain('from branch "review" into branch "draft"')
  })
})
