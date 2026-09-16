/**
 * Tests for the shared branch event envelopes: notice lines, tag symmetry,
 * paging coordinates, the frozen-vocabulary source shapes, and the
 * preamble's machine contract (parseTransferPreamble round-trips). The
 * wording follows the official compaction checkpoint style (English
 * preamble + XML-style tags).
 * @module dsh-session-fork/tests/branch-events.test
 */

import { describe, expect, test } from 'bun:test'
import {
  branchNoticeLines,
  buildBranchEnvelope,
  buildBranchNotice,
  parseTransferPreamble,
} from '../src/branch-events.js'
import type { BranchEventFacts } from '../src/branch-events.js'

function text(message: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  const block = message.content.find(b => b.type === 'text')
  return block?.text ?? ''
}

const forkFacts: BranchEventFacts = {
  kind: 'fork',
  from: 'main',
  to: 'review',
  atTurn: 12,
  fromSessionId: 'sess-abc',
}

const squashFacts: BranchEventFacts = {
  kind: 'squash',
  from: 'review',
  to: 'main',
  atTurn: 12,
  range: { start: 13, end: 20 },
  fromSessionId: 'sess-abc',
}

const adoptFacts: BranchEventFacts = {
  kind: 'adopt',
  from: 'sess-abc',
  to: 'main',
}

const renameFacts: BranchEventFacts = {
  kind: 'rename',
  from: 'main',
  to: 'develop',
}

describe('buildBranchNotice', () => {
  test('renders the child line with a source inside the frozen plugin vocabulary', () => {
    const message = buildBranchNotice(forkFacts, branchNoticeLines.forkChild(forkFacts))
    expect(text(message)).toBe(
      'You are branch "review", forked from branch "main" at turn 12. ' +
      'The conversation above was inherited from "main" — you did not produce it. ' +
      'Treat it as established background and continue the task from here.',
    )
    expect(message.role).toBe('user')
    expect(message.source).toEqual({
      kind: 'plugin',
      plugin: 'dsh-session-fork',
      form: 'notice',
      summary: 'fork: main → review',
    })
  })

  test('bounds the UI summary to the official 120-char notice limit', () => {
    const long: BranchEventFacts = { ...forkFacts, from: `main-${'x'.repeat(300)}` }
    const message = buildBranchNotice(long, branchNoticeLines.forkChild(long))
    const summary = (message.source as { summary: string }).summary
    expect(summary.length).toBeLessThanOrEqual(120)
    expect(summary.endsWith('…')).toBe(true)
  })

  test('renders the fork-parent line for the diverged parent', () => {
    const message = buildBranchNotice(forkFacts, branchNoticeLines.forkParent(forkFacts))
    expect(text(message)).toBe('Branch "review" forked from you at turn 12.')
  })

  test('renders the adopt line stating the session is now a root branch (issue #37)', () => {
    const message = buildBranchNotice(adoptFacts, branchNoticeLines.adopted(adoptFacts))
    expect(text(message)).toBe(
      'This session is now branch "main" — the root branch of this workspace (adopted via /branch adopt). '
      + 'The conversation is your own work. Treat branch-scoped operations (fork from here, squash into you, '
      + 'rebased into you) as applying to this session.',
    )
    expect(message.source).toEqual({
      kind: 'plugin',
      plugin: 'dsh-session-fork',
      form: 'notice',
      summary: 'adopt: sess-abc → main',
    })
  })

  test('renders the rename line stating old and new vocabulary (issue #37)', () => {
    const message = buildBranchNotice(renameFacts, branchNoticeLines.renamed(renameFacts))
    expect(text(message)).toBe(
      'Your branch was renamed: "main" is now "develop". '
      + 'Use "develop" in branch commands (/squash into, /rebased into, /branch rm). '
      + 'Earlier notices may still say "main" — they were true when written.',
    )
    expect(message.source).toEqual({
      kind: 'plugin',
      plugin: 'dsh-session-fork',
      form: 'notice',
      summary: 'rename: main → develop',
    })
  })
})

