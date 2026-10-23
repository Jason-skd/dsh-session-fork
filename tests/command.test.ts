/**
 * Tests for the /branch command family: parsing, rendering, and the
 * execution core over fake deps (no cordis, no dsh services).
 * @module dsh-session-fork/tests/command.test
 */

import { describe, expect, test } from 'bun:test'
import {
  BRANCH_USAGE,
  executeBranchAction,
  parseBranchAction,
} from '../src/command.js'
import type { BranchCommandDeps } from '../src/command.js'
import type { SourceEvent, SourceSessionView } from '../src/branch.js'
import { BranchArchiveError, BranchForkError } from '../src/branch.js'
import type { RegistryState, RegistryStore } from '../src/types.js'

const LOG: readonly string[] = [
  'turn/start',
  'message/user',
  'message/assistant',
  'turn/end',
  'turn/start',
  'message/user',
  'message/assistant',
  'turn/end',
]

function sessionOf(id: string): SourceSessionView {
  let turn = 0
  const events: SourceEvent[] = LOG.map((type, seq) => {
    if (type === 'turn/start') turn += 1
    return type === 'turn/end' ? { seq, type, data: { turn } } : { seq, type }
  })
  return { id, events, header: { cwd: '/w' } }
}

/** In-memory store with restart semantics. */
function memoryStore(): RegistryStore & { dump(): RegistryState | null } {
  let stored: RegistryState | null = null
  return {
    async load() {
      return stored === null ? null : (JSON.parse(JSON.stringify(stored)) as RegistryState)
    },
    async save(state: RegistryState) {
      stored = JSON.parse(JSON.stringify(state)) as RegistryState
    },
    dump() {
      return stored
    },
  }
}

interface Harness {
  readonly deps: BranchCommandDeps
  readonly store: RegistryStore & { dump(): RegistryState | null }
  readonly children: string[]
  readonly renames: Array<{ sessionId: string; title: string }>
  readonly notifications: Array<{ sessionId: string; text: string; summary: string }>
  /** Ordered archive/save interleaving: proves the archive precedes the registry write. */
  readonly archiveOps: Array<{ op: 'archive'; sessionId: string } | { op: 'save' }>
}

function harness(): Harness {
  const inner = memoryStore()
  const children: string[] = []
  const renames: Array<{ sessionId: string; title: string }> = []
  const notifications: Harness['notifications'] = []
  const archiveOps: Harness['archiveOps'] = []
  const store: Harness['store'] = {
    async load() {
      return inner.load()
    },
    async save(state: RegistryState) {
      archiveOps.push({ op: 'save' })
      return inner.save(state)
    },
    dump() {
      return inner.dump()
    },
  }
  return {
    store,
    children,
    renames,
    notifications,
    archiveOps,
    deps: {
      currentSessionId: 's-parent',
      store,
      sessionExists(id) {
        return id !== 's-gone'
      },
      ports: {
        async readSession(sessionId) {
          return sessionId === 's-parent' ? sessionOf('s-parent') : sessionId === 's-cold'
            ? sessionOf('s-cold')
            : null
        },
        async createChildFromSeed(childId) {
          children.push(childId)
        },
        async renameSession(sessionId, title) {
          renames.push({ sessionId, title })
        },
      },
      async archiveSession(sessionId) {
        archiveOps.push({ op: 'archive', sessionId })
        return sessionId === 's-gone' ? 'missing' : 'archived'
      },
      async notifySession(sessionId, notice) {
        notifications.push({
          sessionId,
          text: (notice.content[0] as { type: 'text'; text: string }).text,
          summary: notice.source.kind === 'dsh-session-fork' ? notice.source.summary : '',
        })
      },
    },
  }
}

