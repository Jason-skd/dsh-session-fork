/**
 * Tests for the /squash command layer: parsing and the execution pipeline
 * over fake agents/sessions and a memory registry store, no cordis.
 * @module dsh-session-fork/tests/squash-command.test
 */

import { describe, expect, test } from 'bun:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CompactionId, compactCheckpointSource, isCompactCheckpointSource, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { executeSquashAction, parseSquashAction } from '../src/squash-command.js'
import type { SquashCommandDeps } from '../src/squash-command.js'
import type { RegistryState, RegistryStore } from '../src/types.js'

/** One raw fake log event; its array index becomes its seq. */
interface FakeEvent {
  type: string
  data?: unknown
}

/** A fake session with header lineage and, optionally, an append recorder. */
function fakeSession(
  header: Partial<SessionHeader>,
  rawEvents: readonly FakeEvent[],
  surfaceSeqs: readonly number[],
  appended?: unknown[],
): Session {
  const events = rawEvents.map((raw, seq) => ({ seq, ...raw })) as unknown as SessionEvent[]
  const session = {
    id: header.id,
    header,
    inheritedEventCount: header.inheritedEventCount ?? 0,
    snapshotEvents: () => Object.freeze([...events]),
    eventAt: (seq: number) => events[seq],
    get seq() { return events.length },
    surface: { nodes: [...surfaceSeqs], replaceGeneration: 1 },
    deriveEventMessage(event: SessionEvent) {
      if (event.type !== 'user/message') return null
      const data = event.data as { message?: unknown } | undefined
      return (data?.message ?? null) as never
    },
    ...(appended === undefined ? {} : {
      append(type: string, data: unknown, opts: unknown) {
        appended.push({ type, data, opts })
        return { seq: 99, type, data }
      },
    }),
  }
  return session as unknown as Session
}

/** A checkpoint user message like the one a completed compaction lands. */
function checkpointUserMessage(compactionId: string, text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: compactCheckpointSource(CompactionId(compactionId)),
  })
}

/** Minimal fake agent around a session, a status, and an inject spy. */
function fakeAgent(session: Session, phaseKind: string): Agent & { injected: UserMessage[] } {
  const injected: UserMessage[] = []
  return {
    session,
    status: phaseKind,
    injected,
    inject(message: UserMessage) { injected.push(message) },
  } as unknown as Agent & { injected: UserMessage[] }
}

/** A memory registry store over one mutable state. */
function memoryStore(initial: RegistryState): RegistryStore {
  let state: RegistryState | null = initial
  return {
    load: async () => state,
    save: async (next) => { state = next },
  }
}

const MAIN_RECORD = {
  name: 'main',
  sessionId: 'session-parent',
  forkOrigin: null,
}

/** The child fixture's own registry record (registered as 'review'). */
const REVIEW_RECORD = {
  name: 'review',
  sessionId: 'session-child',
  forkOrigin: { parentSessionId: 'session-parent', atSeq: 1 },
}

/** The child fixture: seed prefix, seed boundary, two post-fork nodes, and the compaction's landed checkpoint as the surface tail. */
function childFixture(): Session {
  return fakeSession(
    { parentSession: 'session-parent', isSeeded: true, inheritedEventCount: 2, id: 'session-child' },
    [
      { type: 'user/message' },
      { type: 'session/end-seed' },
      { type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [] } } },
      { type: 'user/message', data: { message: checkpointUserMessage('compaction-1', 'summary body') } },
    ],
    [0, 2, 3],
  )
}

const FAKE_RESULT = {
  compactionId: CompactionId('compaction-1'),
  startSeq: 4,
  summarySeq: 6,
  endSeq: 8,
  summary: [],
  shadowedRange: { start: 2, end: 3 },
  shadowedSeqs: [2, 3],
  shadowedTokenCount: 42,
} as CompactionResult

