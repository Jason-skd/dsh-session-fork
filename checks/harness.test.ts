/** Regression checks against the actual built sibling dsh, run by test:harness. */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CompactionId, isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { buildBranchNotice } from '../src/branch-events.js'
import { buildMergeCheckpoint } from '../src/squash.js'
import { extractTurns } from '../src/graph.js'

const harness = process.env.DSH_HARNESS_DIR
describe.skipIf(harness === undefined)('actual dsh compatibility', () => {
  const load = (path: string) => import(pathToFileURL(join(harness!, path)).href)

  test('the plugin manifest admits the target runtime without exemptions', async () => {
    const { evaluatePluginCompatibility } = await load('packages/boot/app-boot/src/plugin-compatibility.ts')
    const runtime = JSON.parse(readFileSync(join(harness!, 'package.json'), 'utf8'))
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(evaluatePluginCompatibility(manifest, {}, runtime.version)).toBeUndefined()
  })

  test('branch notices survive the actual V4 encoder and decoder', async () => {
    const { releasedV4SessionFormatCodec } = await load('packages/session/session-format-v3-to-v4/src/codec.ts')
    const message = buildBranchNotice({ kind: 'fork', from: 'main', to: 'review' }, 'Forked review')
    const event = { seq: 0, time: 1, type: 'user/message', data: message, surfaceOp: 'append' }
    const header = releasedV4SessionFormatCodec.encodeHeader({
      version: 4,
      id: 'compat-session',
      createdAt: 0,
      isSeeded: false,
      delegationDepth: 0,
    }, 0)
    const decoder = releasedV4SessionFormatCodec.createDecoder(header)
    const restored: unknown[] = []
    decoder.decodeRow(releasedV4SessionFormatCodec.encodeEvent(event), {
      emitEvent: (event: unknown) => restored.push(event),
      emitRun: () => { throw new Error('unexpected run') },
    })
    expect(restored).toEqual([event])
  })

  test('branch notices survive actual V4 disk persistence and reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-fork-v4-'))
    let ctx: any
    try {
      const { Context } = await load('vendor/cordis/src/index.ts')
      const JsonlSessionPersistence = await load('packages/session/session-persistence-jsonl/src/index.ts')
      const { oneTurnLog } = await load('packages/session/session-persistence/tests/contract.ts')
      ctx = new Context()
      const fiber = await ctx.plugin(JsonlSessionPersistence, { root: directory, compression: 'none' })
      const events = oneTurnLog()
      const notice = buildBranchNotice({ kind: 'fork', from: 'main', to: 'review' }, 'Forked review')
      events[1] = { ...events[1], data: notice }
      const header = {
        version: 4,
        id: 'compat-disk-session',
        createdAt: 1,
        isSeeded: false,
        delegationDepth: 0,
      }
      const write = await ctx.sessionPersistence.create(header)
      await write.append(events)
      await write.flush()
      await write.close()
      await fiber.dispose()

      ctx = new Context()
      await ctx.plugin(JsonlSessionPersistence, { root: directory, compression: 'none' })
      const read = await ctx.sessionPersistence.open(header.id, 'read')
      const restored = await read.read()
      await read.close()
      expect(restored.events[1]?.data.source).toEqual({
        kind: 'dsh-session-fork',
        form: 'notice',
        summary: 'fork: main → review',
      })
    } finally {
      await ctx?.fiber.dispose().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('a transferred summary keeps the official checkpoint identity', () => {
    const notice = buildBranchNotice({ kind: 'fork', from: 'main', to: 'review' }, 'Summary')
    const message = buildMergeCheckpoint(notice, { compactionId: CompactionId('compat') }, { child: 'review', target: 'main' })
    expect(isCompactCheckpointSource(message.source)).toBe(true)
  })

  test('a historical merge remains visible after the real V3 source migration', async () => {
    const { rewritePluginSource } = await load('packages/session/session-format-v3-to-v4/src/sources.ts')
    const notice = buildBranchNotice({ kind: 'fork', from: 'main', to: 'review' }, 'Summary')
    const message = buildMergeCheckpoint(notice, { compactionId: CompactionId('compat') }, { child: 'review', target: 'main' })
    const source = rewritePluginSource({ kind: 'plugin', plugin: 'compact', compactionId: 'compat' }, 0, 'user')
    const rows = extractTurns([{ seq: 0, type: 'user/message', data: { ...message, source } }])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.transferOf).toEqual({ kind: 'squash', fromName: 'review' })
  })
})
