/**
 * Tests for branch creation: boundary anchoring, the single seeded-child
 * fork route (live and cold sources alike), root adoption, and
 * missing-source errors.
 * @module dsh-session-fork/tests/branch.test
 */

import { describe, expect, test } from 'bun:test'
import type { SourceEvent, SourceSessionView } from '../src/branch.js'
import {
  BranchForkError,
  createBranchFrom,
  createRootBranch,
  forkSeedNoticeEvent,
} from '../src/branch.js'
import { buildBranchNotice, branchNoticeLines } from '../src/branch-events.js'
import type { BranchPorts } from '../src/branch.js'
import { anchoredBoundaryOf } from '../src/vendor/fork.js'

type Call =
  | { readonly kind: 'createChildFromSeed'; readonly sourceId: string; readonly cut: number; readonly childId: string; readonly notified: boolean }
  | { readonly kind: 'renameSession'; readonly sessionId: string; readonly title: string }

/** Build a fake source log from a compact event-type list. */
function sessionOf(id: string, types: readonly string[]): SourceSessionView {
  let turn = 0
  const events: SourceEvent[] = types.map((type, seq) => {
    // turn/end carries its 1-based turn number, like the real log; other
    // event kinds keep `data` absent so structural reads stay exercised.
    if (type === 'turn/start') turn += 1
    return type === 'turn/end' ? { seq, type, data: { turn } } : { seq, type }
  })
  return { id, events, header: {} }
}

/**
 * Fake ports recording every child-creation and rename call. There is
 * exactly one production route — the seeded `agents.create` path — for live
 * and cold sources alike, so the fake needs no liveness scripting.
 */
function portsOf(sessions: readonly SourceSessionView[]): BranchPorts & { calls: readonly Call[] } {
  const calls: Call[] = []
  return {
    calls,
    async readSession(sessionId) {
      return sessions.find(s => s.id === sessionId) ?? null
    },
    async createChildFromSeed(childId, source, cut, forkNotice) {
      calls.push({
        kind: 'createChildFromSeed',
        sourceId: source.id,
        cut,
        childId,
        notified: forkNotice !== undefined,
      })
    },
    async renameSession(sessionId, title) {
      calls.push({ kind: 'renameSession', sessionId, title })
    },
  }
}

describe('anchoredBoundaryOf', () => {
  const log = [
    'turn/start',
    'message/user',
    'message/assistant',
    'turn/end',
    'session/title',
    'turn/start',
    'message/user',
    'message/assistant',
    'turn/end',
  ]

  test('no anchor: last completed turn/end', () => {
    expect(anchoredBoundaryOf(sessionOf('s', log).events)).toEqual({ boundarySeq: 8, cut: 9 })
  })

  test('cut extends through trailing standalone events to the next turn/start', () => {
    const withTail = [...log, 'session/title', 'session/title']
    expect(anchoredBoundaryOf(sessionOf('s', withTail).events)).toEqual({
      boundarySeq: 8,
      cut: 11,
    })
  })

  test('in-log anchor resolves to the turn/end containing it', () => {
    // atSeq 1 lives inside the first turn; its turn/end is seq 3.
    expect(anchoredBoundaryOf(sessionOf('s', log).events, 1)).toEqual({ boundarySeq: 3, cut: 5 })
  })

  test('anchor exactly on a turn/end uses that turn', () => {
    expect(anchoredBoundaryOf(sessionOf('s', log).events, 3)).toEqual({ boundarySeq: 3, cut: 5 })
  })

  test('anchor inside an open (last) turn fails', () => {
    const openLog = [...log, 'turn/start', 'message/user']
    expect(anchoredBoundaryOf(sessionOf('s', openLog).events, 10)).toBeNull()
  })

  test('no completed turn at all fails', () => {
    expect(anchoredBoundaryOf(sessionOf('s', ['turn/start', 'message/user']).events)).toBeNull()
    expect(anchoredBoundaryOf(sessionOf('s', []).events)).toBeNull()
  })

  test('past-end anchor falls back to the last completed turn', () => {
    expect(anchoredBoundaryOf(sessionOf('s', log).events, 999)).toEqual({ boundarySeq: 8, cut: 9 })
  })
})