describe('parseSquashAction', () => {
  test('parses into <branch>', () => {
    expect(parseSquashAction('  into   main ')).toEqual({ kind: 'squash', target: 'main' })
  })

  test('empty input is usage', () => {
    expect(parseSquashAction('')).toEqual({ kind: 'usage', problem: 'missing target branch' })
  })

  test('missing into keyword is usage', () => {
    expect(parseSquashAction('main')).toEqual({ kind: 'usage', problem: `expected 'into <branch>', got 'main'` })
  })

  test('into without a name is usage', () => {
    expect(parseSquashAction('into')).toEqual({ kind: 'usage', problem: `'into' needs a branch name` })
  })

  test('into with extra tokens is usage', () => {
    expect(parseSquashAction('into a b')).toEqual({ kind: 'usage', problem: `'into' takes exactly one branch name` })
  })
})

describe('executeSquashAction', () => {
  /** Assemble deps around fixture parts; every part is overridable. */
  function makeDefs(overrides: Partial<SquashCommandDeps> = {}): {
    deps: SquashCommandDeps
    flushed: Agent[]
    compactCalls: unknown[]
    parentAgent: Agent & { injected: UserMessage[] }
  } {
    const flushed: Agent[] = []
    const compactCalls: unknown[] = []
    const childAgent = fakeAgent(childFixture(), 'idle')
    const parentAgent = fakeAgent(
      fakeSession({ id: 'session-parent' }, [{ type: 'user/message' }], [0]),
      'idle',
    )
    const deps: SquashCommandDeps = {
      childAgent,
      signal: new AbortController().signal,
      store: memoryStore({ branches: { main: MAIN_RECORD, review: REVIEW_RECORD } }),
      compact: async (agent, signal, request) => {
        compactCalls.push({ agent, signal, request })
        return FAKE_RESULT
      },
      resolveTargetAgent: async () => parentAgent,
      flush: async (agent) => { flushed.push(agent) },
      ...overrides,
    }
    return { deps, flushed, compactCalls, parentAgent }
  }

  test('squashes the post-fork region and queues the merge envelope into the parent', async () => {
    const { deps, flushed, compactCalls, parentAgent } = makeDefs()
    const result = await executeSquashAction({ kind: 'squash', target: 'main' }, deps)
    expect(result.kind).toBe('success')
    expect(result.kind === 'success' && result.text).toContain(`into branch 'main' as one checkpoint`)

    // The compaction request names exactly the post-fork region.
    expect(compactCalls.length).toBe(1)
    const request = (compactCalls[0] as { request: { start: number; end: number } }).request
    expect(request).toMatchObject({ start: 2, end: 3 })

    // The parent received exactly one injected message through the public
    // queue API: the merge envelope, still recognized as a compaction
    // checkpoint, with the source inside the frozen plugin vocabulary.
    expect(parentAgent.injected.length).toBe(1)
    const injected = parentAgent.injected[0]!
    expect(injected.role).toBe('user')
    // The merge message is a squash envelope naming both branches.
    const body = injected.content.find(b => b.type === 'text')?.text ?? ''
    expect(body.startsWith('This is a squash from branch "review" (covering its turns 2–2) into branch "main". ')).toBe(true)
    expect(body).toContain('<branch-squash>\nsummary body\n</branch-squash>')
    const source = injected.source as Record<string, unknown>
    expect(isCompactCheckpointSource(injected.source)).toBe(true)
    expect(Object.keys(source).sort()).toEqual(['compactionId', 'kind'])
    expect(source.compactionId).toBe('compaction-1')

    // The parent was flushed (and the child flushed through the compact
    // request's durability hook).
    expect(flushed.length).toBe(1)
    expect(flushed[0]).toBe(parentAgent)
  })

  test('a busy child fails fast with the squash busy wording', async () => {
    const { deps } = makeDefs()
    ;(deps.childAgent as unknown as { status: string }).status = 'running'
    const result = await executeSquashAction({ kind: 'squash', target: 'main' }, deps)
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.text).toContain('not idle')
  })

  test('an unregistered source session is rejected before compaction', async () => {
    const child = fakeAgent(
      fakeSession({ id: 'session-root' }, [{ type: 'user/message' }, { type: 'session/end-seed' }, { type: 'user/message' }], [0, 2]),
      'idle',
    )
    const { deps } = makeDefs({ childAgent: child })
    const result = await executeSquashAction({ kind: 'squash', target: 'main' }, deps)
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.text).toContain('branch name')
  })

  test('an unknown target branch is rejected', async () => {
    const { deps } = makeDefs()
    const result = await executeSquashAction({ kind: 'squash', target: 'nope' }, deps)
    expect(result.kind === 'error' && result.text).toContain(`no branch named 'nope'`)
  })

  test('squashing a branch into itself is rejected', async () => {
    const { deps } = makeDefs()
    const result = await executeSquashAction({ kind: 'squash', target: 'review' }, deps)
    expect(result.kind === 'error' && result.text).toContain('into itself')
  })

  test('a ManualCompactionError maps to its user text', async () => {
    const { deps } = makeDefs({
      compact: async () => { throw new ManualCompactionError('summary', 'not smaller') },
    })
    const result = await executeSquashAction({ kind: 'squash', target: 'main' }, deps)
    expect(result.kind === 'error')
    expect(result.kind === 'error' && result.text).toContain('could not produce a useful summary')
  })

  test('a busy parent no longer blocks delivery (queue model, issue #27)', async () => {
    const busyParent = fakeAgent(
      fakeSession({ id: 'session-parent' }, [{ type: 'user/message' }], [0]),
      'running',
    )
    const { deps, flushed } = makeDefs({ resolveTargetAgent: async () => busyParent })
    const result = await executeSquashAction({ kind: 'squash', target: 'main' }, deps)
    expect(result.kind).toBe('success')
    // The envelope was queued through inject and still flushed durably.
    expect(busyParent.injected.length).toBe(1)
    expect(busyParent.injected[0]!.content.find(b => b.type === 'text')?.text).toContain('<branch-squash>')
    expect(flushed.length).toBe(1)
    expect(flushed[0]).toBe(busyParent)
  })

  test('an unregistered child session is rejected before compaction', async () => {
    const child = fakeAgent(
      fakeSession(
        { parentSession: 'session-parent', isSeeded: true, inheritedEventCount: 2, id: 'session-child' },
        [
          { type: 'user/message' },
          { type: 'session/end-seed' },
          { type: 'user/message' },
        ],
        [0, 2],
      ),
      'idle',
    )
    const { deps } = makeDefs({ childAgent: child, store: memoryStore({ branches: { main: MAIN_RECORD } }) })
    const result = await executeSquashAction({ kind: 'squash', target: 'main' }, deps)
    expect(result.kind === 'error' && result.text).toContain('branch name')
  })

  // Issue #21: any two registered branches. Five-relation coverage over one
  // source fixture (surface seqs [0, 2, 3], seed boundary at seq 1): each
  // kinship must hand the vendored compaction engine exactly the
  // merge-region authority's start/end for that relation, and the checkpoint
  // lands in the TARGET branch's inbox.
  describe('any-two-branch targets (issue #21)', () => {
    interface RunOutcome {
      result: Awaited<ReturnType<typeof executeSquashAction>>
      target: Agent & { injected: UserMessage[] }
      request?: { start: number; end: number }
    }

    /** Run the pipeline over the standard child fixture with a custom registry. */
    async function runInto(state: RegistryState, targetName: string): Promise<RunOutcome> {
      const target = fakeAgent(fakeSession({ id: 'the-target' }, [{ type: 'user/message' }], [0]), 'idle')
      const compactCalls: { request: { start: number; end: number } }[] = []
      const deps: SquashCommandDeps = {
        childAgent: fakeAgent(childFixture(), 'idle'),
        signal: new AbortController().signal,
        store: memoryStore(state),
        compact: async (agent, signal, request) => {
          compactCalls.push({ agent, signal, request } as never)
          return FAKE_RESULT
        },
        resolveTargetAgent: async () => target,
        flush: async () => { },
      }
      const result = await executeSquashAction({ kind: 'squash', target: targetName }, deps)
      return { result, target, request: compactCalls[0]?.request }
    }

    // main(s-a) ← dev(s-d, forked at seq 1) ← review(session-child, forked at seq 0).
    const NESTED_STATE = (): RegistryState => ({
      branches: {
        main: { name: 'main', sessionId: 's-a', forkOrigin: null },
        dev: { name: 'dev', sessionId: 's-d', forkOrigin: { parentSessionId: 's-a', atSeq: 1 } },
        review: { name: 'review', sessionId: 'session-child', forkOrigin: { parentSessionId: 's-d', atSeq: 0 } },
      },
    })

    test('direct-parent regression: the seed-boundary region is unchanged', async () => {
      const { result, target, request } = await runInto(NESTED_STATE(), 'dev')
      expect(result.kind).toBe('success')
      // review's seed boundary sits at seq 1 → region = surface seqs > 1.
      expect(request).toMatchObject({ start: 2, end: 3 })
      expect(target.injected.length).toBe(1)
    })

    test('deeper ancestor: region = source content since leaving main', async () => {
      // review left main's lineage when dev forked at seq 1 → seqs > 1.
      const { result, request } = await runInto(NESTED_STATE(), 'main')
      expect(result.kind).toBe('success')
      expect(request).toMatchObject({ start: 2, end: 3 })
    })

    test('relative: region = source content since leaving the LCA', async () => {
      const state = NESTED_STATE()
      // A sibling of review, also forked off dev → LCA = dev, review left
      // dev at seq 0 → region = surface seqs > 0 (the inherited seq-0 node
      // is dev's own content, already on the target's side of the LCA).
      state.branches['other'] = {
        name: 'other',
        sessionId: 's-l',
        forkOrigin: { parentSessionId: 's-d', atSeq: 2 },
      }
      const { result, request } = await runInto(state, 'other')
      expect(result.kind).toBe('success')
      expect(request).toMatchObject({ start: 2, end: 3 })
    })

    test('source-ancestor: region = source content the descendant lacks', async () => {
      const state: RegistryState = {
        branches: {
          main: { name: 'main', sessionId: 'session-child', forkOrigin: null },
          kid: { name: 'kid', sessionId: 's-kid', forkOrigin: { parentSessionId: 'session-child', atSeq: 1 } },
        },
      }
      // The target left this branch at seq 1 → region = seqs > 1.
      const { result, request } = await runInto(state, 'kid')
      expect(result.kind).toBe('success')
      expect(request).toMatchObject({ start: 2, end: 3 })
    })

    test('unrelated: the whole conversation transfers', async () => {
      const state: RegistryState = {
        branches: {
          review: { name: 'review', sessionId: 'session-child', forkOrigin: { parentSessionId: 's-gone', atSeq: 0 } },
          stranger: { name: 'stranger', sessionId: 's-z', forkOrigin: { parentSessionId: 's-other', atSeq: 0 } },
        },
      }
      const { result, request } = await runInto(state, 'stranger')
      expect(result.kind).toBe('success')
      expect(request).toMatchObject({ start: 0, end: 3 })
    })

    test('the envelope names both branches regardless of kinship', async () => {
      const state: RegistryState = {
        branches: {
          review: { name: 'review', sessionId: 'session-child', forkOrigin: { parentSessionId: 's-gone', atSeq: 0 } },
          stranger: { name: 'stranger', sessionId: 's-z', forkOrigin: null },
        },
      }
      const { target } = await runInto(state, 'stranger')
      const body = target.injected[0]!.content.find(b => b.type === 'text')?.text ?? ''
      expect(body.startsWith('This is a squash from branch "review" ')).toBe(true)
      expect(body).toContain('into branch "stranger"')
    })
  })
})
