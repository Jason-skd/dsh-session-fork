/**
 * Tests for the /rebase command layer: parsing and the execution pipeline
 * over fake agents/sessions and a memory registry store, no cordis. The
 * load-bearing assertions: NO busy gate on the target (issue #27 sibling
 * semantics), transport is `inject`, source is never mutated.
 * @module dsh-session-fork/tests/rebased-into-command.test
 */

import { describe, expect, test } from 'bun:test'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { executeRebasedIntoAction, parseRebasedIntoAction } from '../src/rebased-into-command.js'
import type { RebasedIntoAgent, RebasedIntoCommandDeps } from '../src/rebased-into-command.js'
import type { RegistryState, RegistryStore } from '../src/types.js'

/** One raw fake log event; its array index becomes its seq. */
interface FakeEvent {
  type: string
  data?: unknown
}

function fakeSession(header: Partial<SessionHeader>, rawEvents: readonly FakeEvent[]): Session {
  const events = rawEvents.map((raw, seq) => ({ seq, ...raw })) as unknown as SessionEvent[]
  return {
    id: header.id,
    header,
    inheritedEventCount: header.inheritedEventCount ?? 0,
    snapshotEvents: () => Object.freeze([...events]),
    eventAt: (seq: number) => events[seq],
    get seq() { return events.length },
    surface: { nodes: rawEvents.map((_, i) => i).filter(i => events[i]!.type !== 'session/end-seed'), replaceGeneration: 1 },
    deriveEventMessage(event: SessionEvent) {
      if (event.type !== 'user/message') return null
      return (event.data as { message?: unknown } | undefined)?.message as never ?? null
    },
  } as unknown as Session
}

/** A fake agent recording inject calls; phase kind is configurable. */
function fakeAgent(session: Session, phaseKind: string, injected: UserMessage[]): RebasedIntoAgent {
  return {
    session,
    status: phaseKind,
    inject: (message: UserMessage) => { injected.push(message) },
  } as unknown as RebasedIntoAgent
}

function memoryStore(initial: RegistryState): RegistryStore {
  let state: RegistryState | null = initial
  return {
    load: async () => state,
    save: async (next) => { state = next },
  }
}

const CHILD_SESSION_ID = 'session-child'
const TARGET_SESSION_ID = 'session-target'

function registryFixture(): RegistryState {
  return {
    branches: {
      review: {
        name: 'review',
        sessionId: CHILD_SESSION_ID,
        // 'main' is review's actual fork parent, so the happy path exercises
        // the direct-parent lineage (seed boundary excludes the prefix).
        forkOrigin: { parentSessionId: TARGET_SESSION_ID, atSeq: 0 },
      },
      main: { name: 'main', sessionId: TARGET_SESSION_ID, forkOrigin: null },
    },
  }
}

/** The source fixture: an inherited prefix, the seed boundary, one own turn. */
function sourceFixture(): Session {
  return fakeSession(
    { id: CHILD_SESSION_ID, parentSession: 'session-parent', isSeeded: true, inheritedEventCount: 1 },
    [
      {
        type: 'user/message',
        data: {
          message: createUserMessage({
            content: [{ type: 'text', text: 'inherited prompt' }],
            source: { kind: 'user' },
          }),
        },
      },
      { type: 'session/end-seed' },
      {
        type: 'user/message',
        data: {
          message: createUserMessage({
            content: [{ type: 'text', text: 'own prompt' }],
            source: { kind: 'user' },
          }),
        },
      },
    ],
  )
}

/** Default deps: idle source, resolving target, recording flush calls. */
function depsFixture(source: RebasedIntoAgent, target: RebasedIntoAgent, flushed: unknown[]): RebasedIntoCommandDeps {
  return {
    sourceAgent: source,
    store: memoryStore(registryFixture()),
    resolveTargetAgent: async () => target,
    flush: async (agent) => { flushed.push(agent) },
  }
}

describe('parseRebasedIntoAction', () => {
  test('accepts the squash-aligned `into <branch>` phrasing', () => {
    expect(parseRebasedIntoAction('into main')).toEqual({ kind: 'rebased-into', target: 'main' })
    expect(parseRebasedIntoAction(' into  main ')).toEqual({ kind: 'rebased-into', target: 'main' })
  })
  test('usage on a bare branch name (the target must be introduced by into)', () => {
    expect(parseRebasedIntoAction(' main ').kind).toBe('usage')
  })
  test('usage on empty input', () => {
    expect(parseRebasedIntoAction('  ').kind).toBe('usage')
  })
  test('usage on extra arguments', () => {
    expect(parseRebasedIntoAction('main extra').kind).toBe('usage')
  })
})

