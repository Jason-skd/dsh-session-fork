/**
 * Tests for host-side graph assembly: turn extraction over session-event
 * shapes, the registry→node graph builder (lineage, refs, head, ordering,
 * degradation), and the 'graph' RPC endpoint end-to-end over fake ports.
 * @module dsh-session-fork/tests/graph-assembly.test
 */

import { describe, expect, test } from 'bun:test'
import {
  assembleBranchGraph,
  extractTurns,
  type BranchLike,
  type GraphEvent,
  type GraphSessionLog,
} from '../src/graph.ts'
import { createBranchRpcHandler } from '../src/rpc.ts'
import type { BranchRpcPorts } from '../src/rpc.ts'
import type { RegistryState } from '../src/types.ts'

/** One turn spec for the fake log builder. */
interface TurnSpec {
  readonly turn: number
  /** User message text; omitted for empty turns. */
  readonly subject?: string
  /** Event time (ms) of the turn/start. */
  readonly time: number
  /** Message source kind; 'user' = direct human prompt. */
  readonly source?: 'user' | 'plugin'
}

/** Build a session-event log from turn specs (seqs contiguous from 0). */
function sessionEvents(turns: readonly TurnSpec[]): GraphEvent[] {
  const events: GraphEvent[] = []
  let seq = 0
  const push = (type: string, time: number, data: unknown): void => {
    events.push({ seq: seq++, type, time, data })
  }
  for (const spec of turns) {
    push('turn/start', spec.time, { turn: spec.turn })
    if (spec.subject !== undefined) {
      push('user/message', spec.time, {
        id: `m-${spec.turn}`,
        role: 'user',
        content: [{ type: 'text', text: spec.subject }],
        source: { kind: spec.source ?? 'user' },
      })
    }
    push('turn/end', spec.time, { turn: spec.turn, reason: { kind: 'completed' } })
  }
  return events
}

/** Seq of one turn's `turn/end` event. */
function endSeqOf(events: readonly GraphEvent[], turn: number): number {
  const found = events.find(event =>
    event.type === 'turn/end' && (event.data as { turn?: unknown }).turn === turn)
  if (found === undefined) throw new Error(`no turn/end for turn ${turn}`)
  return found.seq
}