describe('parseBranchAction', () => {
  test('bare input lists', () => {
    expect(parseBranchAction('')).toEqual({ kind: 'list' })
    expect(parseBranchAction('  list ')).toEqual({ kind: 'list' })
    expect(parseBranchAction('list x').kind).toBe('usage')
  })

  test('single token creates', () => {
    expect(parseBranchAction('review')).toEqual({ kind: 'create', name: 'review' })
    expect(parseBranchAction('create review')).toEqual({ kind: 'create', name: 'review' })
    expect(parseBranchAction('create')).toEqual({
      kind: 'usage',
      problem: `'create' takes exactly one branch name`,
    })
  })

  test('rm requires a name; --yes marks confirmation', () => {
    expect(parseBranchAction('rm main')).toEqual({ kind: 'rm', name: 'main', confirmed: false })
    expect(parseBranchAction('rm main --yes')).toEqual({ kind: 'rm', name: 'main', confirmed: true })
    expect(parseBranchAction('rm').kind).toBe('usage')
    expect(parseBranchAction('rm main --force').kind).toBe('usage')
  })

  test('rename takes exactly two names', () => {
    expect(parseBranchAction('rename a b')).toEqual({ kind: 'rename', from: 'a', to: 'b' })
    expect(parseBranchAction('rename a').kind).toBe('usage')
  })

  test('help and unknown subcommands render usage', () => {
    expect(parseBranchAction('help')).toEqual({ kind: 'usage', problem: '' })
    expect(parseBranchAction('frob a b').kind).toBe('usage')
  })
})

