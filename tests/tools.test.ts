/**
 * Tests for the agent-facing tool surface (issue #5): argument schemas,
 * caller resolution, delegation into the real executor cores, and result
 * translation — over fake ports (no cordis, no dsh services).
 * @module dsh-session-fork/tests/tools.test
 */

import { describe, expect, test } from 'bun:test'
import { branchToolDefinitions, commandResultToToolValue, registerBranchTools, transferToolDefinitions } from '../src/tools.js'
import type { BranchToolPorts } from '../src/tools.js'
import type { SourceEvent, SourceSessionView } from '../src/branch.js'
import type { RegistryState, RegistryStore } from '../src/types.js'
import type { SquashHandoffDeps } from '../src/squash-midturn.js'
import type { RebasedIntoCommandDeps } from '../src/rebased-into-command.js'

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

/** Minimal exec-context stand-in: the tool's view of one calling agent. */
function execOf(agent?: Record<string, unknown>): {
  agent?: unknown
  signal: AbortSignal
} {
  return {
    ...(agent === undefined ? {} : { agent }),
    signal: new AbortController().signal,
  }
}

interface Harness {
  readonly ports: BranchToolPorts
  readonly commandCalls: Array<{ sessionId: string; workspaceKey: string }>
  readonly branchLookups: string[]
  readonly resolvedSources: string[]
  readonly children: string[]
  readonly renames: Array<{ sessionId: string; title: string }>
  /** Sessions archived through the rm companion (issue #39 semantics). */
  readonly archives: string[]
  readonly store: ReturnType<typeof memoryStore>
  squashCalls: number
  rebasedCalls: number
}

/**
 * Fake ports with REAL executor deps for the registry operations: the
 * `command` factory returns the same deps shape tests/command.test.ts
 * builds, so branch_list/create/adopt run through the genuine core. The
 * transfer bases default to throwers and can be swapped per test.
 */
function harness(seedState: RegistryState | null = null): Harness {
  const store = memoryStore()
  if (seedState !== null) void store.save(seedState)
  const commandCalls: Harness['commandCalls'] = []
  const branchLookups: Harness['branchLookups'] = []
  const resolvedSources: Harness['resolvedSources'] = []
  const children: string[] = []
  const renames: Harness['renames'] = []
  const archives: Harness['archives'] = []
  const h: Harness = {
    store,
    commandCalls,
    branchLookups,
    resolvedSources,
    children,
    renames,
    archives,
    squashCalls: 0,
    rebasedCalls: 0,
    ports: {
      command(sessionId, workspaceKey) {
        commandCalls.push({ sessionId, workspaceKey })
        return {
          currentSessionId: sessionId,
          store,
          sessionExists: (id: string) => id !== 's-gone',
          async archiveSession(id) {
            archives.push(id)
            return id === 's-gone' ? 'missing' : 'archived'
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
        }
      },
      async branchSessionId(_workspaceKey, name) {
        branchLookups.push(name)
        const state = await store.load()
        return state?.branches[name]?.sessionId ?? null
      },
      async resolveSourceAgent(sessionId) {
        resolvedSources.push(sessionId)
        return sessionId === 's-gone' ? null : fakeAgent(sessionId, 'idle')
      },
      squashBase(_workspaceKey) {
        h.squashCalls += 1
        return {
          store,
          compact: () => { throw new Error('compact not reached by these tests') },
          resolveTargetAgent: () => { throw new Error('resolveTargetAgent not reached') },
          flush: () => { throw new Error('flush not reached') },
        } satisfies Omit<SquashHandoffDeps, 'childAgent' | 'signal' | 'commandId'>
      },
      rebasedBase(_workspaceKey) {
        h.rebasedCalls += 1
        return {
          store,
          resolveTargetAgent: () => { throw new Error('resolveTargetAgent not reached') },
          flush: () => { throw new Error('flush not reached') },
        } satisfies Omit<RebasedIntoCommandDeps, 'sourceAgent'>
      },
      trackDetached() {
        /* not reached by these tests */
      },
    },
  }
  return h
}

/** A status-carrying fake agent, the transfer tools' source shape. */
function fakeAgent(sessionId: string, phase: 'idle' | 'running'): Record<string, unknown> {
  return {
    session: { id: sessionId, header: { cwd: '/w' } },
    status: phase,
    inbox: { nextStep: [], nextTurn: [] },
  }
}

/** The calling agent's session, tool-side. */
const CALLER = { session: { id: 's-parent', header: { cwd: '/w' } } }

const toolBy = (defs: ReturnType<typeof branchToolDefinitions> | ReturnType<typeof transferToolDefinitions>, name: string) => {
  const found = defs.find(tool => tool.name === name)
  if (found === undefined) throw new Error(`tool ${name} not defined`)
  return found
}

describe('tool surface shape', () => {
  const h = harness()
  const defs = branchToolDefinitions(h.ports)

  test('one definition per registry operation, unique names', () => {
    const names = defs.map(tool => tool.name)
    expect(names).toEqual(['branch_list', 'branch_create', 'branch_adopt', 'branch_rename', 'branch_remove'])
    expect(new Set(names).size).toBe(names.length)
  })

  test('descriptions and mandatory output schemas are present', () => {
    for (const tool of defs) {
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.output.schema).toBeDefined()
      expect(typeof tool.output.render).toBe('function')
    }
  })
})

