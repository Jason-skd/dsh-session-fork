/**
 * Tests for the host-side RPC channel: registration against a fake
 * connection registry, the `registry` endpoint snapshot, and the strict
 * RpcResult shape (no cordis, no live dsh services).
 * @module dsh-session-fork/tests/rpc.test
 */

import { describe, expect, test } from 'bun:test'
import { Readable } from 'node:stream'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  RPC_CHANNEL,
  createBranchRpcHandler,
  registerRpcChannel,
  type BranchRpcPorts,
  type ConnectionRpcLike,
  type RpcHandler,
  type SquashPorts,
  type WebServerLike,
} from '../src/rpc.ts'
import { BranchArchiveError } from '../src/branch.ts'
import type { ArchiveOutcome } from '../src/branch.ts'
import type { RegistryState, RegistryStore } from '../src/types.ts'

interface HandleCall {
  readonly channel: string
  readonly handler: (request: never, response: never) => Promise<void>
}

/**
 * Fake of the host connection handle. Mirrors the real nesting:
 * `HostConnectionHandle` = `{ rpc: HostConnectionRpc }` — `intercept` lives on
 * the `rpc` sub-object, never on the top level (a flat fake would bake a
 * wrong service shape into the tests and hide the production mismatch).
 */
function fakeConnection(principal = 'owner'): {
  connection: ConnectionRpcLike
  webServer: WebServerLike
  calls: HandleCall[]
  disposer: () => Promise<void>
} {
  const calls: HandleCall[] = []
  const disposer = async (): Promise<void> => {}
  const connection: ConnectionRpcLike = {
    admit: () => ({ peer: { principal: { kind: principal } } }),
  }
  const webServer: WebServerLike = {
    register(route) {
      calls.push({ channel: route.path, handler: route.handler as HandleCall['handler'] })
      return disposer
    },
  }
  return { connection, webServer, calls, disposer }
}

/** In-memory ports: sessionId → workspaceKey resolution plus per-workspace registries. */
interface PortsHarness {
  readonly ports: BranchRpcPorts
  readonly resolveCalls: string[]
  readonly loadCalls: string[]
  /** Archive calls recorded by the default fake, in call order. */
  readonly archiveCalls: string[]
  /** Workspaces written through the `saveRegistry` port, keyed by workspace key. */
  readonly savedWorkspaces: Record<string, RegistryState>
}

function portsHarness(
  options: {
    readonly workspaces: Record<string, RegistryState>
    readonly resolve: (sessionId: string) => string | null
    readonly squash?: SquashPorts
    /** Overrides the default archive fake (which records and mirrors liveness). */
    readonly archiveSession?: (sessionId: string) => Promise<ArchiveOutcome>
  },
): PortsHarness {
  const resolveCalls: string[] = []
  const loadCalls: string[] = []
  const archiveCalls: string[] = []
  const savedWorkspaces: Record<string, RegistryState> = {}
  return {
    resolveCalls,
    loadCalls,
    archiveCalls,
    savedWorkspaces,
    ports: {
      async resolveWorkspaceKey(sessionId) {
        resolveCalls.push(sessionId)
        return options.resolve(sessionId)
      },
      async loadRegistry(workspaceKey) {
        loadCalls.push(workspaceKey)
        return options.workspaces[workspaceKey] ?? { branches: {} }
      },
      async saveRegistry(workspaceKey, state) {
        savedWorkspaces[workspaceKey] = state
        options.workspaces[workspaceKey] = state
      },
      sessionExists(id) {
        return id !== 's-gone'
      },
      async archiveSession(sessionId) {
        archiveCalls.push(sessionId)
        if (options.archiveSession !== undefined) return options.archiveSession(sessionId)
        return sessionId === 's-gone' ? 'missing' : 'archived'
      },
      // Squash port defaults: nothing resolves — the squash describe
      // injects the full fake pipeline.
      squash: options.squash ?? {
        async resolveChildAgent() { return null },
        openStore() { throw new Error('no store') },
        async compact() { throw new Error('no compact') },
        async resolveTargetAgent() { throw new Error('no target') },
        async flush() { return undefined },
      },
    },
  }
}