describe('createBranchFrom', () => {
  const log = [
    'turn/start',
    'message/user',
    'message/assistant',
    'turn/end',
    'session/title',
    'turn/start',
    'message/user',
    'message/assistant',
    'turn/end',
  ]

  test('live and cold sources take the single seeded-child route', async () => {
    // Regression lock: a branch never goes through the kernel
    // SessionStore.fork shortcut. Every child — from a live source read via
    // ctx.sessions or a cold one read via persistence — is produced by one
    // createChildFromSeed call (production: agents.create + workspace
    // attach, exactly like the web GUI's fork).
    const ports = portsOf([sessionOf('parent', log)])
    const live = await createBranchFrom('parent', 'review', ports, { childId: 'child-1' })
    const cold = await createBranchFrom('parent', 'review-2', ports, { childId: 'child-2' })
    expect(live.record.forkOrigin).toEqual({ parentSessionId: 'parent', atSeq: 8 })
    expect(cold.record.forkOrigin).toEqual({ parentSessionId: 'parent', atSeq: 8 })
    expect(ports.calls).toEqual([
      { kind: 'createChildFromSeed', sourceId: 'parent', cut: 9, childId: 'child-1', notified: true },
      { kind: 'renameSession', sessionId: 'child-1', title: 'review' },
      { kind: 'createChildFromSeed', sourceId: 'parent', cut: 9, childId: 'child-2', notified: true },
      { kind: 'renameSession', sessionId: 'child-2', title: 'review-2' },
    ])
  })

  test('rename runs only after the child exists, pinning the branch name as its title', async () => {
    // Issue #7 order lock: create-then-rename, never rename-then-create
    // (the rename targets a session the fork just produced).
    const ports = portsOf([sessionOf('parent', log)])
    await createBranchFrom('parent', 'feature', ports, { childId: 'child-1' })
    expect(ports.calls.map(c => c.kind)).toEqual(['createChildFromSeed', 'renameSession'])
  })

  test('a rejected rename surfaces as rename-failed and yields no record', async () => {
    const ports = portsOf([sessionOf('parent', log)])
    ports.renameSession = async () => {
      throw new BranchForkError('rename-failed', 'session rename rejected: internal: boom')
    }
    try {
      await createBranchFrom('parent', 'x', ports, { childId: 'child-1' })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(BranchForkError)
      expect((error as BranchForkError).code).toBe('rename-failed')
    }
  })

  test('record is frozen and carries the anchoring turn/end', async () => {
    const ports = portsOf([sessionOf('parent', log)])
    const { record } = await createBranchFrom('parent', 'review', ports, { childId: 'child-1' })
    expect(record).toEqual({
      name: 'review',
      sessionId: 'child-1',
      forkOrigin: { parentSessionId: 'parent', atSeq: 8 },
      createdAt: record.createdAt,
    })
    expect(Object.isFrozen(record)).toBe(true)
  })

  test('atSeq lands on the containing turn/end in the record', async () => {
    const ports = portsOf([sessionOf('parent', log)])
    const { record } = await createBranchFrom('parent', 'early', ports, {
      atSeq: 1,
      childId: 'child-3',
    })
    expect(record.forkOrigin!.atSeq).toBe(3)
    // Seed extends through the trailing session/title up to the next
    // turn/start, so the seeded slice is cut 5 events long.
    expect(ports.calls[0]!.cut).toBe(5)
  })

  test('missing source fails with typed error', async () => {
    const ports = portsOf([])
    try {
      await createBranchFrom('ghost', 'x', ports)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(BranchForkError)
      expect((error as BranchForkError).code).toBe('source-not-found')
    }
  })

  test('session with no completed turn fails with fork-unavailable', async () => {
    const ports = portsOf([sessionOf('parent', ['turn/start', 'message/user'])])
    try {
      await createBranchFrom('parent', 'x', ports)
      expect.unreachable()
    } catch (error) {
      expect((error as BranchForkError).code).toBe('fork-unavailable')
    }
  })

  test('generates a session-<uuid> child id when omitted', async () => {
    const ports = portsOf([sessionOf('parent', log)])
    const { record } = await createBranchFrom('parent', 'auto', ports)
    expect(record.sessionId).toMatch(/^session-[0-9a-f-]{36}$/)
  })

  test('seed notice states registry lineage when the parent name is known', async () => {
    // Issue #28: the child's first sight of its own history must name the
    // branches and the fork turn, using the shared branch-events wording.
    const ports = portsOf([sessionOf('parent', log)])
    const { facts } = await createBranchFrom('parent', 'review', ports, {
      childId: 'child-1',
      parentName: 'main',
    })
    expect(facts).toEqual({
      kind: 'fork',
      from: 'main',
      to: 'review',
      atTurn: 2,
    })
  })

  test('seed notice falls back to the source session id for an unnamed parent', async () => {
    const ports = portsOf([sessionOf('parent', log)])
    const { facts } = await createBranchFrom('parent', 'review', ports, { childId: 'child-1' })
    expect(facts.from).toBe('parent')
  })

  test('forkSeedNoticeEvent is a surface-appended user/message at the cut position', async () => {
    const ports = portsOf([sessionOf('parent', log)])
    const { facts } = await createBranchFrom('parent', 'review', ports, { childId: 'child-1' })
    const event = forkSeedNoticeEvent(9, 1_700_000_000_000, buildBranchNotice(
      facts,
      branchNoticeLines.forkChild(facts),
    ))
    expect(event.type).toBe('user/message')
    expect(event.seq).toBe(9)
    expect(event.surfaceOp).toBe('append')
    expect((event.data as { content: readonly { type: string; text: string }[] }).content[0]?.text)
      .toContain('You are branch "review", forked from branch "parent" at turn 2')
    const source = (event.data as { source: Record<string, unknown> }).source
    // The notice source stays inside the frozen plugin vocabulary; the fork
    // facts ride the self-describing text (2026-09-05 source re-baseline).
    expect(Object.keys(source).sort()).toEqual(['form', 'kind', 'summary'])
  })
})

describe('createRootBranch', () => {
  test('adopts an existing session with forkOrigin null and renames it in place', async () => {
    const ports = portsOf([sessionOf('s1', ['turn/end'])])
    const record = await createRootBranch('s1', 'main', ports)
    expect(record).toEqual({
      name: 'main',
      sessionId: 's1',
      forkOrigin: null,
      createdAt: record.createdAt,
    })
    expect(Object.isFrozen(record)).toBe(true)
    // Issue #7: adopting pins the branch name as the session's title.
    expect(ports.calls).toEqual([{ kind: 'renameSession', sessionId: 's1', title: 'main' }])
  })

  test('missing session fails with typed error before any rename', async () => {
    const ports = portsOf([])
    try {
      await createRootBranch('ghost', 'main', ports)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(BranchForkError)
      expect((error as BranchForkError).code).toBe('source-not-found')
    }
    expect(ports.calls).toEqual([])
  })
})