describe('commandResultToToolValue', () => {
  test('success maps ok with text, defaulting to ok', () => {
    expect(commandResultToToolValue({ kind: 'success', text: 'done' })).toEqual({ ok: true, message: 'done' })
    expect(commandResultToToolValue({ kind: 'success' })).toEqual({ ok: true, message: 'ok' })
  })

  test('error maps not-ok with the executor text verbatim', () => {
    expect(commandResultToToolValue({ kind: 'error', text: 'nope' })).toEqual({ ok: false, message: 'nope' })
  })
})

describe('caller resolution', () => {
  const h = harness()
  const defs = branchToolDefinitions(h.ports)

  test('without a calling agent every tool refuses canonically', async () => {
    const value = await toolBy(defs, 'branch_list').execute({}, execOf() as never)
    expect(value).toEqual({ ok: false, message: 'no calling agent: this tool runs only inside an agent session' })
  })

  test('the caller\'s session id and workspace cwd reach the command deps', async () => {
    const value = await toolBy(defs, 'branch_list').execute({}, execOf(CALLER) as never)
    expect(value).toEqual({ ok: true, message: expect.stringContaining('No branches') })
    expect(h.commandCalls).toEqual([{ sessionId: 's-parent', workspaceKey: '/w' }])
  })
})

describe('branch_create / branch_adopt', () => {
  test('create forks the calling session through the real core', async () => {
    const h = harness()
    const defs = branchToolDefinitions(h.ports)
    const value = await toolBy(defs, 'branch_create').execute({ name: 'review' }, execOf(CALLER) as never)
    expect(value).toEqual({ ok: true, message: expect.stringContaining('review') })
    expect(h.children.length).toBe(1)
    expect(h.renames).toEqual([{ sessionId: h.children[0]!, title: 'review' }])
    expect(h.store.dump()?.branches['review']).toBeDefined()
  })

  test('adopt registers the calling session as a root branch', async () => {
    const h = harness()
    const defs = branchToolDefinitions(h.ports)
    const value = await toolBy(defs, 'branch_adopt').execute({ name: 'main' }, execOf(CALLER) as never)
    expect(value).toEqual({ ok: true, message: expect.stringContaining('main') })
    expect(h.store.dump()?.branches['main']?.sessionId).toBe('s-parent')
    expect(h.renames).toEqual([{ sessionId: 's-parent', title: 'main' }])
  })

  test('branch_list marks the caller\'s own branch (issue #42)', async () => {
    const h = harness()
    const defs = branchToolDefinitions(h.ports)
    await toolBy(defs, 'branch_adopt').execute({ name: 'main' }, execOf(CALLER) as never)
    await toolBy(defs, 'branch_create').execute({ name: 'side' }, execOf(CALLER) as never)
    const value = await toolBy(defs, 'branch_list').execute({}, execOf(CALLER) as never)
    // CALLER is s-parent — the session `main` was adopted onto — so exactly
    // the main row carries the marker through the shared executor.
    expect(value).toEqual({ ok: true, message: expect.stringContaining('* main') })
    const message = (value as { message: string }).message
    expect(message.split('\n').filter(line => line.startsWith('* '))).toHaveLength(1)
  })

  test('create with a duplicate name surfaces the executor error text', async () => {
    const h = harness({ branches: { review: {
      name: 'review',
      sessionId: 's-existing',
      forkOrigin: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    } } })
    const defs = branchToolDefinitions(h.ports)
    const value = await toolBy(defs, 'branch_create').execute({ name: 'review' }, execOf(CALLER) as never)
    expect(value).toEqual({
      ok: false,
      message: expect.stringContaining('already exists'),
    })
    expect(h.children.length).toBe(0)
  })
})

