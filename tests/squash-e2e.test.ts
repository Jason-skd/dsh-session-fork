/**
 * End-to-end squash tests: the REAL vendored compaction engine
 * (compactNow over compactSurfaceRegion + summarizeWithLlm) running against
 * a faithful fake session/meter/LLM, then the full /squash command
 * pipeline — mapped one-to-one onto ROADMAP v0.0.3's six acceptance items.
 * @module dsh-session-fork/tests/squash-e2e.test
 */

import { describe, expect, test } from 'bun:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isCompactCheckpointSource, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenMeter, TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { BranchRegistryState } from '../src/types.js'
import { executeSquashAction } from '../src/squash-command.js'
import { postForkRange, SquashCoreError } from '../src/squash.js'
import { compactNow } from '../src/vendor/compact.js'
import type { LlmServiceLike } from '../src/vendor/compact.js'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Price helper: ~1 token per 4 characters of text content. */
function textOf(message: Message | UserMessage | undefined): string {
  if (message === undefined) return ''
  return message.content
    .filter(block => block.type === 'text')
    .map(block => (block as { text: string }).text)
    .join('')
}

function price(text: string): number {
  return Math.ceil(text.length / 4)
}

/** A deterministic structural fake of the conversation token meter. */
function fakeMeter(nodeTokensOf: (seq: number) => number, summaryPrice?: number): TokenMeter {
  return {
    measure(session: Session): TokenMeasurement {
      const nodes = session.surface.nodes.map(seq => {
        const tokens = nodeTokensOf(seq)
        return { seq, tokens, heuristicTokens: tokens }
      })
      const total = nodes.reduce((sum, node) => sum + node.tokens, 0)
      return {
        logRevision: session.seq,
        baseline: 'heuristic',
        surfaceDeltaTokens: 0,
        totalTokens: total,
        surfaceTokens: total,
        nodes,
      } as TokenMeasurement
    },
    estimateMessage(message: UserMessage): number {
      return summaryPrice ?? price(textOf(message))
    },
  } as unknown as TokenMeter
}

/** A one-shot LLM whose whole reply is fixed text; mirrors a stop-finished stream. */
function fakeLlm(summaryText: string): LlmServiceLike {
  return {
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: summaryText }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: summaryText } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

/**
 * A faithful fake Session: append-only log plus a surface the append /
 * replace operations actually mutate, exactly like the real SurfaceManager.
 */
function fakeSession(header: Partial<SessionHeader>, rawEvents: unknown[], surfaceSeqs: number[]): Session {
  const events = rawEvents.map((raw, seq) => ({ seq, time: 0, ...raw as object })) as unknown as SessionEvent[]
  const surface = { nodes: [...surfaceSeqs], replaceGeneration: 1 }
  const session = {
    id: header.id,
    header,
    inheritedEventCount: header.inheritedEventCount ?? 0,
    snapshotEvents: () => Object.freeze([...events]),
    eventAt: (seq: number) => events[seq],
    get seq() { return events.length },
    surface,
    requestHeader: () => ({ config: { provider: 'fake-provider', model: 'fake-model' } }),
    deriveEventMessage(event: SessionEvent): Message | null {
      if (event.type === 'user/message') return (event.data as Message | undefined) ?? null
      if (event.type === 'assistant/message') {
        return ((event.data as { message?: Message } | undefined)?.message) ?? null
      }
      return null
    },
    append(type: string, data: unknown, opts?: { surfaceOp?: unknown }) {
      const seq = events.length
      const event = { type, seq, time: 0, data, ...opts } as unknown as SessionEvent
      events.push(event)
      const op = opts?.surfaceOp as { op?: string; startSeq?: number; endSeq?: number } | string | undefined
      if (op === 'append') surface.nodes.push(seq)
      else if (typeof op === 'object' && op?.op === 'replace') {
        const startIdx = surface.nodes.indexOf(op.startSeq ?? -1)
        const endIdx = surface.nodes.indexOf(op.endSeq ?? -1)
        surface.nodes.splice(startIdx, endIdx - startIdx + 1, seq)
        surface.replaceGeneration += 1
      }
      return event
    },
  }
  return session as unknown as Session
}

/** A fake agent whose runMaintenance mirrors the idle-claim/restore protocol and whose `inject` records queued context. */
function fakeAgent(session: Session): Agent & { injected: UserMessage[] } {
  const injected: UserMessage[] = []
  const agent = {
    session,
    id: (session as unknown as { id: string }).id,
    options: {},
    status: 'idle',
    injected,
    inject(message: UserMessage) {
      injected.push(message)
    },
    runMaintenance(job: (signal: AbortSignal) => Promise<unknown>) {
      if (agent.status !== 'idle') throw new Error(`agent already has active work`)
      const controller = new AbortController()
      agent.status = 'running'
      return (async () => {
        try {
          return await job(controller.signal)
        } finally {
          agent.status = 'idle'
        }
      })()
    },
  }
  return agent as unknown as Agent
}

