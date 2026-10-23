/**
 * Tests for the mid-turn squash handoff (src/squash-midturn.ts): the
 * unread-mail guard, the turn-ending cancellation, the deferred idle
 * execution through the unchanged executor, and the follow-up reporting —
 * over fake agents/sessions and a memory registry store, no cordis.
 * @module dsh-session-fork/tests/squash-handoff.test
 */

import { describe, expect, test } from 'bun:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ManualCompactionError, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  dispatchSquash,
  dispatchSquashAction,
  inboxPendingText,
  SQUASH_HANDOFF_CAUSE,
} from '../src/squash-midturn.js'
import type { SquashHandoffAgent, SquashHandoffDeps } from '../src/squash-midturn.js'
import type { RegistryState, RegistryStore } from '../src/types.js'

// ---------------------------------------------------------------------------
// Fixtures (mirroring tests/squash-command.test.ts so the deferred executor
// runs against the same shapes it is already tested with).
// ---------------------------------------------------------------------------

interface FakeEvent {
  type: string
  data?: unknown
}

function fakeSession(
  header: Partial<SessionHeader>,
  rawEvents: readonly FakeEvent[],
  surfaceSeqs: readonly number[],
): Session {
  const events = rawEvents.map((raw, seq) => ({ seq, ...raw })) as unknown as SessionEvent[]
  return {
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
  } as unknown as Session
}

function checkpointUserMessage(compactionId: string, text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: compactCheckpointSource(compactionId as never),
  })
}

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

const MAIN_RECORD = {
  name: 'main',
  sessionId: 'session-parent',
  forkOrigin: null,
}