describe('branch_rename / branch_remove', () => {
  const seeded = (): RegistryState => ({
    branches: {
      main: { name: 'main', sessionId: 's-parent', forkOrigin: null, createdAt: '2026-01-01T00:00:00.000Z' },
      review: {
        name: 'review',
        sessionId: 's-review',
        forkOrigin: { parentSessionId: 's-parent', atSeq: 7 },
        createdAt: '2026-01-02T00:00:00.000Z',
      },
    },
  })

  test('rename rewrites the registry key through the real core', async () => {
    const h = harness(seeded())
    const defs = branchToolDefinitions(h.ports)
    const value = await toolBy(defs, 'branch_rename').execute(
      { from: 'review', to: 'review-2' },
      execOf(CALLER) as never,
    )
    expect(value).toEqual({ ok: true, message: expect.stringContaining('review-2') })
    const branches = h.store.dump()?.branches ?? {}
    expect(branches['review']).toBeUndefined()
    expect(branches['review-2']?.sessionId).toBe('s-review')
  })

  test('remove without confirm refuses with zero side effects', async () => {
    const h = harness(seeded())
    const defs = branchToolDefinitions(h.ports)
    const value = await toolBy(defs, 'branch_remove').execute(
      { name: 'review', confirm: false },
      execOf(CALLER) as never,
    )
    expect(value).toEqual({
      ok: false,
      message: expect.stringContaining('confirm=true'),
    })
    expect(h.store.dump()?.branches['review']).toBeDefined()
    expect(h.commandCalls.length).toBe(0)
  })

  test('remove with confirm drops only the registry record', async () => {
    const h = harness(seeded())
    const defs = branchToolDefinitions(h.ports)
    const value = await toolBy(defs, 'branch_remove').execute(
      { name: 'review', confirm: true },
      execOf(CALLER) as never,
    )
    expect(value).toEqual({ ok: true, message: expect.stringContaining('review') })
    expect(h.store.dump()?.branches['review']).toBeUndefined()
    expect(h.store.dump()?.branches['main']).toBeDefined()
  })
})

describe('transfer tools: squash_into / rebased_into', () => {
  const seeded = (): RegistryState => ({
    branches: {
      main: { name: 'main', sessionId: 's-parent', forkOrigin: null, createdAt: '2026-01-01T00:00:00.000Z' },
      review: {
        name: 'review',
        sessionId: 's-review',
        forkOrigin: { parentSessionId: 's-parent', atSeq: 7 },
        createdAt: '2026-01-02T00:00:00.000Z',
      },
    },
  })

  test('squash_into refuses an unknown from before touching the executor', async () => {
    const h = harness(seeded())
    const defs = transferToolDefinitions(h.ports)
    const value = await toolBy(defs, 'squash_into').execute(
      { into: 'main', from: 'nope' },
      execOf(fakeAgent('s-parent', 'idle')) as never,
    )
    expect(value).toEqual({ ok: false, message: `no branch named 'nope' in this workspace` })
    expect(h.squashCalls).toBe(0)
    expect(h.branchLookups).toEqual(['nope'])
  })

  test('squash_into resolves a named from through the dispatch core', async () => {
    const h = harness(seeded())
    const defs = transferToolDefinitions(h.ports)
    // Idle resolved source + a target that is NOT registered: the real
    // precheck's unknown-target refusal proves the whole wiring ran.
    const value = await toolBy(defs, 'squash_into').execute(
      { into: 'missing', from: 'review' },
      execOf(fakeAgent('s-parent', 'idle')) as never,
    )
    expect(value).toEqual({ ok: false, message: `no branch named 'missing' in this workspace` })
    expect(h.resolvedSources).toEqual(['s-review'])
    expect(h.squashCalls).toBe(1)
  })

  test('squash_into with a running self-source surfaces the inbox guard', async () => {
    const h = harness(seeded())
    const defs = transferToolDefinitions(h.ports)
    const running = {
      ...fakeAgent('s-parent', 'running'),
      inbox: { nextStep: [{}], nextTurn: [] },
    }
    const value = await toolBy(defs, 'squash_into').execute(
      { into: 'main' },
      execOf(running) as never,
    )
    expect(value).toEqual({ ok: false, message: expect.stringContaining('undelivered inbox message') })
  })

  test('rebased_into refuses a running default source with the executor text', async () => {
    const h = harness(seeded())
    const defs = transferToolDefinitions(h.ports)
    const value = await toolBy(defs, 'rebased_into').execute(
      { into: 'main' },
      execOf(fakeAgent('s-parent', 'running')) as never,
    )
    expect(value).toEqual({
      ok: false,
      message: 'Rebased-into is unavailable while this branch is not idle.',
    })
    expect(h.rebasedCalls).toBe(1)
  })

  test('rebased_into refuses an unknown from before touching the executor', async () => {
    const h = harness(seeded())
    const defs = transferToolDefinitions(h.ports)
    const value = await toolBy(defs, 'rebased_into').execute(
      { into: 'main', from: 'nope' },
      execOf(fakeAgent('s-parent', 'idle')) as never,
    )
    expect(value).toEqual({ ok: false, message: `no branch named 'nope' in this workspace` })
    expect(h.rebasedCalls).toBe(0)
  })
})

describe('registerBranchTools', () => {
  test('registers all eight tools and disposes them together', () => {
    const h = harness()
    const registered: string[] = []
    const disposed: string[] = []
    const dispose = registerBranchTools((tool) => {
      registered.push(tool.name)
      return () => { disposed.push(tool.name) }
    }, h.ports)
    expect(registered).toEqual([
      'branch_list', 'branch_create', 'branch_adopt', 'branch_rename', 'branch_remove',
      'squash_into', 'rebased_into', 'send_message_by_branch',
    ])
    expect(disposed.length).toBe(0)
    dispose()
    expect(disposed).toEqual(registered)
  })
})