describe('executeRebasedIntoAction', () => {
  test('happy path: injects one envelope into the target, flushes, never touches the source', async () => {
    const injected: UserMessage[] = []
    const flushed: unknown[] = []
    const source = fakeAgent(sourceFixture(), 'idle', [])
    const target = fakeAgent(fakeSession({ id: TARGET_SESSION_ID }, []), 'idle', injected)
    const result = await executeRebasedIntoAction(
      { kind: 'rebased-into', target: 'main' },
      depsFixture(source, target, flushed),
    )
    expect(result.kind).toBe('success')
    expect(injected).toHaveLength(1)
    expect(flushed).toHaveLength(1)
    const text = (injected[0]!.content[0] as { text: string }).text
    expect(text).toContain('<branch-rebased-into>')
    expect(text).toContain('from branch "review"')
    expect(text).toContain('into branch "main"')
    expect(text).toContain('own prompt')
    // The inherited prefix must NOT ride along.
    expect(text).not.toContain('inherited prompt')
  })

  test('NO busy gate: a running target still receives the transcript', async () => {
    const injected: UserMessage[] = []
    const flushed: unknown[] = []
    const source = fakeAgent(sourceFixture(), 'idle', [])
    const busyTarget = fakeAgent(fakeSession({ id: TARGET_SESSION_ID }, []), 'running', injected)
    const result = await executeRebasedIntoAction(
      { kind: 'rebased-into', target: 'main' },
      depsFixture(source, busyTarget, flushed),
    )
    expect(result.kind).toBe('success')
    expect(injected).toHaveLength(1)
  })

  test('refuses a non-idle source', async () => {
    const injected: UserMessage[] = []
    const source = fakeAgent(sourceFixture(), 'running', [])
    const target = fakeAgent(fakeSession({ id: TARGET_SESSION_ID }, []), 'idle', injected)
    const result = await executeRebasedIntoAction(
      { kind: 'rebased-into', target: 'main' },
      depsFixture(source, target, []),
    )
    expect(result.kind).toBe('error')
    expect(injected).toHaveLength(0)
  })

  test('unknown target branch', async () => {
    const source = fakeAgent(sourceFixture(), 'idle', [])
    const target = fakeAgent(fakeSession({ id: TARGET_SESSION_ID }, []), 'idle', [])
    const result = await executeRebasedIntoAction(
      { kind: 'rebased-into', target: 'nope' },
      depsFixture(source, target, []),
    )
    expect(result.kind).toBe('error')
    expect((result as { text: string }).text).toContain("no branch named 'nope'")
  })

  test('a branch cannot be rebased into itself', async () => {
    const source = fakeAgent(sourceFixture(), 'idle', [])
    const target = fakeAgent(fakeSession({ id: TARGET_SESSION_ID }, []), 'idle', [])
    const deps = depsFixture(source, target, [])
    const result = await executeRebasedIntoAction(
      { kind: 'rebased-into', target: 'review' },
      { ...deps, store: memoryStore(registryFixture()) },
    )
    expect(result.kind).toBe('error')
    expect((result as { text: string }).text).toContain('itself')
  })

  test('an unregistered session is rejected (register before transferring)', async () => {
    const root = fakeSession({ id: 'session-root' }, [])
    const source = fakeAgent(root, 'idle', [])
    const target = fakeAgent(fakeSession({ id: TARGET_SESSION_ID }, []), 'idle', [])
    const result = await executeRebasedIntoAction(
      { kind: 'rebased-into', target: 'main' },
      depsFixture(source, target, []),
    )
    expect(result.kind).toBe('error')
    expect((result as { text: string }).text).toContain('not registered as a branch')
  })

  test('a registered root branch may rebase with no shared lineage (issue #4 pilot)', async () => {
    // The generalization: the source no longer needs a fork parent. Two
    // adopted roots carry no common ancestor, so the whole source
    // conversation transfers (merge-region 'unrelated').
    const DRAFT_ID = 'session-draft'
    const state = registryFixture()
    state.branches.draft = { name: 'draft', sessionId: DRAFT_ID, forkOrigin: null }
    const draft = fakeSession(
      { id: DRAFT_ID },
      [
        {
          type: 'user/message',
          data: {
            message: createUserMessage({
              content: [{ type: 'text', text: 'draft work one' }],
              source: { kind: 'user' },
            }),
          },
        },
        {
          type: 'user/message',
          data: {
            message: createUserMessage({
              content: [{ type: 'text', text: 'draft work two' }],
              source: { kind: 'user' },
            }),
          },
        },
      ],
      [0, 1],
    )
    const injected: UserMessage[] = []
    const source = fakeAgent(draft, 'idle', injected)
    const target = fakeAgent(fakeSession({ id: TARGET_SESSION_ID }, []), 'idle', [])
    const result = await executeRebasedIntoAction(
      { kind: 'rebased-into', target: 'main' },
      { ...depsFixture(source, target, injected), store: memoryStore(state) },
    )
    expect(result.kind).toBe('success')
    expect((result as { text: string }).text).toContain('no shared lineage')
    expect(injected).toHaveLength(1)
  })
})