describe('buildBranchEnvelope', () => {
  test('wraps the payload in a symmetric tag pair with a full-provenance preamble', () => {
    const message = buildBranchEnvelope(squashFacts, 'Done A and B.')
    const t = text(message)
    expect(t.startsWith(
      'This is a squash from branch "review" (forked at turn 12, covering its turns 13–20) into branch "main". ' +
      'The summary below happened on "review" and was transferred by dsh-session-fork; ' +
      "it is not part of this branch's own conversation. Treat it as established background.\n" +
      '<branch-squash>\n',
    )).toBe(true)
    expect(t).toContain('Done A and B.')
    expect(t.endsWith('</branch-squash>')).toBe(true)
    const opens = t.match(/<branch-squash>/g) ?? []
    const closes = t.match(/<\/branch-squash>/g) ?? []
    expect(opens.length).toBe(1)
    expect(closes.length).toBe(1)
  })

  test('omits the fork clause when atTurn is unknown, keeping the range', () => {
    const facts: BranchEventFacts = { kind: 'rebased-into', from: 'review', to: 'main', range: { start: 13, end: 20 } }
    const message = buildBranchEnvelope(facts, 'transcript')
    expect(text(message)).toContain(
      'This is a rebased-into from branch "review" (covering its turns 13–20) into branch "main".',
    )
  })

  test('names the material per kind: summary vs transcript', () => {
    expect(text(buildBranchEnvelope(squashFacts, 'x'))).toContain('The summary below happened on')
    const rebasedInto: BranchEventFacts = { kind: 'rebased-into', from: 'review', to: 'main' }
    expect(text(buildBranchEnvelope(rebasedInto, 'x'))).toContain('The transcript below happened on')
  })

  test('a message envelope marks the payload as peer input, not background (issue #47)', () => {
    const messageFacts: BranchEventFacts = {
      kind: 'message',
      from: 'feat/review',
      to: 'main',
      fromSessionId: 'sess-review',
    }
    const message = buildBranchEnvelope(messageFacts, 'please handle the checkpoint')
    const t = text(message)
    expect(t).toContain('This is a message from branch "feat/review" into branch "main"')
    expect(t).toContain('The message below happened on')
    expect(t).toContain('<branch-message>')
    expect(t.endsWith('</branch-message>')).toBe(true)
    expect(t).toContain('act on it or reply as appropriate')
    expect(t).not.toContain('Treat it as established background')
    expect((message.source as { form: string }).form).toBe('notice')
  })
  test('rebased-into transcripts use the recall context form', () => {
    const rebasedInto: BranchEventFacts = { kind: 'rebased-into', from: 'review', to: 'main' }
    expect((buildBranchEnvelope(rebasedInto, 't').source as { form: string }).form).toBe('recall')
    expect((buildBranchEnvelope(squashFacts, 't').source as { form: string }).form).toBe('notice')
  })
})

describe('source shapes (frozen plugin vocabulary)', () => {
  test('every builder output carries exactly the legal members and nothing else', () => {
    // Regression for the 2026-09-05 incident: unknown source members make a
    // session log refuse to load under the session-format read path, so the
    // builders must never emit one. See format-watch.test.ts for the rule's
    // provenance.
    expect(Object.keys(buildBranchNotice(forkFacts, 'line').source).sort())
      .toEqual(['form', 'kind', 'plugin', 'summary'])
    expect(Object.keys(buildBranchEnvelope(squashFacts, 'payload').source).sort())
      .toEqual(['form', 'kind', 'plugin', 'summary'])
    // The frozen vocabulary admits a summary only on the notice form, so
    // the recall-form rebased-into envelope carries none.
    const rebasedInto: BranchEventFacts = { kind: 'rebased-into', from: 'exp', to: 'main' }
    expect(Object.keys(buildBranchEnvelope(rebasedInto, 'payload').source).sort())
      .toEqual(['form', 'kind', 'plugin'])
  })
})

describe('parseTransferPreamble (machine contract of the preamble)', () => {
  test('round-trips every transfer kind the builders emit', () => {
    expect(parseTransferPreamble(text(buildBranchEnvelope(squashFacts, 'body'))))
      .toEqual({ kind: 'squash', fromName: 'review' })
    const rebasedInto: BranchEventFacts = { kind: 'rebased-into', from: 'exp', to: 'main' }
    expect(parseTransferPreamble(text(buildBranchEnvelope(rebasedInto, 'body'))))
      .toEqual({ kind: 'rebased-into', fromName: 'exp' })
    const messageFacts: BranchEventFacts = { kind: 'message', from: 'feat/review', to: 'main' }
    expect(parseTransferPreamble(text(buildBranchEnvelope(messageFacts, 'please handle'))))
      .toEqual({ kind: 'message', fromName: 'feat/review' })
  })
  test('non-transfer texts yield null', () => {
    // Notice lines are one-liners, not envelopes.
    expect(parseTransferPreamble(branchNoticeLines.forkChild(forkFacts))).toBeNull()
    expect(parseTransferPreamble(branchNoticeLines.forkParent(forkFacts))).toBeNull()
    expect(parseTransferPreamble(branchNoticeLines.adopted(adoptFacts))).toBeNull()
    expect(parseTransferPreamble(branchNoticeLines.renamed(renameFacts))).toBeNull()
    // The parser is text-only: a quoted mimic of the anchored head matches
    // — excluding human prose is the GRAPH's job (transferFactsOf requires
    // a plugin source owned by this plugin or the official compaction).
    expect(parseTransferPreamble('This is a squash from branch "x" into branch "y".'))
      .toEqual({ kind: 'squash', fromName: 'x' })
    expect(parseTransferPreamble('Loose prefix: this is a squash from branch "x" into branch "y".')).toBeNull()
    expect(parseTransferPreamble('This is a squash from branch "x" into "y".')).toBeNull()
    expect(parseTransferPreamble('')).toBeNull()
  })
})