function userMsg(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function assistantMsg(text: string, interrupted = false): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { provider: 'fake-provider', model: 'fake-model' },
    ...interrupted ? { interrupted: true } : {},
  } as unknown as Message
}

/** Message lookup for the meter's per-node pricing. */
function messageAt(session: Session): (seq: number) => number {
  return (seq: number) => {
    const event = session.eventAt(seq)
    if (event === undefined) return 1
    if (event.type === 'user/message') return price(textOf(event.data as Message | undefined))
    if (event.type === 'assistant/message') {
      return price(textOf((event.data as { message?: Message } | undefined)?.message))
    }
    return 1
  }
}

// The child fixture: two inherited prefix nodes, the seed boundary, then a
// post-fork region whose SECOND turn was interrupted mid-stream (the
// assistant prefix finalized with `interrupted: true` and a synthetic
// aborted turn end) — acceptance #3's honest shape.
const LONG_A = 'parent-established context question '.repeat(8)
const LONG_B = 'branch exploration and findings '.repeat(8)

function childFixture(): Session {
  return fakeSession(
    { id: 'session-child', parentSession: 'session-parent', isSeeded: true, inheritedEventCount: 3, cwd: '/w' },
    [
      { type: 'user/message', data: userMsg(LONG_A), surfaceOp: 'append' },
      { type: 'assistant/message', data: { message: assistantMsg(LONG_A) }, surfaceOp: 'append' },
      { type: 'session/end-seed' },
      { type: 'user/message', data: userMsg(LONG_B), surfaceOp: 'append' },
      { type: 'assistant/message', data: { message: assistantMsg(LONG_B.slice(0, 60), true) }, surfaceOp: 'append' },
      { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted' } } },
      { type: 'user/message', data: userMsg(LONG_B), surfaceOp: 'append' },
      { type: 'assistant/message', data: { message: assistantMsg(LONG_B) }, surfaceOp: 'append' },
    ],
    [0, 1, 3, 4, 6, 7],
  )
}

/** Fold a log back into a surface — the minimal replay the acceptance asks for. */
function replaySurface(session: Session): number[] {
  const nodes: number[] = []
  for (const event of session.snapshotEvents()) {
    const raw = event as unknown as { surfaceOp?: { op?: string; startSeq?: number; endSeq?: number } | string }
    if (raw.surfaceOp === 'append') nodes.push(event.seq)
    else if (typeof raw.surfaceOp === 'object' && raw.surfaceOp?.op === 'replace') {
      const startIdx = nodes.indexOf(raw.surfaceOp.startSeq ?? -1)
      const endIdx = nodes.indexOf(raw.surfaceOp.endSeq ?? -1)
      nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
    }
  }
  return nodes
}

describe('squash e2e: vendored engine over the post-fork region', () => {
  test('acceptance #1: compacts exactly the post-fork region; the inherited prefix is untouched', async () => {
    const child = childFixture()
    const prefixSnapshot = JSON.stringify(child.snapshotEvents().slice(0, 3))
    const agent = fakeAgent(child)
    const result = await compactNow(
      { meter: fakeMeter(messageAt(child)), llm: fakeLlm('branch summary checkpoint') },
      agent,
      new AbortController().signal,
      { start: 3, end: 7, flush: async () => { } },
    )
    expect(result.shadowedSeqs).toEqual([3, 4, 6, 7])
    // Surface: prefix nodes survive verbatim, the region became one node.
    expect(child.surface.nodes.length).toBe(3)
    expect(child.surface.nodes.slice(0, 2)).toEqual([0, 1])
    // Prefix events byte-identical.
    expect(JSON.stringify(child.snapshotEvents().slice(0, 3))).toBe(prefixSnapshot)
    // The replacement is a recognized compaction checkpoint.
    const replacement = child.eventAt(child.surface.nodes[2]!)
    const message = child.deriveEventMessage(replacement as SessionEvent) as UserMessage
    expect(isCompactCheckpointSource(message.source)).toBe(true)
    // The durable marker ordering: start < summary < replacement < end.
    const types = child.snapshotEvents().slice(-4).map(event => event.type)
    expect(types).toEqual(['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'])
  })

  test('acceptance #3: an interrupted turn inside the region still compacts honestly', async () => {
    const child = childFixture()
    const interrupted = child.eventAt(4) as unknown as { data: { message: { interrupted?: true } } }
    expect(interrupted.data.message.interrupted).toBe(true)
    const result = await compactNow(
      { meter: fakeMeter(messageAt(child)), llm: fakeLlm('summary despite interruption') },
      fakeAgent(child),
      new AbortController().signal,
      { start: 3, end: 7 },
    )
    expect(result.shadowedSeqs).toContain(4)
    expect(result.summary.length).toBeGreaterThan(0)
  })

  test('acceptance #5 (child): the compacted log replays to the same surface', async () => {
    const child = childFixture()
    await compactNow(
      { meter: fakeMeter(messageAt(child)), llm: fakeLlm('replayable summary') },
      fakeAgent(child),
      new AbortController().signal,
      { start: 3, end: 7 },
    )
    expect(replaySurface(child)).toEqual([...child.surface.nodes])
  })

  test('a summary that would not shrink throws the summary error (no verbatim fallback)', async () => {
    const child = childFixture()
    const nodeTokensOf = messageAt(child)
    const shadowedTotal = [3, 4, 6, 7].reduce((sum, seq) => sum + nodeTokensOf(seq), 0)
    const overpriced = fakeMeter(nodeTokensOf, shadowedTotal + 1000)
    let threw: unknown
    await compactNow(
      { meter: overpriced, llm: fakeLlm('bloated') },
      fakeAgent(child),
      new AbortController().signal,
      { start: 3, end: 7 },
    ).catch(error => { threw = error })
    expect(threw).toBeInstanceOf(ManualCompactionError)
    expect((threw as ManualCompactionError).code).toBe('summary')
  })
})

describe('squash e2e: full /squash pipeline into the parent', () => {
  /** Run the engine over the child, then the command pipeline into a cold-resumed fake parent. */
  async function runPipeline(): Promise<{ result: ReturnType<typeof JSON.stringify>; parent: Session; child: Session; compaction: CompactionResult }> {
    const child = childFixture()
    const compaction = await compactNow(
      { meter: fakeMeter(messageAt(child)), llm: fakeLlm('branch summary checkpoint') },
      fakeAgent(child),
      new AbortController().signal,
      { start: 3, end: 7, flush: async () => { } },
    )
    const parent = fakeSession(
      { id: 'session-parent', cwd: '/w' },
      [
        { type: 'user/message', data: userMsg('parent original question'), surfaceOp: 'append' },
        { type: 'assistant/message', data: { message: assistantMsg('parent original answer') }, surfaceOp: 'append' },
      ],
      [0, 1],
    )
    // Snapshot captured before delivery: the parent's own log stays intact.
    const parentSnapshot = JSON.stringify(parent.snapshotEvents())
    const parentAgent = fakeAgent(parent)
    const state: BranchRegistryState = {
      branches: {
        main: { name: 'main', sessionId: 'session-parent', forkOrigin: null },
        review: { name: 'review', sessionId: 'session-child', forkOrigin: { parentSessionId: 'session-parent', atSeq: 5 } },
      },
    }
    const commandResult = await executeSquashAction(
      { kind: 'squash', target: 'main' },
      {
        childAgent: fakeAgent(child) as never,
        signal: new AbortController().signal,
        commandId: 'cmd-1' as CommandId,
        store: { load: async () => state, save: async () => { } },
        compact: async () => compaction,
        resolveTargetAgent: async () => parentAgent as never,
        flush: async () => { },
      },
    )
    return { result: JSON.stringify(commandResult), parent, parentAgent, parentSnapshot, child, compaction }
  }

  test('acceptance #2: parent growth is bounded by exactly one queued checkpoint', async () => {
    const { result, parent, parentAgent, parentSnapshot } = await runPipeline()
    expect(JSON.parse(result as string).kind).toBe('success')
    // The parent's own log is untouched — delivery queues in the inbox.
    expect(JSON.stringify(parent.snapshotEvents())).toBe(parentSnapshot)
    expect(parent.surface.nodes).toEqual([0, 1])
    // Exactly one envelope was queued, still a recognized checkpoint.
    expect(parentAgent.injected.length).toBe(1)
    expect(isCompactCheckpointSource(parentAgent.injected[0]!.source)).toBe(true)
  })

  test('acceptance #5 (parent): the parent log replays to a complete, valid request', async () => {
    const { parent } = await runPipeline()
    expect(replaySurface(parent)).toEqual([...parent.surface.nodes])
    for (const seq of parent.surface.nodes) {
      const message = parent.deriveEventMessage(parent.eventAt(seq) as SessionEvent)
      expect(message).not.toBeNull()
    }
  })

  test('acceptance #6: the child branch remains independently usable after squash', async () => {
    const { child } = await runPipeline()
    // Every child surface node still derives to a valid message.
    for (const seq of child.surface.nodes) {
      expect(child.deriveEventMessage(child.eventAt(seq) as SessionEvent)).not.toBeNull()
    }
    // And the region is spent: the only post-fork surface node left is the
    // checkpoint itself, so a re-squash has nothing new to compact.
    const remaining = postForkRange(child)
    expect(remaining.start).toBe(remaining.end)
    const remainingMessage = child.deriveEventMessage(child.eventAt(remaining.start) as SessionEvent) as UserMessage
    expect(isCompactCheckpointSource(remainingMessage.source)).toBe(true)
  })
})