describe('executeBranchAction', () => {
  test('create forks the current session and persists the ref', async () => {
    const h = harness()
    const result = await executeBranchAction(
      parseBranchAction('review'),
      h.deps,
    )
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.text).toContain('review')
      expect(result.text).toContain('(turn end)')
    }
    expect(h.children).toHaveLength(1)
    // Issue #7: the fork is followed by an in-place rename pinning the
    // branch name as the child's title.
    expect(h.renames).toEqual([{ sessionId: h.children[0], title: 'review' }])
    const state = h.store.dump()
    expect(state!.branches['review']!.forkOrigin).toEqual({
      parentSessionId: 's-parent',
      atSeq: 7,
    })
  })

  test('create notifies the parent branch through the never-throw channel', async () => {
    // Issue #28: a successful create delivers a one-line fork notice into
    // the parent session AFTER the registry write, naming branch and turn.
    const h = harness()
    await executeBranchAction(parseBranchAction('review'), h.deps)
    expect(h.notifications).toEqual([{
      sessionId: 's-parent',
      text: 'Branch "review" forked from you at turn 2.',
      summary: 'fork: s-parent → review',
    }])
  })

  test('the parent notice names the registry branch when the source is adopted', async () => {
    const h = harness()
    await executeBranchAction(parseBranchAction('adopt main'), h.deps)
    await executeBranchAction(parseBranchAction('review'), h.deps)
    // Adopt now notifies too (issue #37): first the adoption notice into
    // the adopted session itself, then the fork parent notice.
    expect(h.notifications).toHaveLength(2)
    expect(h.notifications[0]!.text).toBe(
      'This session is now branch "main" — the root branch of this workspace (adopted via /branch adopt). '
      + 'The conversation is your own work. Treat branch-scoped operations (fork from here, squash into you, '
      + 'rebased into you) as applying to this session.',
    )
    expect(h.notifications[1]!.text).toBe('Branch "review" forked from you at turn 2.')
    // The fork facts (issue #28) resolved the registry name "main" — the
    // summary's `from` proves the seed notice named the branch, not the id.
    expect(h.notifications[1]!.summary).toBe('fork: main → review')
  })

  test('duplicate name is a clear error and registry is unchanged', async () => {
    const h = harness()
    await executeBranchAction(parseBranchAction('review'), h.deps)
    const result = await executeBranchAction(parseBranchAction('review'), h.deps)
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.text).toContain('already exists')
    expect(Object.keys(h.store.dump()!.branches)).toEqual(['review'])
  })

  test('duplicate name fails before forking, orphaning no child session', async () => {
    const h = harness()
    await executeBranchAction(parseBranchAction('review'), h.deps)
    const before = h.children.length
    const result = await executeBranchAction(parseBranchAction('review'), h.deps)
    expect(result.kind).toBe('error')
    // The name pre-check runs ahead of the fork, so no second child is
    // spawned for a name that can never be registered.
    expect(h.children).toHaveLength(before)
  })

  test('rename rejection after fork surfaces as an error without a registry write', async () => {
    const h = harness()
    h.deps = {
      ...h.deps,
      ports: {
        ...h.deps.ports,
        async renameSession() {
          throw new BranchForkError(
            'rename-failed',
            'session rename rejected: title-invalid: session title must contain visible characters',
          )
        },
      },
    }
    const result = await executeBranchAction(parseBranchAction('review'), h.deps)
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.text).toContain('title-invalid')
    // The fork already happened (the child stays listed as an anonymous
    // session), but no ref is written for a name whose title could not be
    // pinned — the registry gate makes this path an internal anomaly only.
    expect(h.children).toHaveLength(1)
    expect(h.store.dump()).toBeNull()
  })

  test('invalid name fails before forking', async () => {
    const h = harness()
    // Single token containing a control char: parses as `create`, but the
    // name itself is invalid, so it must fail before any fork happens.
    const result = await executeBranchAction(parseBranchAction('a\u0000b'), h.deps)
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.text).toContain('Invalid branch name')
    expect(h.children).toHaveLength(0)
    expect(h.store.dump()).toBeNull()
  })

  test('cold source still creates a branch through the same route', async () => {
    const h = harness()
    h.deps = { ...h.deps, currentSessionId: 's-cold' }
    const result = await executeBranchAction(parseBranchAction('cold'), h.deps)
    expect(result.kind).toBe('success')
    expect(h.children).toHaveLength(1)
  })

  test('missing source session is a clear error', async () => {
    const h = harness()
    h.deps = { ...h.deps, currentSessionId: 'ghost' }
    const result = await executeBranchAction(parseBranchAction('x'), h.deps)
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.text).toContain('ghost')
  })

  test('list marks the invoking session\'s own branch (issue #42)', async () => {
    const h = harness()
    // s-parent (the harness's invoking session) adopts root `main`; `side`
    // is a fork whose record points at its own child session.
    await executeBranchAction(parseBranchAction('adopt main'), h.deps)
    await executeBranchAction(parseBranchAction('side'), h.deps)
    const result = await executeBranchAction(parseBranchAction('list'), h.deps)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      const lines = result.text.split('\n')
      const mainLine = lines.find(line => line.includes('main'))!
      const sideLine = lines.find(line => line.includes('side'))!
      expect(mainLine.startsWith('* ')).toBe(true)
      expect(sideLine.startsWith('  ')).toBe(true)
      // Exactly one marker row: the invoking session owns exactly `main`.
      expect(lines.filter(line => line.startsWith('* '))).toHaveLength(1)
    }
  })

  test('a session owning no branch lists every row unmarked (issue #42)', async () => {
    const h = harness()
    await executeBranchAction(parseBranchAction('a'), h.deps)
    await executeBranchAction(parseBranchAction('b'), h.deps)
    const result = await executeBranchAction(parseBranchAction('list'), h.deps)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.text).toContain('a')
      expect(result.text).not.toContain('*')
    }
  })

  test('list marks dangling branches', async () => {
    const h = harness()
    // One live branch pointing at the parent, one pointing at s-gone.
    await executeBranchAction(parseBranchAction('live'), h.deps)
    await executeBranchAction(parseBranchAction('live2'), h.deps)
    const state = h.store.dump()!
    h.store.save({
      branches: {
        ...state.branches,
        gone: {
          name: 'gone',
          sessionId: 's-gone',
          forkOrigin: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      },
    })
    const result = await executeBranchAction(parseBranchAction('list'), h.deps)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.text).toContain('gone')
      expect(result.text).toContain('dangling')
      expect(result.text).not.toContain('live [dangling')
      // s-parent owns none of these branches: no marker row (issue #42).
      expect(result.text).not.toContain('*')
    }
  })

  test('empty registry lists a hint', async () => {
    const h = harness()
    const result = await executeBranchAction(parseBranchAction('list'), h.deps)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.text).toContain('No branches')
  })

  test('adopt registers the current session as the root branch', async () => {
    const h = harness()
    const result = await executeBranchAction(parseBranchAction('adopt main'), h.deps)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.text).toContain('root branch')
    const record = h.store.dump()!.branches['main']!
    expect(record.sessionId).toBe('s-parent')
    expect(record.forkOrigin).toBeNull()
    // Adopting never forks: no child session was created.
    expect(h.children).toHaveLength(0)
    // The adopted session is renamed in place to the branch name.
    expect(h.renames).toEqual([{ sessionId: 's-parent', title: 'main' }])
  })

  test('adopt notifies the adopted session after the durable write', async () => {
    // Issue #37: adoption tells the model it IS a branch — delivered into
    // the adopted session itself, through the never-throw channel.
    const h = harness()
    const result = await executeBranchAction(parseBranchAction('adopt main'), h.deps)
    expect(result.kind).toBe('success')
    expect(h.notifications).toEqual([{
      sessionId: 's-parent',
      text:
        'This session is now branch "main" — the root branch of this workspace (adopted via /branch adopt). '
        + 'The conversation is your own work. Treat branch-scoped operations (fork from here, squash into you, '
        + 'rebased into you) as applying to this session.',
      summary: 'adopt: s-parent → main',
    }])
    // The notice rides AFTER the registry write: the ref exists first.
    expect(h.store.dump()!.branches['main']).toBeDefined()
  })

  test('adopt with a duplicate name is a clear error', async () => {
    const h = harness()
    await executeBranchAction(parseBranchAction('adopt main'), h.deps)
    const result = await executeBranchAction(parseBranchAction('adopt main'), h.deps)
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.text).toContain('already exists')
  })

  test('adopt of a missing session is a clear error', async () => {
    const h = harness()
    h.deps = { ...h.deps, currentSessionId: 'ghost' }
    const result = await executeBranchAction(parseBranchAction('adopt main'), h.deps)
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.text).toContain('ghost')
    expect(h.store.dump()).toBeNull()
  })

  test('adopt parses strictly', () => {
    expect(parseBranchAction('adopt')).toEqual({
      kind: 'usage',
      problem: `'adopt' takes exactly one branch name`,
    })
    expect(parseBranchAction('adopt a b').kind).toBe('usage')
  })

  test('rm without --yes refuses and states the archive consequence', async () => {
    const h = harness()
    await executeBranchAction(parseBranchAction('review'), h.deps)
    const refused = await executeBranchAction(parseBranchAction('rm review'), h.deps)
    expect(refused.kind).toBe('error')
    if (refused.kind === 'error') {
      expect(refused.text).toContain('--yes')
      expect(refused.text).toContain('archive its session')
      expect(refused.text).toContain('Session data is kept')
    }
    expect(h.store.dump()!.branches['review']).toBeDefined()
    // No archive side effect before --yes (the lone save is the create's).
    expect(h.archiveOps.filter(op => op.op === 'archive')).toEqual([])
  })

  test('rm --yes archives the session BEFORE the registry write', async () => {
    const h = harness()
    await executeBranchAction(parseBranchAction('review'), h.deps)
    h.archiveOps.length = 0 // drop the create's save; observe the rm act alone
    const removed = await executeBranchAction(parseBranchAction('rm review --yes'), h.deps)
    expect(removed.kind).toBe('success')
    if (removed.kind === 'success') {
      expect(removed.text).toContain('archived')
      expect(removed.text).toContain('review')
    }
    // The archived id is exactly the created branch's child session, and
    // the load-bearing order holds: archive precedes the durable save.
    expect(h.archiveOps.filter(op => op.op === 'archive'))
      .toEqual([{ op: 'archive', sessionId: h.children[0]! }])
    const saveIndex = h.archiveOps.findIndex(op => op.op === 'save')
    expect(saveIndex).toBe(h.archiveOps.length - 1)
    expect(h.store.dump()!.branches['review']).toBeUndefined()
  })

  test('rm --yes of a dangling ref skips the archive and still deletes', async () => {
    const h = harness()
    await executeBranchAction(parseBranchAction('review'), h.deps)
    // Force the record dangling: the branch's session no longer exists.
    const state = h.store.dump()!
    const record = Object.values(state.branches).find(b => b.name === 'review')!
    const gone = { ...state, branches: { ...state.branches, review: { ...record, sessionId: 's-gone' } } }
    await h.store.save(gone)
    h.archiveOps.length = 0 // drop the fixture write; observe the rm act alone
    const removed = await executeBranchAction(parseBranchAction('rm review --yes'), h.deps)
    expect(removed.kind).toBe('success')
    if (removed.kind === 'success') expect(removed.text).toContain('already missing')
    expect(h.archiveOps.filter(op => op.op === 'archive')).toEqual([{ op: 'archive', sessionId: 's-gone' }])
    expect(h.store.dump()!.branches['review']).toBeUndefined()
  })

  test('rm --yes aborts on archive failure with the registry untouched', async () => {
    const h = harness()
    await executeBranchAction(parseBranchAction('review'), h.deps)
    const state = h.store.dump()!
    const before = JSON.stringify(state)
    const failing: typeof h.deps = {
      ...h.deps,
      archiveSession: async () => {
        throw new BranchArchiveError('session archive rejected: storage: boom')
      },
    }
    const result = await executeBranchAction(parseBranchAction('rm review --yes'), failing)
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.text).toContain('archive rejected')
    expect(JSON.stringify(h.store.dump())).toBe(before) // no save happened
    expect(h.store.dump()!.branches['review']).toBeDefined()
  })

  test('rm of an unknown branch is a clear error', async () => {
    const h = harness()
    const result = await executeBranchAction(parseBranchAction('rm ghost --yes'), h.deps)
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.text).toContain('ghost')
  })

  test('rename guards duplicates and unknowns', async () => {
    const h = harness()
    await executeBranchAction(parseBranchAction('a'), h.deps)
    await executeBranchAction(parseBranchAction('b'), h.deps)
    const dup = await executeBranchAction(parseBranchAction('rename a b'), h.deps)
    expect(dup.kind).toBe('error')
    const unknown = await executeBranchAction(parseBranchAction('rename x y'), h.deps)
    expect(unknown.kind).toBe('error')
    if (unknown.kind === 'error') expect(unknown.text).toContain('x')
    const ok = await executeBranchAction(parseBranchAction('rename a c'), h.deps)
    expect(ok.kind).toBe('success')
    const state = h.store.dump()!
    expect(state.branches['c']).toBeDefined()
    expect(state.branches['a']).toBeUndefined()
  })

  test('rename notifies the renamed branch session after the durable write', async () => {
    // Issue #37: the renamed branch's session learns the vocabulary change
    // — from is the OLD name, to the NEW one, old name no longer resolves.
    const h = harness()
    await executeBranchAction(parseBranchAction('a'), h.deps)
    const childSessionId = h.children[0]!
    const ok = await executeBranchAction(parseBranchAction('rename a c'), h.deps)
    expect(ok.kind).toBe('success')
    // The create's fork-parent notice came first; the rename notice is the
    // last one, addressed to the renamed branch's own session.
    expect(h.notifications).toHaveLength(2)
    expect(h.notifications[1]).toEqual({
      sessionId: childSessionId,
      text:
        'Your branch was renamed: "a" is now "c". '
        + 'Use "c" in branch commands (/squash into, /rebased into, /branch rm). '
        + 'Earlier notices may still say "a" — they were true when written.',
      summary: 'rename: a → c',
    })
    // The notice rides AFTER the registry write: the new key exists first.
    expect(h.store.dump()!.branches['c']).toBeDefined()
  })

  test('a missing notice channel never fails the command', async () => {
    // `notifySession` is optional: without it the rename succeeds exactly
    // as before (the never-throw burden sits on implementations, src/index.ts).
    const h = harness()
    await executeBranchAction(parseBranchAction('a'), h.deps)
    const { notifySession: _omitted, ...bare } = h.deps
    const ok = await executeBranchAction(parseBranchAction('rename a c'), bare)
    expect(ok.kind).toBe('success')
    expect(h.store.dump()!.branches['c']).toBeDefined()
  })

  test('usage action renders the usage block', async () => {
    const h = harness()
    const result = await executeBranchAction(
      parseBranchAction('frob a'),
      h.deps,
    )
    expect(result.kind).toBe('error')
    if (result.kind === 'error') {
      expect(result.text).toContain('unknown subcommand')
      expect(result.text).toContain(BRANCH_USAGE)
    }
  })
})
