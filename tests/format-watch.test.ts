/**
 * Format watch tests: run every message source this plugin writes through
 * the current host V4 encoder and require producer-owned attribution.
 * @module dsh-session-fork/tests/format-watch.test
 *
 * The encoder is the source of truth. V4 rejects the retired generic
 * `kind: 'plugin'` wrapper; producers declare their own kind, and official
 * compaction checkpoints keep their correlated identity.
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { releasedV4SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import {
  branchNoticeLines,
  buildBranchEnvelope,
  buildBranchNotice,
  type BranchEventFacts,
} from '../src/branch-events.js'
import { buildMergeCheckpoint } from '../src/squash.js'
import { handoffReport } from '../src/squash-midturn.js'
import type { BranchCommandResult } from '../src/command.js'

function assertAcceptedByV4(message: UserMessage): void {
  expect(() => releasedV4SessionFormatCodec.encodeEvent({
    seq: 0,
    time: 1,
    type: 'user/message',
    data: message,
    surfaceOp: 'append',
  })).not.toThrow()
}

/** Every message a writer can emit, labeled for failure readability. */
function everyPluginMessage(): readonly [label: string, message: UserMessage][] {
  const forkFacts: BranchEventFacts = { kind: 'fork', from: 'main', to: 'review', atTurn: 12 }
  const adoptFacts: BranchEventFacts = { kind: 'adopt', from: 'sess-abc', to: 'main' }
  const renameFacts: BranchEventFacts = { kind: 'rename', from: 'main', to: 'develop' }
  const squashFacts: BranchEventFacts = {
    kind: 'squash', from: 'review', to: 'main', atTurn: 12, range: { start: 13, end: 20 },
  }
  const rebasedIntoFacts: BranchEventFacts = { kind: 'rebased-into', from: 'review', to: 'main' }
  const messageFacts: BranchEventFacts = { kind: 'message', from: 'feat/review', to: 'main' }

  const checkpoint = buildBranchNotice(forkFacts, 'checkpoint placeholder')
  const success: BranchCommandResult = { kind: 'success', text: 'Squashed 3 surface nodes into branch \'main\'.' }
  const failure: BranchCommandResult = { kind: 'error', text: 'Squash is unavailable.' }

  return [
    ['notice: fork child seed', buildBranchNotice(forkFacts, branchNoticeLines.forkChild(forkFacts))],
    ['notice: fork parent', buildBranchNotice(forkFacts, branchNoticeLines.forkParent(forkFacts))],
    ['notice: adopt', buildBranchNotice(adoptFacts, branchNoticeLines.adopted(adoptFacts))],
    ['notice: rename', buildBranchNotice(renameFacts, branchNoticeLines.renamed(renameFacts))],
    ['envelope: squash', buildBranchEnvelope(squashFacts, 'the conclusion')],
    ['envelope: rebased-into', buildBranchEnvelope(rebasedIntoFacts, 'transcript page')],
    ['envelope: message', buildBranchEnvelope(messageFacts, 'please handle the checkpoint')],
    [
      'merge checkpoint: no command id',
      buildMergeCheckpoint(checkpoint, { compactionId: CompactionId('c-1') }, { child: 'review', target: 'main' }),
    ],
    [
      'merge checkpoint: with command id',
      buildMergeCheckpoint(
        checkpoint,
        { compactionId: CompactionId('c-2'), turnRange: { start: 2, end: 5 }, sourceCommandId: 'cmd-7' as CommandId },
        { child: 'review', target: 'main' },
      ),
    ],
    ['handoff report: success', handoffReport('main', success)],
    ['handoff report: failure', handoffReport('main', failure)],
  ]
}

describe('current message-source admission (format watch)', () => {
  test('every message this plugin writes is accepted by the V4 encoder', () => {
    for (const [, message] of everyPluginMessage()) {
      assertAcceptedByV4(message)
    }
  })

  test('the official compact checkpoint constructor stays accepted', () => {
    assertAcceptedByV4(createUserMessage({
      content: [{ type: 'text', text: 'checkpoint' }],
      source: compactCheckpointSource(CompactionId('official-1')),
    }))
  })

  test('the writer inventory stays complete (every createUserMessage site is asserted)', () => {
    // The inventory in everyPluginMessage is only as good as its coverage,
    // so discover it: every module under src/ that calls createUserMessage
    // must be a known writer whose output this file asserts (directly or
    // via a builder) — a new writer fails here until it is added above.
    const srcRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src')
    const discovered: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.name.endsWith('.ts') && readFileSync(path, 'utf8').includes('createUserMessage(')) {
          discovered.push(relative(srcRoot, path).split(sep).join('/'))
        }
      }
    }
    walk(srcRoot)
    expect(discovered.sort()).toEqual([
      'branch-events.ts',
      'squash-midturn.ts',
      'squash.ts',
      'vendor/compact.ts',
    ])
  })
})