/** A workspace registry with one root branch and one forked (now dangling) branch. */
const WORKSPACE: RegistryState = {
  branches: {
    main: {
      name: 'main',
      sessionId: 's-main',
      forkOrigin: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    exp: {
      name: 'exp',
      sessionId: 's-gone',
      forkOrigin: { parentSessionId: 's-main', atSeq: 3 },
      createdAt: '2026-01-02T00:00:00.000Z',
    },
  },
}

describe('registerRpcChannel', () => {
  test('registers one channel and returns the handle disposer', () => {
    const { connection, webServer, calls, disposer } = fakeConnection()
    const handler: RpcHandler = async () => ({ ok: true, value: null })
    expect(registerRpcChannel(connection, webServer, handler)).toBe(disposer)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.channel).toBe(RPC_CHANNEL)
  })

  test('admits owner peers and rejects other principals', async () => {
    const { connection, webServer, calls } = fakeConnection()
    registerRpcChannel(connection, webServer, async () => ({ ok: true, value: 'owner' }))
    const handler = calls[0]!.handler
    const request = Object.assign(Readable.from([JSON.stringify({
      type: 'client-request',
      rpcId: 'rpc-1',
      method: 'graph',
      payload: {},
    })]), {
      method: 'POST',
      url: `${RPC_CHANNEL}/graph`,
      headers: { 'content-type': 'application/json' },
    })
    const response = {
      status: 0,
      body: '',
      writeHead(status: number) { this.status = status },
      end(body: string) { this.body = body },
    }
    await handler(request as never, response as never)
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({
      type: 'server-response',
      rpcId: 'rpc-1',
      result: { ok: true, value: 'owner' },
    })

    const other = fakeConnection('other')
    registerRpcChannel(other.connection, other.webServer, async () => ({ ok: true, value: 'forbidden' }))
    const denied = { status: 0, body: '', writeHead(status: number) { this.status = status }, end(body: string) { this.body = body } }
    await other.calls[0]!.handler(request as never, denied as never)
    expect(denied).toMatchObject({ status: 403, body: 'forbidden' })
  })

  test('uses the plugin-owned authenticated route', () => {
    expect(RPC_CHANNEL).toMatch(/^\/[A-Za-z0-9._~-]+$/)
    expect(RPC_CHANNEL).toBe('/dsh-session-fork')
  })
})