const REVIEW_RECORD = {
  name: 'review',
  sessionId: 'session-child',
  forkOrigin: { parentSessionId: 'session-parent', atSeq: 1 },
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

function memoryStore(initial: RegistryState): RegistryStore {
  let state: RegistryState | null = initial
  return {
    load: async () => state,
    save: async (next) => { state = next },
  }
}

function fakeParentAgent(): Agent & { injected: UserMessage[] } {
  const injected: UserMessage[] = []
  return {
    session: fakeSession({ id: 'session-parent' }, [{ type: 'user/message' }], [0]),
    status: 'idle',
    injected,
    inject(message: UserMessage) { injected.push(message) },
  } as unknown as Agent & { injected: UserMessage[] }
}

/**
 * The fake handoff agent: a running source whose cancellation ends its turn
 * (phase flips to idle, exactly the observable consequence of the real
 * agent-loop convergence), plus spies on every handoff entry point.
 * `sessions` overrides the session object: `running` replaces the
 * dispatch-time surface (e.g. a tail inside an open step), `postCancel`
 * models what the real kernel writes when the cancelled turn closes — the
 * official `turn/end` settles the open step, so the surface becomes
 * pairable for the deferred executor.
 */
function fakeHandoffAgent(
  phaseKind: 'running' | 'idle',
  pending: { nextStep?: number; nextTurn?: number } = {},
  sessions: { running?: Session; postCancel?: Session } = {},
): SquashHandoffAgent & {
  cancels: Array<{ cause: unknown; options: unknown }>
  followups: UserMessage[]
  idleWaits: number
} {
  const cancels: Array<{ cause: unknown; options: unknown }> = []
  const followups: UserMessage[] = []
  let phase = phaseKind
  let session = sessions.running ?? childFixture()
  const nextStep = Array.from({ length: pending.nextStep ?? 0 })
  const nextTurn = Array.from({ length: pending.nextTurn ?? 0 })
  return {
    get session() { return session },
    get status() { return phase },
    inbox: {
      nextStep,
      nextTurn,
    },
    cancel(cause: unknown, options?: unknown) {
      cancels.push({ cause, options })
      phase = 'idle'
      if (sessions.postCancel !== undefined) session = sessions.postCancel
    },
    whenIdle() {
      this.idleWaits += 1
      return Promise.resolve()
    },
    followup(message: UserMessage) { followups.push(message) },
    cancels,
    followups,
    idleWaits: 0,
  } as unknown as SquashHandoffAgent & {
    cancels: Array<{ cause: unknown; options: unknown }>
    followups: UserMessage[]
    idleWaits: number
  }
}

/** Assemble handoff deps; every part overridable. */
function makeDeps(agent: ReturnType<typeof fakeHandoffAgent>, overrides: Partial<SquashHandoffDeps> = {}): {
  deps: SquashHandoffDeps
  compactCalls: unknown[]
  parentAgent: Agent & { injected: UserMessage[] }
} {
  const compactCalls: unknown[] = []
  const parentAgent = fakeParentAgent()
  const deps: SquashHandoffDeps = {
    childAgent: agent,
    signal: new AbortController().signal,
    store: memoryStore({ branches: { main: MAIN_RECORD, review: REVIEW_RECORD } }),
    compact: async (child, signal, request) => {
      compactCalls.push({ child, signal, request })
      return FAKE_RESULT
    },
    resolveTargetAgent: async () => parentAgent,
    flush: async () => {},
    ...overrides,
  }
  return { deps, compactCalls, parentAgent }
}

/**
 * A run seam that captures the continuation for awaiting in tests. `settled`
 * is a function on purpose: destructuring a getter would snapshot the
 * placeholder promise before `run` ever fired.
 */
function captureRun(): { run: (operation: Promise<void>) => void; settled(): Promise<void> } {
  let settled = Promise.resolve()
  return {
    run: (operation) => { settled = operation },
    settled: () => settled,
  }
}

describe('dispatchSquash (idle source)', () => {
  test('runs the unchanged executor synchronously — no cancel, no continuation', async () => {
    const agent = fakeHandoffAgent('idle')
    const { deps, compactCalls, parentAgent } = makeDeps(agent)
    const cap = captureRun()
    const result = await dispatchSquash('main', deps, cap.run)
    expect(result.kind).toBe('success')
    expect(compactCalls.length).toBe(1)
    expect(agent.cancels.length).toBe(0)
    expect(agent.followups.length).toBe(0)
    expect(parentAgent.injected.length).toBe(1)
  })
})

describe('dispatchSquash (running source)', () => {
  test('refuses while undelivered inbox mail is pending, ending nothing', async () => {
    const agent = fakeHandoffAgent('running', { nextStep: 1, nextTurn: 2 })
    const { deps, compactCalls } = makeDeps(agent)
    const cap = captureRun()
    const result = await dispatchSquash('main', deps, cap.run)
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.text).toBe(inboxPendingText('main', 1, 2))
    expect(result.kind === 'error' && result.text).toContain('3 undelivered inbox message(s)')
    expect(agent.cancels.length).toBe(0)
    expect(compactCalls.length).toBe(0)
    expect(agent.followups.length).toBe(0)
  })

  test('refuses a bad target before ending the turn (precheck guard)', async () => {
    const agent = fakeHandoffAgent('running')
    const { deps } = makeDeps(agent)
    const cap = captureRun()
    const result = await dispatchSquash('no-such-branch', deps, cap.run)
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.text).toContain(`no branch named 'no-such-branch'`)
    expect(agent.cancels.length).toBe(0)
  })

  test('hands off: cancels with keepInbox, runs the executor once idle, reports by follow-up', async () => {
    const agent = fakeHandoffAgent('running')
    const { deps, compactCalls, parentAgent } = makeDeps(agent)
    const cap = captureRun()
    const result = await dispatchSquash('main', deps, cap.run)
    // Immediate reply: initiated, turn handed over.
    expect(result.kind).toBe('success')
    expect(result.kind === 'success' && result.text).toContain(`initiated`)
    // The official cancellation, inbox preserved.
    expect(agent.cancels).toEqual([{ cause: SQUASH_HANDOFF_CAUSE, options: { keepInbox: true } }])
    // The continuation ran the unchanged executor after quiescence.
    await cap.settled()
    expect(agent.idleWaits).toBe(1)
    expect(compactCalls.length).toBe(1)
    expect(parentAgent.injected.length).toBe(1)
    // The follow-up reports success with the executor's own stats.
    expect(agent.followups.length).toBe(1)
    const report = agent.followups[0]!
    const text = (report.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain(`into branch 'main' as one checkpoint`)
    expect(text).toContain(`automated report`)
  })

  test('initiates despite a dispatch-time open final step — balance is re-validated after the cancellation (go-ce-v3 regression)', async () => {
    // The running source's own squash_into call keeps the surface's final
    // step open: the dispatch-time region end is STRUCTURALLY unbalanced
    // ("region end … the step is still open" — exactly the go-ce-v3
    // refusal on fix/workflow-finalize-advance, seq 47935). The precheck
    // must let it through; the executor re-validates on the
    // post-cancellation idle surface, where the cancelled turn's official
    // turn/end has closed the step.
    const running = fakeSession(
      { parentSession: 'session-parent', isSeeded: true, inheritedEventCount: 2, id: 'session-child' },
      [
        { type: 'user/message' },
        { type: 'session/end-seed' },
        { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } },
        { type: 'user/message' },
      ],
      [0, 2, 3],
    )
    const postCancel = fakeSession(
      { parentSession: 'session-parent', isSeeded: true, inheritedEventCount: 2, id: 'session-child' },
      [
        { type: 'user/message' },
        { type: 'session/end-seed' },
        { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } },
        { type: 'tool/result' },
        { type: 'user/message', data: { message: checkpointUserMessage('compaction-1', 'summary body') } },
      ],
      [0, 2, 3, 4],
    )
    const agent = fakeHandoffAgent('running', {}, { running, postCancel })
    const { deps, compactCalls, parentAgent } = makeDeps(agent)
    const cap = captureRun()
    const result = await dispatchSquash('main', deps, cap.run)
    // Not the old refusal — the handoff is initiated.
    expect(result.kind).toBe('success')
    expect(result.kind === 'success' && result.text).toContain('initiated')
    await cap.settled()
    // The executor ran against the post-cancellation surface and completed.
    expect(compactCalls.length).toBe(1)
    expect(parentAgent.injected.length).toBe(1)
    expect(agent.followups.length).toBe(1)
    const text = (agent.followups[0]!.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain(`into branch 'main' as one checkpoint`)
  })

  test('reports a failed deferred squash by follow-up with the retry hint', async () => {
    const agent = fakeHandoffAgent('running')
    const { deps } = makeDeps(agent, {
      compact: async () => {
        throw new ManualCompactionError('summary', 'summary did not get smaller')
      },
    })
    const cap = captureRun()
    const result = await dispatchSquash('main', deps, cap.run)
    expect(result.kind).toBe('success')
    await cap.settled()
    expect(agent.followups.length).toBe(1)
    const text = (agent.followups[0]!.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain(`Squash into 'main' failed`)
    expect(text).toContain(`Nothing was transferred; retry when ready.`)
  })

  test('reports an unreachable idle state instead of crashing the continuation', async () => {
    const agent = fakeHandoffAgent('running')
    const { deps, compactCalls } = makeDeps(agent)
    const handoffAgent = agent as unknown as { whenIdle(): Promise<void> }
    handoffAgent.whenIdle = () => Promise.reject(new Error('agent disposed'))
    const cap = captureRun()
    const result = await dispatchSquash('main', deps, cap.run)
    expect(result.kind).toBe('success')
    await cap.settled()
    expect(compactCalls.length).toBe(0)
    expect(agent.followups.length).toBe(1)
    const text = (agent.followups[0]!.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain(`agent disposed`)
  })
})

describe('dispatchSquashAction', () => {
  test('usage actions render the usage text without touching the agent', async () => {
    const agent = fakeHandoffAgent('running')
    const { deps } = makeDeps(agent)
    const cap = captureRun()
    const result = await dispatchSquashAction(
      { kind: 'usage', problem: 'missing target branch' },
      deps,
      cap.run,
    )
    expect(result.kind).toBe('error')
    expect(result.kind === 'error' && result.text).toContain('Usage:')
    expect(agent.cancels.length).toBe(0)
  })
})