describe('extractTurns', () => {
  test('prefers the direct human prompt over synthetic injections', () => {
    const events = [
      { seq: 0, type: 'turn/start', time: 1, data: { turn: 3 } },
      {
        seq: 1, type: 'user/message', time: 1,
        data: { role: 'user', content: [{ type: 'text', text: 'file changed notice' }], source: { kind: 'plugin' } },
      },
      {
        seq: 2, type: 'user/message', time: 1,
        data: { role: 'user', content: [{ type: 'text', text: 'fix the bug' }], source: { kind: 'user' } },
      },
      { seq: 3, type: 'turn/end', time: 2, data: { turn: 3, reason: { kind: 'completed' } } },
    ]
    expect(extractTurns(events)).toEqual([
      { turn: 3, startSeq: 0, endSeq: 3, startTime: 1, subject: 'fix the bug' },
    ])
  })

  test('synthetic-only and quiet turns yield no rows (human prompts are the only commits)', () => {
    const events = [
      { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } },
      {
        seq: 1, type: 'user/message', time: 1,
        data: { role: 'user', content: [{ type: 'text', text: '<goal_round>…' }], source: { kind: 'goal' } },
      },
      {
        seq: 2, type: 'user/message', time: 1,
        data: { role: 'user', content: [{ type: 'text', text: 'injected' }], source: { kind: 'plugin' } },
      },
      { seq: 3, type: 'turn/end', time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      { seq: 4, type: 'turn/start', time: 3, data: { turn: 2 } },
      { seq: 5, type: 'turn/end', time: 4, data: { turn: 2, reason: { kind: 'completed' } } },
      { seq: 6, type: 'turn/start', time: 5, data: { turn: 3 } },
      {
        seq: 7, type: 'user/message', time: 5,
        data: { role: 'user', content: [{ type: 'text', text: 'real question' }], source: { kind: 'user' } },
      },
      { seq: 8, type: 'turn/end', time: 6, data: { turn: 3, reason: { kind: 'completed' } } },
    ]
    expect(extractTurns(events).map(turn => [turn.turn, turn.subject]))
      .toEqual([[3, 'real question']])
  })

  test('a fromSeq cutoff (seed boundary) keeps only the session\'s own turns', () => {
    const seed = sessionEvents([{ turn: 1, subject: 'seed turn', time: 1 }])
    const own = sessionEvents([{ turn: 2, subject: 'own turn', time: 2 }])
    const events = [...seed, ...own.map(event => ({ ...event, seq: event.seq + seed.length }))]
    expect(extractTurns(events, seed.length).map(turn => turn.turn)).toEqual([2])
  })

  test('user messages outside any open turn are ignored', () => {
    // A pre-turn orphan (queued or replay residue) must not leak into the
    // next turn's subject; the message-less turn yields no row at all.
    const events = [
      {
        seq: 0, type: 'user/message', time: 1,
        data: { role: 'user', content: [{ type: 'text', text: 'orphan' }], source: { kind: 'user' } },
      },
      { seq: 1, type: 'turn/start', time: 2, data: { turn: 1 } },
      { seq: 2, type: 'turn/end', time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    expect(extractTurns(events)).toEqual([])
  })

  test('ignores null-turn brackets and never-opened trailing turns', () => {
    const events = [
      { seq: 0, type: 'turn/start', time: 1, data: { turn: null } },
      { seq: 1, type: 'turn/end', time: 1, data: { turn: null, reason: { kind: 'completed' } } },
      { seq: 2, type: 'turn/start', time: 2, data: { turn: 5 } },
    ]
    expect(extractTurns(events)).toEqual([])
  })

  test('a /squash merge checkpoint between turns emits its own row; ordinary /compact checkpoints do not', () => {
    // The squash checkpoint: official compaction-checkpoint source
    // (kind plugin / plugin compact) whose text opens with the machine
    // preamble — the one sanctioned plugin row. Its subject is the
    // preamble's first line. Names a REGISTERED branch ("exp") so the
    // merge edge can resolve.
    const events = [
      ...sessionEvents([{ turn: 1, subject: 'parent prompt', time: 1 }]),
      {
        seq: 3, type: 'user/message', time: 2,
        data: {
          role: 'user',
          content: [{
            type: 'text',
            text: 'This is a squash from branch "exp" into branch "main". squash summary line\nmore detail',
          }],
          source: { kind: 'plugin', plugin: 'compact', compactionId: 'c1' },
        },
      },
      // dsh's own /compact checkpoint: plugin compact source WITHOUT the
      // transfer preamble — stays filtered like every other plugin message.
      {
        seq: 4, type: 'user/message', time: 3,
        data: {
          role: 'user',
          content: [{ type: 'text', text: 'plain compaction checkpoint' }],
          source: { kind: 'plugin', plugin: 'compact', compactionId: 'c2' },
        },
      },
      ...sessionEvents([{ turn: 2, subject: 'later prompt', time: 4 }])
        .map(event => ({ ...event, seq: event.seq + 5 })),
    ]
    expect(extractTurns(events)).toEqual([
      { turn: 1, startSeq: 0, endSeq: 2, startTime: 1, subject: 'parent prompt' },
      { turn: 3, startSeq: 3, endSeq: 3, startTime: 2, subject: 'This is a squash from branch "exp" into branch "main". squash summary line', transferOf: { kind: 'squash', fromName: 'exp' } },
      { turn: 2, startSeq: 5, endSeq: 7, startTime: 4, subject: 'later prompt' },
    ])
  })

  test('a /squash merge checkpoint inside an open turn still emits its own row (agent.inject delivery)', () => {
    // The agreed transport (agent.inject(), next-step no wake) delivers the
    // checkpoint into whatever turn bracket is open at delivery time
    // (empirically: go-ce-v3 2026-08-25, checkpoints landed inside turn 3).
    // The checkpoint is its own row wherever it lands, does not leak into
    // the enclosing turn's subject, and precedes that turn's own row.
    const events = [
      ...sessionEvents([{ turn: 1, subject: 'parent prompt', time: 1 }]),
      { seq: 3, type: 'turn/start', time: 2, data: { turn: 2 } },
      {
        seq: 4, type: 'user/message', time: 3,
        data: {
          role: 'user',
          content: [{
            type: 'text',
            text: 'This is a squash from branch "exp" into branch "main". squash summary line\nmore detail',
          }],
          source: { kind: 'plugin', plugin: 'compact', compactionId: 'c1' },
        },
      },
      {
        seq: 5, type: 'user/message', time: 4,
        data: {
          role: 'user',
          content: [{ type: 'text', text: 'post-squash prompt' }],
          source: { kind: 'user' },
        },
      },
      { seq: 6, type: 'turn/end', time: 5, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    expect(extractTurns(events)).toEqual([
      { turn: 1, startSeq: 0, endSeq: 2, startTime: 1, subject: 'parent prompt' },
      { turn: 4, startSeq: 4, endSeq: 4, startTime: 3, subject: 'This is a squash from branch "exp" into branch "main". squash summary line', transferOf: { kind: 'squash', fromName: 'exp' } },
      { turn: 2, startSeq: 3, endSeq: 6, startTime: 2, subject: 'post-squash prompt' },
    ])
  })

  test('a checkpoint inside a subject-less open turn survives even though the turn itself emits nothing', () => {
    // The enclosing turn never gets a human prompt, so it yields no row —
    // but the checkpoint inside it is still a row of its own.
    const events = [
      { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } },
      {
        seq: 1, type: 'user/message', time: 2,
        data: {
          role: 'user',
          content: [{ type: 'text', text: 'This is a squash from branch "exp" into branch "main". squash summary line' }],
          source: { kind: 'plugin', plugin: 'compact', compactionId: 'c1' },
        },
      },
      { seq: 2, type: 'turn/end', time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    expect(extractTurns(events)).toEqual([
      { turn: 1, startSeq: 1, endSeq: 1, startTime: 2, subject: 'This is a squash from branch "exp" into branch "main". squash summary line', transferOf: { kind: 'squash', fromName: 'exp' } },
    ])
  })

  test('a /rebased into envelope between turns emits its own row', () => {
    // The rebased-into transcript rides the shared branch-event envelope:
    // plugin source (the envelope builder's own plugin name, form recall)
    // whose preamble names the source branch — the same detection key as
    // squash, no compaction identity involved.
    const events = [
      ...sessionEvents([{ turn: 1, subject: 'target prompt', time: 1 }]),
      {
        seq: 3, type: 'user/message', time: 2,
        data: {
          role: 'user',
          content: [{ type: 'text', text: 'This is a rebased-into from branch "exp" into branch "main".\nuser: did work' }],
          source: { kind: 'plugin', plugin: 'dsh-session-fork', form: 'recall' },
        },
      },
      ...sessionEvents([{ turn: 2, subject: 'later prompt', time: 4 }])
        .map(event => ({ ...event, seq: event.seq + 5 })),
    ]
    expect(extractTurns(events)).toEqual([
      { turn: 1, startSeq: 0, endSeq: 2, startTime: 1, subject: 'target prompt' },
      { turn: 3, startSeq: 3, endSeq: 3, startTime: 2,
        subject: 'This is a rebased-into from branch "exp" into branch "main".',
        transferOf: { kind: 'rebased-into', fromName: 'exp' } },
      { turn: 2, startSeq: 5, endSeq: 7, startTime: 4, subject: 'later prompt' },
    ])
  })

  test('a /rebased into envelope inside an open turn still emits its own row (agent.inject delivery)', () => {
    // Same delivery reality as squash: inject() lands the envelope in
    // whatever turn bracket is open — the row must not be swallowed and
    // must not leak into the enclosing turn's subject.
    const events = [
      ...sessionEvents([{ turn: 1, subject: 'target prompt', time: 1 }]),
      { seq: 3, type: 'turn/start', time: 2, data: { turn: 2 } },
      {
        seq: 4, type: 'user/message', time: 3,
        data: {
          role: 'user',
          content: [{ type: 'text', text: 'This is a rebased-into from branch "exp" into branch "main".\nuser: did work' }],
          source: { kind: 'plugin', plugin: 'dsh-session-fork', form: 'recall' },
        },
      },
      {
        seq: 5, type: 'user/message', time: 4,
        data: {
          role: 'user',
          content: [{ type: 'text', text: 'post-rebase prompt' }],
          source: { kind: 'user' },
        },
      },
      { seq: 6, type: 'turn/end', time: 5, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    expect(extractTurns(events)).toEqual([
      { turn: 1, startSeq: 0, endSeq: 2, startTime: 1, subject: 'target prompt' },
      { turn: 4, startSeq: 4, endSeq: 4, startTime: 3,
        subject: 'This is a rebased-into from branch "exp" into branch "main".',
        transferOf: { kind: 'rebased-into', fromName: 'exp' } },
      { turn: 2, startSeq: 3, endSeq: 6, startTime: 2, subject: 'post-rebase prompt' },
    ])
  })

  test('a branch-message envelope between turns emits its own row', () => {
    const events = [
      ...sessionEvents([{ turn: 1, subject: 'target prompt', time: 1 }]),
      {
        seq: 3, type: 'user/message', time: 2,
        data: {
          role: 'user',
          content: [{ type: 'text', text: 'This is a message from branch "exp" into branch "main".\nuser: hello' }],
          source: { kind: 'plugin', plugin: 'dsh-session-fork', form: 'notice' },
        },
      },
      ...sessionEvents([{ turn: 2, subject: 'later prompt', time: 4 }])
        .map(event => ({ ...event, seq: event.seq + 5 })),
    ]
    expect(extractTurns(events)).toEqual([
      { turn: 1, startSeq: 0, endSeq: 2, startTime: 1, subject: 'target prompt' },
      { turn: 3, startSeq: 3, endSeq: 3, startTime: 2,
        subject: 'This is a message from branch "exp" into branch "main".',
        transferOf: { kind: 'message', fromName: 'exp' } },
      { turn: 2, startSeq: 5, endSeq: 7, startTime: 4, subject: 'later prompt' },
    ])
  })
})

/** The canonical workspace: root session + one forked child. */
function canonicalWorkspace(): {
  readonly branches: readonly BranchLike[]
  readonly logs: ReadonlyMap<string, GraphSessionLog>
  readonly rootEvents: readonly GraphEvent[]
  readonly childEvents: readonly GraphEvent[]
} {
  const rootEvents = sessionEvents([
    { turn: 1, subject: 'first prompt', time: 10 },
    { turn: 2, subject: 'second prompt', time: 20 },
  ])
  // The child seeds the root prefix (through turn 2's end), then works on.
  const seedLength = endSeqOf(rootEvents, 2) + 1
  const ownTurns = sessionEvents([
    { turn: 3, subject: 'experiment', time: 30 },
    { turn: 4, subject: 'keep going', time: 40 },
  ])
  const childEvents = [
    ...rootEvents,
    ...ownTurns.map(event => ({ ...event, seq: event.seq + seedLength })),
  ]
  const logs = new Map<string, GraphSessionLog>([
    ['s-root', { header: {}, events: rootEvents }],
    ['s-child', { header: { inheritedEventCount: seedLength, parentSession: 's-root' }, events: childEvents }],
  ])
  return {
    branches: [
      { name: 'main', sessionId: 's-root', forkOrigin: null },
      {
        name: 'exp', sessionId: 's-child',
        forkOrigin: { parentSessionId: 's-root', atSeq: endSeqOf(rootEvents, 2) },
      },
    ],
    logs,
    rootEvents,
    childEvents,
  }
}

/** readSession fake over a fixed log map. */
function readerOf(logs: ReadonlyMap<string, GraphSessionLog>) {
  const reads: string[] = []
  return {
    reads,
    readSession: async (sessionId: string): Promise<GraphSessionLog | null> => {
      reads.push(sessionId)
      return logs.get(sessionId) ?? null
    },
  }
}

describe('assembleBranchGraph', () => {
  test('assembles lineage, refs, head, and newest-first order', async () => {
    const { branches, logs, rootEvents, childEvents } = canonicalWorkspace()
    const graph = await assembleBranchGraph(branches, 's-child', readerOf(logs).readSession)
    expect(graph.nodes.map(node => node.id)).toEqual([
      's-child:4',
      's-child:3',
      's-root:2',
      's-root:1',
    ])
    const byId = new Map(graph.nodes.map(node => [node.id, node]))
    expect(byId.get('s-child:4')?.parentIds).toEqual(['s-child:3'])
    // The fork link: the child's first own turn parents to the root's
    // anchor turn (the right-jump lane in the renderer).
    expect(byId.get('s-child:3')?.parentIds).toEqual(['s-root:2'])
    expect(byId.get('s-root:2')?.parentIds).toEqual(['s-root:1'])
    expect(byId.get('s-root:1')?.parentIds).toEqual([])
    // Branch-name refs land on each branch's head row.
    expect(byId.get('s-child:4')?.refs).toEqual([{ id: 'exp', name: 'exp' }])
    expect(byId.get('s-root:2')?.refs).toEqual([{ id: 'main', name: 'main' }])
    // Quiet turns carry no refs key at all.
    expect('refs' in (byId.get('s-child:3') ?? {})).toBe(false)
    expect(graph.head).toBe('s-child:4')
    // Row→data-plane address (issue #8): owning session, turn handle, and
    // the closing turn/end seq in that session's log (fork atSeq semantic).
    expect(byId.get('s-child:3')).toMatchObject({
      sessionId: 's-child',
      turn: 3,
      endSeq: endSeqOf(childEvents, 3),
    })
    expect(byId.get('s-root:1')).toMatchObject({
      sessionId: 's-root',
      turn: 1,
      endSeq: endSeqOf(rootEvents, 1),
    })
  })

  test('degrades by omission when a branch session is unreadable', async () => {
    const { branches, logs } = canonicalWorkspace()
    const pruned = new Map(logs)
    pruned.delete('s-child')
    const graph = await assembleBranchGraph(branches, 's-root', readerOf(pruned).readSession)
    expect(graph.nodes.map(node => node.id)).toEqual(['s-root:2', 's-root:1'])
    expect(graph.head).toBe('s-root:2')
  })

  test('drops the fork link when the anchor resolves outside the branch set', async () => {
    // The child's fork parent is not a registry branch.
    const { logs } = canonicalWorkspace()
    const branches: BranchLike[] = [
      { name: 'exp', sessionId: 's-child', forkOrigin: { parentSessionId: 's-root', atSeq: 2 } },
    ]
    const graph = await assembleBranchGraph(branches, 's-child', readerOf(logs).readSession)
    const first = graph.nodes.find(node => node.id === 's-child:3')
    expect(first?.parentIds).toEqual([])
  })

  test('walks an anchor landing in the parent\'s own seed up to the ancestor that owns the turn', async () => {
    // Chain A → B → C: B forked from A's turn 1; C forked from B at a seq
    // inside B's inherited A-prefix. The anchor must resolve to A's turn.
    const aEvents = sessionEvents([
      { turn: 1, subject: 'a1', time: 10 },
      { turn: 2, subject: 'a2', time: 60 },
    ])
    const bSeedLength = endSeqOf(aEvents, 1) + 1
    const bOwn = sessionEvents([{ turn: 2, subject: 'b2', time: 20 }])
    const bEvents = [...aEvents.slice(0, bSeedLength), ...bOwn.map(e => ({ ...e, seq: e.seq + bSeedLength }))]
    const cSeedLength = bEvents.length
    const cOwn = sessionEvents([{ turn: 3, subject: 'c3', time: 30 }])
    const cEvents = [...bEvents, ...cOwn.map(e => ({ ...e, seq: e.seq + cSeedLength }))]
    const logs = new Map<string, GraphSessionLog>([
      ['s-a', { header: {}, events: aEvents }],
      ['s-b', { header: { inheritedEventCount: bSeedLength, parentSession: 's-a' }, events: bEvents }],
      ['s-c', { header: { inheritedEventCount: cSeedLength, parentSession: 's-b' }, events: cEvents }],
    ])
    const branches: BranchLike[] = [
      { name: 'a', sessionId: 's-a', forkOrigin: null },
      { name: 'b', sessionId: 's-b', forkOrigin: { parentSessionId: 's-a', atSeq: endSeqOf(aEvents, 1) } },
      // C's fork anchor seq falls inside B's inherited prefix — coordinates
      // are shared, so the walk must land on A's turn 1.
      { name: 'c', sessionId: 's-c', forkOrigin: { parentSessionId: 's-b', atSeq: endSeqOf(aEvents, 1) } },
    ]
    const graph = await assembleBranchGraph(branches, 's-c', readerOf(logs).readSession)
    const first = graph.nodes.find(node => node.id === 's-c:3')
    expect(first?.parentIds).toEqual(['s-a:1'])
  })

  test('an empty registry yields an empty graph', async () => {
    const graph = await assembleBranchGraph([], 's-any', readerOf(new Map()).readSession)
    expect(graph.nodes).toEqual([])
    expect(graph.head).toBeNull()
  })

  test('a squash row parents to both the previous parent-branch row and the child branch head', async () => {
    // Root gets a /squash merge checkpoint after its turns (from the child
    // branch "exp"), then another human turn. The squash row is
    // merge-shaped: it parents to the previous root row AND the registered
    // child branch's head (the merge-join lane), ids s-prefixed by seq.
    const rootTurns = sessionEvents([
      { turn: 1, subject: 'first', time: 10 },
      { turn: 2, subject: 'second', time: 20 },
    ])
    const squashSeq = rootTurns.length
    const later = sessionEvents([{ turn: 3, subject: 'after squash', time: 40 }])
      .map(event => ({ ...event, seq: event.seq + squashSeq + 1 }))
    const rootEvents: GraphEvent[] = [
      ...rootTurns,
      {
        seq: squashSeq, type: 'user/message', time: 30,
        data: {
          role: 'user',
          content: [{
            type: 'text',
            text: 'This is a squash from branch "exp" into branch "main". exp conclusion',
          }],
          source: { kind: 'plugin', plugin: 'compact', compactionId: 'c1' },
        },
      },
      ...later,
    ]
    const childEvents = sessionEvents([{ turn: 1, subject: 'experiment', time: 25 }])
    const logs = new Map<string, GraphSessionLog>([
      ['s-root', { header: {}, events: rootEvents }],
      ['s-child', { header: { inheritedEventCount: 0, parentSession: 's-root' }, events: childEvents }],
    ])
    const branches: BranchLike[] = [
      { name: 'main', sessionId: 's-root', forkOrigin: null },
      { name: 'exp', sessionId: 's-child', forkOrigin: { parentSessionId: 's-root', atSeq: endSeqOf(rootTurns, 2) } },
    ]
    const graph = await assembleBranchGraph(branches, 's-root', readerOf(logs).readSession)
    const byId = new Map(graph.nodes.map(node => [node.id, node]))
    expect(byId.get('s-root:s6')?.subject).toBe('This is a squash from branch "exp" into branch "main". exp conclusion')
    expect(byId.get('s-root:s6')?.parentIds).toEqual(['s-root:2', 's-child:1'])
    expect(byId.get('s-root:3')?.parentIds).toEqual(['s-root:s6'])
  })

  test('a checkpoint delivered inside an open turn still draws the full merge join', async () => {
    // agent.inject() delivery shape: turn 3 opens, the checkpoint lands
    // inside its bracket, then the human continues on the parent branch.
    // The squash row must still parent to the previous root row AND the
    // registered child's head (merge-join lane), and the enclosing turn's
    // row chains through the squash row.
    const rootTurns = sessionEvents([
      { turn: 1, subject: 'first', time: 10 },
      { turn: 2, subject: 'second', time: 20 },
    ])
    const openSeq = rootTurns.length
    const enclosing = sessionEvents([{ turn: 3, subject: 'after squash', time: 40 }])
      .map(event => ({ ...event, seq: event.seq + openSeq + 1 }))
    // Splice the checkpoint right after the enclosing turn/start.
    const enclosingStart = enclosing.find(event => event.type === 'turn/start')
    if (enclosingStart === undefined) throw new Error('fixture: no turn/start')
    const checkpoint: GraphEvent = {
      seq: enclosingStart.seq + 0.5, type: 'user/message', time: 30,
      data: {
        role: 'user',
        content: [{
          type: 'text',
          text: 'This is a squash from branch "exp" into branch "main". exp conclusion',
        }],
        source: { kind: 'plugin', plugin: 'compact', compactionId: 'c1' },
      },
    }
    const rootEvents: GraphEvent[] = [...rootTurns, ...enclosing, checkpoint]
      .sort((left, right) => left.seq - right.seq)
    const childEvents = sessionEvents([{ turn: 1, subject: 'experiment', time: 25 }])
    const logs = new Map<string, GraphSessionLog>([
      ['s-root', { header: {}, events: rootEvents }],
      ['s-child', { header: { inheritedEventCount: 0, parentSession: 's-root' }, events: childEvents }],
    ])
    const branches: BranchLike[] = [
      { name: 'main', sessionId: 's-root', forkOrigin: null },
      { name: 'exp', sessionId: 's-child', forkOrigin: { parentSessionId: 's-root', atSeq: endSeqOf(rootTurns, 2) } },
    ]
    const graph = await assembleBranchGraph(branches, 's-root', readerOf(logs).readSession)
    const byId = new Map(graph.nodes.map(node => [node.id, node]))
    expect(byId.get('s-root:s7.5')?.subject).toBe('This is a squash from branch "exp" into branch "main". exp conclusion')
    expect(byId.get('s-root:s7.5')?.parentIds).toEqual(['s-root:2', 's-child:1'])
    expect(byId.get('s-root:3')?.parentIds).toEqual(['s-root:s7.5'])
  })

  test('a squash row degrades to single-parent when the child is not a registered branch', async () => {
    // Same shape, but the preamble names a branch no registry record
    // carries (removed, or renamed away since the transfer): its rows are
    // absent from the graph, so the merge-join parent resolves to nothing
    // and the row stays on the parent chain only.
    const rootTurns = sessionEvents([{ turn: 1, subject: 'first', time: 10 }])
    const rootEvents: GraphEvent[] = [
      ...rootTurns,
      {
        seq: rootTurns.length, type: 'user/message', time: 20,
        data: {
          role: 'user',
          content: [{
            type: 'text',
            text: 'This is a squash from branch "ghost" into branch "main". stray conclusion',
          }],
          source: { kind: 'plugin', plugin: 'compact', compactionId: 'c2' },
        },
      },
    ]
    const logs = new Map<string, GraphSessionLog>([
      ['s-root', { header: {}, events: rootEvents }],
    ])
    const branches: BranchLike[] = [
      { name: 'main', sessionId: 's-root', forkOrigin: null },
    ]
    const graph = await assembleBranchGraph(branches, 's-root', readerOf(logs).readSession)
    const byId = new Map(graph.nodes.map(node => [node.id, node]))
    expect(byId.get('s-root:s3')?.subject).toBe('This is a squash from branch "ghost" into branch "main". stray conclusion')
    expect(byId.get('s-root:s3')?.parentIds).toEqual(['s-root:1'])
  })

  test('a rebased-into row is a plain single-parent commit even when the source branch is registered', async () => {
    // Deliberate divergence from git (user decision, 2026-08-26):
    // rebased-into INJECTS information into the target — the row is a
    // rebase commit on the target branch, the source branch is NOT
    // attached, so no merge-join lane is drawn however registered the
    // source is. The row chains into the target's next turn.
    const rootTurns = sessionEvents([
      { turn: 1, subject: 'first', time: 10 },
      { turn: 2, subject: 'second', time: 20 },
    ])
    const graftSeq = rootTurns.length
    const later = sessionEvents([{ turn: 3, subject: 'after rebase', time: 40 }])
      .map(event => ({ ...event, seq: event.seq + graftSeq + 1 }))
    const rootEvents: GraphEvent[] = [
      ...rootTurns,
      {
        seq: graftSeq, type: 'user/message', time: 30,
        data: {
          role: 'user',
          content: [{ type: 'text', text: 'This is a rebased-into from branch "exp" into branch "main".\nuser: did work' }],
          source: { kind: 'plugin', plugin: 'dsh-session-fork', form: 'recall' },
        },
      },
      ...later,
    ]
    const expEvents = sessionEvents([{ turn: 1, subject: 'experiment', time: 25 }])
    const logs = new Map<string, GraphSessionLog>([
      ['s-root', { header: {}, events: rootEvents }],
      ['s-exp', { header: { inheritedEventCount: 0, parentSession: 's-root' }, events: expEvents }],
    ])
    const branches: BranchLike[] = [
      { name: 'main', sessionId: 's-root', forkOrigin: null },
      { name: 'exp', sessionId: 's-exp', forkOrigin: { parentSessionId: 's-root', atSeq: endSeqOf(rootTurns, 2) } },
    ]
    const graph = await assembleBranchGraph(branches, 's-root', readerOf(logs).readSession)
    const byId = new Map(graph.nodes.map(node => [node.id, node]))
    expect(byId.get('s-root:s6')?.subject).toBe('This is a rebased-into from branch "exp" into branch "main".')
    // Single parent only — no 's-exp:1' second parent, no merge lane.
    expect(byId.get('s-root:s6')?.parentIds).toEqual(['s-root:2'])
    expect(byId.get('s-root:3')?.parentIds).toEqual(['s-root:s6'])
  })

  test('a rebased-into row never anchors a fork', async () => {
    // A fork anchored (atSeq) exactly on the transfer row's seq must fall
    // back to the previous real turn: transfer rows carry no kernel turn
    // handle, so they are skipped by anchor resolution exactly like
    // squash rows.
    const rootTurns = sessionEvents([{ turn: 1, subject: 'first', time: 10 }])
    const graftSeq = rootTurns.length
    const rootEvents: GraphEvent[] = [
      ...rootTurns,
      {
        seq: graftSeq, type: 'user/message', time: 20,
        data: {
          role: 'user',
          content: [{ type: 'text', text: 'This is a rebased-into from branch "exp" into branch "main".' }],
          source: { kind: 'plugin', plugin: 'dsh-session-fork', form: 'recall' },
        },
      },
    ]
    const logs = new Map<string, GraphSessionLog>([
      ['s-root', { header: {}, events: rootEvents }],
      ['s-new', { header: { inheritedEventCount: graftSeq + 1, parentSession: 's-root' },
        events: [...rootEvents, ...sessionEvents([{ turn: 2, subject: 'new branch work', time: 30 }])
          .map(event => ({ ...event, seq: event.seq + graftSeq + 1 }))] }],
    ])
    const branches: BranchLike[] = [
      { name: 'main', sessionId: 's-root', forkOrigin: null },
      { name: 'new', sessionId: 's-new', forkOrigin: { parentSessionId: 's-root', atSeq: graftSeq } },
    ]
    const graph = await assembleBranchGraph(branches, 's-root', readerOf(logs).readSession)
    const byId = new Map(graph.nodes.map(node => [node.id, node]))
    expect(byId.get('s-new:2')?.parentIds).toEqual(['s-root:1'])
  })

  test('a branch-message row is a plain single-parent commit even when the source branch is registered', async () => {
    // A message from branch exp to main appears as a single node on main's
    // chain — no cross-branch joining lane is drawn, matching the rebased-into precedent.
    const rootTurns = sessionEvents([
      { turn: 1, subject: 'first', time: 10 },
      { turn: 2, subject: 'second', time: 20 },
    ])
    const graftSeq = rootTurns.length
    const later = sessionEvents([{ turn: 3, subject: 'after message', time: 40 }])
      .map(event => ({ ...event, seq: event.seq + graftSeq + 1 }))
    const rootEvents: GraphEvent[] = [
      ...rootTurns,
      {
        seq: graftSeq, type: 'user/message', time: 30,
        data: {
          role: 'user',
          content: [{ type: 'text', text: 'This is a message from branch "exp" into branch "main".\nuser: hello from exp' }],
          source: { kind: 'plugin', plugin: 'dsh-session-fork', form: 'notice' },
        },
      },
      ...later,
    ]
    const expEvents = sessionEvents([{ turn: 1, subject: 'experiment', time: 25 }])
    const logs = new Map<string, GraphSessionLog>([
      ['s-root', { header: {}, events: rootEvents }],
      ['s-exp', { header: { inheritedEventCount: 0, parentSession: 's-root' }, events: expEvents }],
    ])
    const branches: BranchLike[] = [
      { name: 'main', sessionId: 's-root', forkOrigin: null },
      { name: 'exp', sessionId: 's-exp', forkOrigin: { parentSessionId: 's-root', atSeq: endSeqOf(rootTurns, 2) } },
    ]
    const graph = await assembleBranchGraph(branches, 's-root', readerOf(logs).readSession)
    const byId = new Map(graph.nodes.map(node => [node.id, node]))
    expect(byId.get('s-root:s6')?.subject).toBe('This is a message from branch "exp" into branch "main".')
    // Single parent only — no 's-exp:1' second parent, no merge lane.
    expect(byId.get('s-root:s6')?.parentIds).toEqual(['s-root:2'])
    expect(byId.get('s-root:3')?.parentIds).toEqual(['s-root:s6'])
  })

  test('a branch-message row never anchors a fork', async () => {
    // A fork anchored (atSeq) on the message row's seq must fall back to the
    // previous real turn: message rows carry no kernel turn handle and transferOf is set.
    const rootTurns = sessionEvents([{ turn: 1, subject: 'first', time: 10 }])
    const graftSeq = rootTurns.length
    const rootEvents: GraphEvent[] = [
      ...rootTurns,
      {
        seq: graftSeq, type: 'user/message', time: 20,
        data: {
          role: 'user',
          content: [{ type: 'text', text: 'This is a message from branch "exp" into branch "main".' }],
          source: { kind: 'plugin', plugin: 'dsh-session-fork', form: 'notice' },
        },
      },
    ]
    const logs = new Map<string, GraphSessionLog>([
      ['s-root', { header: {}, events: rootEvents }],
      ['s-new', { header: { inheritedEventCount: graftSeq + 1, parentSession: 's-root' },
        events: [...rootEvents, ...sessionEvents([{ turn: 2, subject: 'new branch work', time: 30 }])
          .map(event => ({ ...event, seq: event.seq + graftSeq + 1 }))] }],
    ])
    const branches: BranchLike[] = [
      { name: 'main', sessionId: 's-root', forkOrigin: null },
      { name: 'new', sessionId: 's-new', forkOrigin: { parentSessionId: 's-root', atSeq: graftSeq } },
    ]
    const graph = await assembleBranchGraph(branches, 's-root', readerOf(logs).readSession)
    const byId = new Map(graph.nodes.map(node => [node.id, node]))
    expect(byId.get('s-new:2')?.parentIds).toEqual(['s-root:1'])
  })

  test('timestamp-less logs order deterministically by branch order then seq', async () => {
    // No turn/start times: every row's primary sort key falls back to 0, so
    // the tie-break decides — later-declared branch session first, then
    // higher seq within a session (still newest-first overall).
    const stripTime = (events: readonly GraphEvent[]): GraphEvent[] =>
      events.map(({ time: _time, ...rest }) => rest)
    const logs = new Map<string, GraphSessionLog>([
      ['s-a', { header: {}, events: stripTime(sessionEvents([{ turn: 1, subject: 'a1', time: 1 }])) }],
      ['s-b', { header: {}, events: stripTime(sessionEvents([{ turn: 1, subject: 'b1', time: 1 }, { turn: 2, subject: 'b2', time: 2 }])) }],
    ])
    const branches: BranchLike[] = [
      { name: 'a', sessionId: 's-a', forkOrigin: null },
      { name: 'b', sessionId: 's-b', forkOrigin: null },
    ]
    const graph = await assembleBranchGraph(branches, 's-a', readerOf(logs).readSession)
    expect(graph.nodes.map(node => node.id)).toEqual(['s-b:2', 's-b:1', 's-a:1'])
  })
})

describe('rpc handler graph endpoint (end-to-end over fake ports)', () => {
  function handlerPorts(options: {
    readonly state: RegistryState
    readonly logs: ReadonlyMap<string, GraphSessionLog>
  }): BranchRpcPorts {
    return {
      async resolveWorkspaceKey(sessionId) {
        // The workspace resolves for every session in the fake logs.
        return options.logs.has(sessionId) ? '/work' : null
      },
      async loadRegistry() {
        return options.state
      },
      readSession: async (sessionId) => options.logs.get(sessionId) ?? null,
      sessionExists: () => true,
    }
  }

  test('serves the assembled graph for the payload session', async () => {
    const { branches, logs } = canonicalWorkspace()
    const state: RegistryState = {
      branches: Object.fromEntries(branches.map(branch => [branch.name, {
        name: branch.name,
        sessionId: branch.sessionId,
        forkOrigin: branch.forkOrigin,
        createdAt: '2026-01-01T00:00:00.000Z',
      }])),
    }
    const handler = createBranchRpcHandler(handlerPorts({ state, logs }))
    // The payload session is the child branch the user is viewing.
    const result = await handler('graph', { sessionId: 's-child' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.head).toBe('s-child:4')
    expect(result.value.nodes).toHaveLength(4)
    expect(result.value.nodes.map(node => node.subject)).toEqual([
      'keep going', 'experiment', 'second prompt', 'first prompt',
    ])
  })

  test('a missing session still folds into an internal error', async () => {
    const handler = createBranchRpcHandler(handlerPorts({ state: { branches: {} }, logs: new Map() }))
    const result = await handler('graph', { sessionId: 's-unknown' })
    expect(result).toEqual({
      ok: false,
      error: { code: 'internal', message: 'no session named "s-unknown" exists', details: {} },
    })
  })

  test('an empty workspace registry serves an empty graph, not an error', async () => {
    const { logs } = canonicalWorkspace()
    // The workspace resolves, but its registry was never written.
    const handler = createBranchRpcHandler(handlerPorts({ state: { branches: {} }, logs }))
    const result = await handler('graph', { sessionId: 's-root' })
    expect(result).toEqual({ ok: true, value: { nodes: [], head: null } })
  })
})

describe('rpc handler turnEvents endpoint (row expansion)', () => {
  function handlerPorts(options: {
    readonly state?: RegistryState
    readonly logs: ReadonlyMap<string, GraphSessionLog>
  }): BranchRpcPorts {
    return {
      async resolveWorkspaceKey() {
        return options.logs.size > 0 ? '/work' : null
      },
      async loadRegistry() {
        return options.state ?? { branches: {} }
      },
      readSession: async (sessionId) => options.logs.get(sessionId) ?? null,
      sessionExists: () => true,
    }
  }

  /** A rich turn: human prompt, assistant text, a tool call, plain markers. */
  function richSessionEvents(): GraphEvent[] {
    return [
      { seq: 0, type: 'turn/start', time: 1, data: { turn: 7 } },
      {
        seq: 1, type: 'user/message', time: 1,
        data: {
          role: 'user',
          content: [{ type: 'text', text: 'list the files' }],
          source: { kind: 'user' },
        },
      },
      { seq: 2, type: 'step/start', time: 2, data: { turn: 7, step: 1 } },
      {
        seq: 3, type: 'tool/call', time: 2,
        data: { turn: 7, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls -la"}' },
      },
      {
        seq: 4, type: 'tool/result', time: 3,
        data: { turn: 7, step: 1, callId: 'c1', content: [] },
      },
      {
        seq: 5, type: 'assistant/message', time: 4,
        data: {
          turn: 7, step: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: 'here is the listing' }] },
        },
      },
      { seq: 6, type: 'step/end', time: 5, data: { turn: 7, step: 1 } },
      { seq: 7, type: 'turn/end', time: 5, data: { turn: 7, reason: { kind: 'completed' } } },
    ]
  }

  test('serves every event of the turn span with one-line summaries', async () => {
    const logs = new Map([['s-rich', { header: {}, events: richSessionEvents() }]])
    const handler = createBranchRpcHandler(handlerPorts({ logs }))
    const result = await handler('turnEvents', { sessionId: 's-rich', turn: 7 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.events).toEqual([
      { seq: 0, type: 'turn/start', text: 'turn/start' },
      { seq: 1, type: 'user/message', text: 'list the files' },
      { seq: 2, type: 'step/start', text: 'step/start' },
      { seq: 3, type: 'tool/call', text: 'tool bash: {"command":"ls -la"}' },
      { seq: 4, type: 'tool/result', text: 'tool/result' },
      { seq: 5, type: 'assistant/message', text: 'here is the listing' },
      { seq: 6, type: 'step/end', text: 'step/end' },
      { seq: 7, type: 'turn/end', text: 'turn/end' },
    ])
  })

  test('long texts are cut and marked as truncated', async () => {
    const long = 'x'.repeat(300)
    const events = [
      { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } },
      {
        seq: 1, type: 'user/message', time: 1,
        data: {
          role: 'user',
          content: [{ type: 'text', text: long }],
          source: { kind: 'user' },
        },
      },
      { seq: 2, type: 'turn/end', time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const logs = new Map([['s-long', { header: {}, events }]])
    const handler = createBranchRpcHandler(handlerPorts({ logs }))
    const result = await handler('turnEvents', { sessionId: 's-long', turn: 1 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const text = result.value.events[1]?.text ?? ''
    expect(text.length).toBeLessThan(140)
    expect(text.startsWith('x'.repeat(100))).toBe(true)
    expect(text.endsWith('…(truncated)')).toBe(true)
  })

  test('a synthetic (row-less) or unknown turn yields a readable error', async () => {
    const logs = new Map([['s-rich', { header: {}, events: richSessionEvents() }]])
    const handler = createBranchRpcHandler(handlerPorts({ logs }))
    const result = await handler('turnEvents', { sessionId: 's-rich', turn: 99 })
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'internal',
        message: 'session "s-rich" has no turn 99 on the branch graph',
        details: {},
      },
    })
  })

  test('an unknown session yields a readable error', async () => {
    const handler = createBranchRpcHandler(handlerPorts({ logs: new Map() }))
    const result = await handler('turnEvents', { sessionId: 's-ghost', turn: 1 })
    expect(result).toEqual({
      ok: false,
      error: { code: 'internal', message: 'no session named "s-ghost" exists', details: {} },
    })
  })

  test('a malformed payload is rejected by the schema', async () => {
    const handler = createBranchRpcHandler(handlerPorts({ logs: new Map() }))
    const result = await handler('turnEvents', { sessionId: 's', turn: -1 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('invalid "turnEvents" payload')
  })
})