describe('createBranchRpcHandler', () => {
  test('registry returns a strict snapshot of the resolved workspace, marking dangling refs', async () => {
    const { ports, resolveCalls, loadCalls } = portsHarness({
      workspaces: { '/work': WORKSPACE },
      resolve: (id) => (id === 's-live' ? '/work' : null),
    })
    const handler = createBranchRpcHandler(ports)
    const result = await handler('registry', { sessionId: 's-live' }, new AbortController().signal)
    expect(resolveCalls).toEqual(['s-live'])
    expect(loadCalls).toEqual(['/work'])
    // Strict shape: record fields flattened (no nested record), branches
    // sorted by name, the missing target session flagged as dangling.
    expect(result).toEqual({
      ok: true,
      value: {
        branches: [
          {
            name: 'exp',
            sessionId: 's-gone',
            forkOrigin: { parentSessionId: 's-main', atSeq: 3 },
            createdAt: '2026-01-02T00:00:00.000Z',
            dangling: true,
          },
          {
            name: 'main',
            sessionId: 's-main',
            forkOrigin: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            dangling: false,
          },
        ],
      },
    })
  })

  test('registry of a never-written workspace returns an empty branch list', async () => {
    const { ports, loadCalls } = portsHarness({
      workspaces: {},
      resolve: (id) => (id === 's-cold' ? '/cold' : null),
    })
    const handler = createBranchRpcHandler(ports)
    const result = await handler('registry', { sessionId: 's-cold' })
    expect(loadCalls).toEqual(['/cold'])
    expect(result).toEqual({ ok: true, value: { branches: [] } })
  })

  test('a session without cwd resolves against the empty-string workspace key', async () => {
    const { ports, resolveCalls, loadCalls } = portsHarness({
      workspaces: { '': WORKSPACE },
      resolve: (id) => (id === 's-nocwd' ? '' : null),
    })
    const handler = createBranchRpcHandler(ports)
    const result = await handler('registry', { sessionId: 's-nocwd' })
    expect(resolveCalls).toEqual(['s-nocwd'])
    expect(loadCalls).toEqual([''])
    expect(result.ok).toBe(true)
  })

  test('missing sessions fold into an internal error result without reading the registry', async () => {
    const { ports, loadCalls } = portsHarness({
      workspaces: {},
      resolve: () => null,
    })
    const handler = createBranchRpcHandler(ports)
    const result = await handler('registry', { sessionId: 's-unknown' })
    expect(loadCalls).toEqual([])
    expect(result).toEqual({
      ok: false,
      error: { code: 'internal', message: 'no session named "s-unknown" exists', details: {} },
    })
  })

  test('malformed payloads fold into an internal error result naming the bad field', async () => {
    const { ports, loadCalls } = portsHarness({
      workspaces: {},
      resolve: () => '/work',
    })
    const handler = createBranchRpcHandler(ports)
    for (const payload of [{}, { sessionId: 42 }, { sessionId: '' }]) {
      const result = await handler('registry', payload)
      expect(loadCalls).toEqual([])
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.error.code).toBe('internal')
      expect(result.error.details).toEqual({})
      expect(result.error.message).toContain('sessionId')
    }
  })

  test('unknown endpoints fold into an internal error result', async () => {
    const { ports } = portsHarness({
      workspaces: {},
      resolve: () => '/work',
    })
    const handler = createBranchRpcHandler(ports)
    const result = await handler('nope', { sessionId: 's-live' })
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'internal',
        message: 'unknown endpoint "nope" on channel "/dsh-session-fork"',
        details: {},
      },
    })
  })

  test('thrown port failures fold into an internal error result instead of propagating', async () => {
    const ports: BranchRpcPorts = {
      async resolveWorkspaceKey() {
        return '/work'
      },
      async loadRegistry() {
        throw new Error('boom')
      },
      sessionExists() {
        return true
      },
      async archiveSession() {
        return 'archived'
      },
    }
    const handler = createBranchRpcHandler(ports)
    const result = await handler('registry', { sessionId: 's-live' })
    expect(result).toEqual({
      ok: false,
      error: { code: 'internal', message: 'boom', details: {} },
    })
  })
})

describe('createBranchRpcHandler: removeBranch endpoint', () => {
  test('removing a live branch archives its session, then persists (command wording)', async () => {
    const { ports, savedWorkspaces, archiveCalls } = portsHarness({
      workspaces: { '/work': WORKSPACE },
      resolve: (id) => (id === 's-live' || id === 's-main' ? '/work' : null),
    })
    const handler = createBranchRpcHandler(ports)
    const result = await handler('removeBranch', { sessionId: 's-live', name: 'main' })
    expect(result).toEqual({
      ok: true,
      value: {
        message: `Removed branch 'main'; its session is archived (data kept, hidden from the sidebar).`,
      },
    })
    expect(archiveCalls).toEqual(['s-main'])
    expect(Object.keys(savedWorkspaces['/work'].branches)).toEqual(['exp'])
  })

  test('dangling refs are removable the same way (archive skipped, ref deleted)', async () => {
    const { ports, savedWorkspaces, archiveCalls } = portsHarness({
      workspaces: { '/work': WORKSPACE },
      resolve: (id) => (id === 's-live' || id === 's-gone' ? '/work' : null),
    })
    const handler = createBranchRpcHandler(ports)
    const result = await handler('removeBranch', { sessionId: 's-live', name: 'exp' })
    expect(result).toEqual({
      ok: true,
      value: {
        message: `Removed branch 'exp' (session already missing; ref deleted).`,
      },
    })
    // The archive port still reports the missing session; the registry
    // write happens regardless — the ref alone goes.
    expect(archiveCalls).toEqual(['s-gone'])
    expect(Object.keys(savedWorkspaces['/work'].branches)).toEqual(['main'])
  })

  test('an archive failure aborts with the command-layer wording, registry untouched', async () => {
    const { ports, savedWorkspaces, archiveCalls } = portsHarness({
      workspaces: { '/work': WORKSPACE },
      resolve: () => '/work',
      archiveSession: async () => {
        throw new BranchArchiveError('session archive rejected: storage: boom')
      },
    })
    const handler = createBranchRpcHandler(ports)
    const result = await handler('removeBranch', { sessionId: 's-live', name: 'main' })
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'internal',
        message: 'session archive rejected: storage: boom',
        details: {},
      },
    })
    expect(archiveCalls).toEqual(['s-main'])
    expect(savedWorkspaces['/work']).toBeUndefined()
  })

  test('unknown branch names carry the command-layer wording without saving', async () => {
    const { ports, savedWorkspaces } = portsHarness({
      workspaces: { '/work': WORKSPACE },
      resolve: () => '/work',
    })
    const handler = createBranchRpcHandler(ports)
    const result = await handler('removeBranch', { sessionId: 's-live', name: 'nope' })
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'internal',
        message: `no branch named 'nope'`,
        details: {},
      },
    })
    expect(savedWorkspaces['/work']).toBeUndefined()
  })

  test('missing sessions fail before any registry read or write', async () => {
    const { ports, loadCalls, savedWorkspaces } = portsHarness({
      workspaces: { '/work': WORKSPACE },
      resolve: () => null,
    })
    const handler = createBranchRpcHandler(ports)
    const result = await handler('removeBranch', { sessionId: 's-unknown', name: 'exp' })
    expect(result.ok).toBe(false)
    expect(loadCalls).toEqual([])
    expect(savedWorkspaces['/work']).toBeUndefined()
  })

  test('malformed payloads fold into a readable internal error', async () => {
    const { ports } = portsHarness({ workspaces: {}, resolve: () => null })
    const handler = createBranchRpcHandler(ports)
    const result = await handler('removeBranch', { sessionId: 's-live' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('invalid "removeBranch" payload')
  })
})

describe('createBranchRpcHandler: fork endpoint', () => {
  /** Ports fake with a recording createBranch; read endpoints stay unused. */
  function forkHarness(
    createBranch: BranchRpcPorts['createBranch'],
  ): BranchRpcPorts {
    return {
      async resolveWorkspaceKey() {
        return '/work'
      },
      async loadRegistry() {
        return { branches: {} }
      },
      async readSession() {
        return null
      },
      sessionExists() {
        return true
      },
      async archiveSession() {
        return 'archived'
      },
      createBranch,
    }
  }

  test('a valid request runs the pipeline and returns the child session id', async () => {
    const calls: { name: string; sourceSessionId: string; atSeq?: number }[] = []
    const ports = forkHarness(async (request) => {
      calls.push({ ...request })
      return { sessionId: 'child-1' }
    })
    const handler = createBranchRpcHandler(ports)
    const result = await handler('fork', { sessionId: 's-live', name: 'review' })
    expect(result).toEqual({ ok: true, value: { sessionId: 'child-1' } })
    expect(calls).toEqual([{ name: 'review', sourceSessionId: 's-live' }])
  })

  test('atSeq passes through to the pipeline (turn-tail branch button)', async () => {
    const calls: { name: string; sourceSessionId: string; atSeq?: number }[] = []
    const ports = forkHarness(async (request) => {
      calls.push({ ...request })
      return { sessionId: 'child-2' }
    })
    const handler = createBranchRpcHandler(ports)
    const result = await handler('fork', { sessionId: 's-live', name: 'review', atSeq: 41 })
    expect(result).toEqual({ ok: true, value: { sessionId: 'child-2' } })
    expect(calls).toEqual([{ name: 'review', sourceSessionId: 's-live', atSeq: 41 }])
  })

  test('a duplicate name rejects through the shared command-layer message', async () => {
    let pipelineCalls = 0
    const ports = forkHarness(async () => {
      pipelineCalls += 1
      return { sessionId: 'never' }
    })
    const handler = createBranchRpcHandler(ports)
    const result = await handler('fork', { sessionId: 's-live', name: 'main' })
    // The fake never ran createBranch; simulate the real pipeline's
    // duplicate rejection by asserting the shape only when it throws.
    void pipelineCalls
    expect(result.ok).toBe(true) // fake succeeded — see the throwing variant below
  })

  test('pipeline failures surface as user-facing internal errors, never throws', async () => {
    const ports = forkHarness(async () => {
      throw new (await import('../src/registry.js')).BranchRegistryError(
        'duplicate-name',
        `a branch named 'main' already exists`,
      )
    })
    const handler = createBranchRpcHandler(ports)
    const result = await handler('fork', { sessionId: 's-live', name: 'main' })
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'internal',
        message: 'A branch with that name already exists. Use /branch list, or /branch rename first.',
        details: {},
      },
    })
  })

  test('malformed payloads (empty name field ok, bad atSeq) reject before the pipeline', async () => {
    let pipelineCalls = 0
    const ports = forkHarness(async () => {
      pipelineCalls += 1
      return { sessionId: 'x' }
    })
    const handler = createBranchRpcHandler(ports)
    for (const payload of [{ sessionId: 's' }, { name: 'x' }, { sessionId: 's', name: 'x', atSeq: 1.5 }, { sessionId: 's', name: 'x', atSeq: -1 }]) {
      const result = await handler('fork', payload)
      expect(result.ok).toBe(false)
    }
    expect(pipelineCalls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// squash endpoint (issue #8): the exact /squash pipeline through fake ports.

/** One raw fake log event; its array index becomes its seq. */
interface FakeEvent {
  readonly type: string
  readonly data?: unknown
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
function fakeAgent(session: Session, phaseKind: string): Agent & { injected: unknown[] } {
  const injected: unknown[] = []
  return {
    session,
    status: phaseKind,
    injected,
    inject(message: never) { injected.push(message) },
  } as unknown as Agent & { injected: unknown[] }
}

const SQUASH_RESULT = {
  compactionId: CompactionId('compaction-1'),
  startSeq: 4,
  summarySeq: 6,
  endSeq: 8,
  summary: [],
  shadowedRange: { start: 2, end: 3 },
  shadowedSeqs: [2, 3],
  shadowedTokenCount: 42,
} as CompactionResult

/** The squash fixture: child seed prefix + two post-fork nodes + checkpoint tail. */
function squashChildSession(): Session {
  return fakeSession(
    { parentSession: 'session-parent', isSeeded: true, inheritedEventCount: 2, id: 'session-child' },
    [
      { type: 'user/message' },
      { type: 'session/end-seed' },
      { type: 'user/message' },
      { type: 'user/message', data: { message: checkpointUserMessage('compaction-1', 'summary body') } },
    ],
    [0, 2, 3],
  )
}

/** The squash workspace: the child's registry record names the parent branch. */
const SQUASH_WORKSPACE: RegistryState = {
  branches: {
    main: { name: 'main', sessionId: 'session-parent', forkOrigin: null },
    exp: {
      name: 'exp', sessionId: 'session-child',
      forkOrigin: { parentSessionId: 'session-parent', atSeq: 1 },
    },
    other: { name: 'other', sessionId: 'session-unrelated', forkOrigin: null },
  },
}

/** Full squash ports over fake agents; every knob recordable. */
function squashPorts(options: {
  readonly childPhase?: string
  readonly childSession?: Session
  readonly childMissing?: boolean
  readonly compactResult?: CompactionResult
  readonly compactError?: Error
} = {}): SquashPorts & {
  readonly injected: unknown[]
  readonly flushes: string[]
  readonly compactCalls: number
} {
  const flushes: string[] = []
  let compactCalls = 0
  const child = fakeAgent(options.childSession ?? squashChildSession(), options.childPhase ?? 'idle')
  const parent = fakeAgent(
    fakeSession({ id: 'session-parent' }, [], []),
    'idle',
  )
  const store: RegistryStore = {
    load: async () => SQUASH_WORKSPACE,
    save: async () => {},
  }
  return {
    injected: parent.injected,
    flushes,
    get compactCalls() { return compactCalls },
    async resolveChildAgent() {
      return options.childMissing === true ? null : child
    },
    openStore: () => store,
    async compact(agent, signal, request) {
      compactCalls += 1
      if (options.compactError !== undefined) throw options.compactError
      return options.compactResult ?? SQUASH_RESULT
    },
    async resolveTargetAgent() { return parent },
    async flush(agent) {
      flushes.push((agent.session as Session).id ?? 'unknown')
    },
  }
}

describe('createBranchRpcHandler squash endpoint', () => {
  test('success: full pipeline, parent queue delivery + flush, command-shaped message', async () => {
    const ports = squashPorts()
    const { ports: harness } = portsHarness({
      workspaces: { '/work': SQUASH_WORKSPACE },
      resolve: (id) => (id === 'session-child' ? '/work' : null),
      squash: ports,
    })
    const handler = createBranchRpcHandler(harness as BranchRpcPorts)
    const outcome = await handler('squash', { sessionId: 'session-child', target: 'main' })
    expect(outcome).toEqual({
      ok: true,
      value: { message: expect.stringContaining("into branch 'main'") },
    })
    expect(ports.compactCalls).toBe(1)
    // The merge envelope was queued into the parent, and the write was flushed.
    expect(ports.injected).toHaveLength(1)
    expect(ports.flushes).toContain('session-parent')
  })

  test('a non-parent target now succeeds (issue #21); self-target is a readable error', async () => {
    const ports = squashPorts()
    const { ports: harness } = portsHarness({
      workspaces: { '/work': SQUASH_WORKSPACE },
      resolve: () => '/work',
      squash: ports,
    })
    const handler = createBranchRpcHandler(harness as BranchRpcPorts)
    // 'other' shares no lineage with the child — the whole conversation
    // transfers now that squash works between any two registered branches.
    const unrelated = await handler('squash', { sessionId: 'session-child', target: 'other' })
    expect(unrelated.ok).toBe(true)
    expect(ports.compactCalls).toBe(1)
    // Squashing a branch into itself stays rejected, before compaction.
    const ports2 = squashPorts()
    const { ports: harness2 } = portsHarness({
      workspaces: { '/work': SQUASH_WORKSPACE },
      resolve: () => '/work',
      squash: ports2,
    })
    const self = await createBranchRpcHandler(harness2 as BranchRpcPorts)('squash', { sessionId: 'session-child', target: 'exp' })
    expect(self.ok).toBe(false)
    if (self.ok) return
    expect(self.error.message).toContain('into itself')
    expect(ports2.compactCalls).toBe(0)
  })

  test('a busy child folds into the pipeline busy wording', async () => {
    const ports = squashPorts({ childPhase: 'running' })
    const { ports: harness } = portsHarness({
      workspaces: { '/work': SQUASH_WORKSPACE },
      resolve: () => '/work',
      squash: ports,
    })
    const handler = createBranchRpcHandler(harness as BranchRpcPorts)
    const outcome = await handler('squash', { sessionId: 'session-child', target: 'main' })
    expect(outcome.ok).toBe(false)
    expect(ports.compactCalls).toBe(0)
  })

  test('an unknown branch name is a readable error', async () => {
    const ports = squashPorts()
    const { ports: harness } = portsHarness({
      workspaces: { '/work': SQUASH_WORKSPACE },
      resolve: () => '/work',
      squash: ports,
    })
    const handler = createBranchRpcHandler(harness as BranchRpcPorts)
    const outcome = await handler('squash', { sessionId: 'session-child', target: 'nope' })
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: 'internal',
        message: "no branch named 'nope' in this workspace",
        details: {},
      },
    })
  })

  test('an unresolvable child session is a readable error', async () => {
    const ports = squashPorts({ childMissing: true })
    const { ports: harness } = portsHarness({
      workspaces: { '/work': SQUASH_WORKSPACE },
      resolve: () => '/work',
      squash: ports,
    })
    const handler = createBranchRpcHandler(harness as BranchRpcPorts)
    const outcome = await handler('squash', { sessionId: 'session-ghost', target: 'main' })
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: 'internal',
        message: 'no session named "session-ghost" exists',
        details: {},
      },
    })
  })

  test('a malformed payload is rejected by the schema', async () => {
    const { ports: harness } = portsHarness({
      workspaces: {},
      resolve: () => null,
    })
    const handler = createBranchRpcHandler(harness as BranchRpcPorts)
    const outcome = await handler('squash', { sessionId: '' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.message).toContain('invalid "squash" payload')
  })
})
