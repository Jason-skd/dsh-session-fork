/**
 * Host-side branch-graph assembly: registry records + session logs in, a
 * vscode-SCM-history-shaped node list out.
 * @module dsh-session-fork/src/graph
 *
 * The 'graph' RPC endpoint (src/rpc.ts) feeds one workspace's branch
 * registry and the sessions it references through {@link assembleBranchGraph};
 * the browser tab (P1's vendored renderer) maps the nodes onto
 * `ISCMHistoryItem` rows. Everything here is pure over injected reads, so
 * tests run without cordis.
 *
 * Event vocabulary relied on (node_modules/@deepseek-ai/dsh-session
 * lib/types/types.d.ts @ 0.1.0-rc.7, `SessionEventMap`):
 * - `turn/start` `{ turn: number }` opens a turn; `turn/end` `{ turn, reason }`
 *   closes it. `data.turn` is the durable turn handle used in node ids.
 * - `user/message` carries a `UserMessage` (`{ role, content, source }`);
 *   `content` blocks of `type: 'text'` carry the prompt text, and
 *   `source.kind === 'user'` marks a direct human prompt. Synthetic
 *   injections (`plugin`, `goal`, `subagent-settled`, …) NEVER form rows:
 *   per the project's graph rule (user decision, 2026-08-21), only turns
 *   containing a real human message become commits — harness-injected
 *   turns (goal rounds, reminders, team messages) render nothing, per the
 *   dsh-llm `MessageSourceMap`.
 * - Fork lineage: a seeded child's log starts with the parent's prefix, so
 *   `header.inheritedEventCount` splits inherited events from the child's
 *   own work, and `header.parentSession` names the seed source
 *   (SessionHeader).
 */

import { parseTransferPreamble } from './branch-events.js'

/** Structural slice of one session event the graph consumes. */
export interface GraphEvent {
  readonly seq: number
  readonly type: string
  readonly time?: number
  readonly data?: unknown
}

/** Header facts a forked child carries; absent on root sessions. */
export interface GraphSessionHeader {
  /** Leading events inherited from {@link parentSession} through a seed. */
  readonly inheritedEventCount?: number
  /** Session the seed was taken from. */
  readonly parentSession?: string
}

/** One session's log as the graph needs it. */
export interface GraphSessionLog {
  readonly header: GraphSessionHeader
  readonly events: readonly GraphEvent[]
}

/** One extracted turn of one session. */
export interface TurnSlice {
  /** `data.turn` of the `turn/start`/`turn/end` pair. */
  readonly turn: number
  /** Seq of the `turn/start` event (log coordinates). */
  readonly startSeq: number
  /** Seq of the `turn/end` event; null while the turn is still open. */
  readonly endSeq: number | null
  /** `time` of the `turn/start` event, when recorded. */
  readonly startTime?: number
  /**
   * First human prompt text in the turn; '' when the turn has none. On a
   * transfer row (`transferOf` set) this is the envelope preamble head.
   */
  readonly subject: string
  /**
   * Transfer marker: set on standalone rows emitted for a `/squash` or
   * `/rebased into` transfer envelope — a `user/message` with a plugin
   * source (plugin `dsh-session-fork` or `compact`) whose preamble parses
   * as a transfer of kind `squash`/`rebased-into`
   * (src/branch-events.ts `parseTransferPreamble`). The transfer is
   * semantically between-turns, but the `agent.inject()` transport can
   * deliver it inside an open turn bracket, so rows are emitted wherever
   * it lands; `turn` carries the envelope event's seq (there is no kernel
   * turn handle), so node ids use an `s`-prefixed form to stay
   * collision-free.
   */
  readonly transferOf?: TransferFacts
}

/**
 * The transfer facts a transfer row stands for: which kind of branch
 * transfer produced the envelope, and the source branch's NAME at event
 * time (`branchEvent.from` successor — the preamble's quoted name, cf.
 * `parseTransferPreamble` in src/branch-events.ts). The session id for the
 * merge edge is resolved from the registry at assembly time; a name no
 * registered branch carries (e.g. after a rename) degrades by omission.
 */
export interface TransferFacts {
  readonly kind: 'squash' | 'rebased-into' | 'message'
  readonly fromName: string
}

/** First line of a text, trimmed — the squash row shows the summary head. */
function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.trim()
}

/**
 * The transfer facts when `data` is a branch-event transfer envelope user
 * message (a `/squash` merge checkpoint, a `/rebased into` transcript, or a
 * `send_message_by_branch` message), else null. Detection is two-keyed: a
 * plugin source this plugin or the official compaction owns (`kind: 'plugin'`
 * with plugin `dsh-session-fork` or `compact`), and the machine-contract
 * preamble parsed by src/branch-events.ts `parseTransferPreamble` — the
 * frozen session-format plugin-source vocabulary admits no structured
 * provenance members, so the self-describing preamble text IS the durable
 * machine record. Every delivered transfer carries it; plain notices do not
 * match. That is what separates transfer envelopes from dsh's own `/compact`
 * checkpoints and every other plugin message, which stay filtered.
 */
function transferFactsOf(data: unknown): TransferFacts | null {
  if (data === null || typeof data !== 'object') return null
  const source = (data as { source?: { kind?: unknown; plugin?: unknown } }).source
  if (source === null || typeof source !== 'object' || source.kind !== 'plugin') return null
  if (source.plugin !== 'dsh-session-fork' && source.plugin !== 'compact') return null
  return parseTransferPreamble(userMessageText(data))
}

/** Text of one user message: its text blocks joined and trimmed. */
function userMessageText(data: unknown): string {
  if (data === null || typeof data !== 'object') return ''
  const content = (data as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  const text = content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join(' ')
    .trim()
  return text
}

/** Whether a user message came from a direct human prompt. */
function isHumanPrompt(data: unknown): boolean {
  if (data === null || typeof data !== 'object') return false
  return (data as { source?: { kind?: unknown } }).source?.kind === 'user'
}

interface OpenTurn {
  readonly turn: number
  readonly startSeq: number
  readonly startTime?: number
  endSeq: number | null
  /** First human-prompt subject found in the turn, '' when none yet. */
  subject: string
}

/**
 * Extract the turns of one session log in log order.
 *
 * Only events at `seq >= fromSeq` are considered; production passes the
 * session's `header.seedLength` so a forked child contributes exactly its
 * own turns (the inherited parent prefix appears through the parent's own
 * branch). A turn without a human prompt emits NO row at all — synthetic
 * injections (goal rounds, plugin reminders, team messages) are not
 * commits; each session's row chain links across the skipped turns
 * naturally (every row parents the previous emitted row). The sanctioned
 * exception is the branch-event transfer envelope (see
 * {@link TurnSlice.transferOf}): it emits its own row so the target branch
 * shows the transfer as an ordinary commit (user decision, 2026-08-21)
 * — wherever the event physically lands (the `agent.inject()` transport
 * delivers into an open turn).
 */
export function extractTurns(events: readonly GraphEvent[], fromSeq = 0): TurnSlice[] {
  const turns: TurnSlice[] = []
  let open: OpenTurn | null = null
  for (const event of events) {
    if (event.seq < fromSeq) continue
    const data = event.data
    switch (event.type) {
      case 'turn/start': {
        // Kernel turns are numeric; `turn: null` markers (e.g. idle
        // compaction brackets) are not rows.
        if (data !== null && typeof data === 'object'
          && typeof (data as { turn?: unknown }).turn === 'number') {
          open = {
            turn: (data as { turn: number }).turn,
            startSeq: event.seq,
            ...(event.time === undefined ? {} : { startTime: event.time }),
            endSeq: null,
            subject: '',
          }
        }
        break
      }
      case 'turn/end': {
        if (open !== null && data !== null && typeof data === 'object'
          && (data as { turn?: unknown }).turn === open.turn) {
          if (open.subject !== '') {
            turns.push({
              turn: open.turn,
              startSeq: open.startSeq,
              endSeq: event.seq,
              ...(open.startTime === undefined ? {} : { startTime: open.startTime }),
              subject: open.subject,
            })
          }
          open = null
        }
        break
      }
      case 'user/message': {
        // A transfer envelope (/squash checkpoint, /rebased into
        // transcript) is a row of its own — the one sanctioned plugin
        // message. It is semantically between-turns, but the agreed
        // transport (`agent.inject()`, PR#32: next-step, no wake) delivers
        // it into whatever turn is open at delivery time (empirically
        // confirmed: go-ce-v3 2026-08-25, checkpoints at seq 6534/6535
        // inside turn 3's bracket), so the row is emitted wherever the
        // event physically lands.
        const transfer = transferFactsOf(data)
        if (transfer !== null) {
          const subject = firstLine(userMessageText(data))
          if (subject !== '') {
            turns.push({
              turn: event.seq,
              startSeq: event.seq,
              endSeq: event.seq,
              ...(event.time === undefined ? {} : { startTime: event.time }),
              subject,
              transferOf: transfer,
            })
          }
          break
        }
        if (open !== null && open.subject === '' && isHumanPrompt(data)) {
          const text = userMessageText(data)
          if (text !== '') open.subject = text
        }
        break
      }
      default:
        break
    }
  }
  return turns
}

/** A branch-name ref displayed on a graph row (vscode `references`). */
export interface GraphNodeRef {
  readonly id: string
  readonly name: string
}

/** One graph row: a session's turn with its lineage. */
export interface GraphNode {
  /** `${sessionId}:${turn}` — globally unique across the workspace. */
  readonly id: string
  readonly parentIds: string[]
  /** The turn's user message (commit-message analogue). */
  readonly subject: string
  /** Branch names whose head lands on this node. */
  readonly refs?: readonly GraphNodeRef[]
  /** Owning session of the turn (row→data-plane address, issue #8). */
  readonly sessionId?: string
  /** `data.turn` of the turn the row stands for. */
  readonly turn?: number
  /**
   * Seq of the turn's closing `turn/end` event in the owning session's log
   * coordinates — exactly the `atSeq` semantic of the fork endpoint
   * (right-click "fork from here" seeds the child at this boundary).
   */
  readonly endSeq?: number
}

/** One lightweight event row served by the `turnEvents` endpoint. */
export interface TurnEventSummary {
  readonly seq: number
  readonly type: string
  readonly text: string
}

/** One-line soft cap for `turnEvents` summaries; longer text is cut and marked. */
const EVENT_TEXT_LIMIT = 120

/** Cut to the line cap, marking the omission so truncation is visible. */
function truncateLine(text: string): string {
  return text.length <= EVENT_TEXT_LIMIT ? text : `${text.slice(0, EVENT_TEXT_LIMIT)}…(truncated)`
}

/** Join the text blocks of one message-shaped `data.content` array. */
function contentText(data: unknown, key: 'content' | 'message'): string {
  if (data === null || typeof data !== 'object') return ''
  const holder = key === 'content' ? data : (data as { message?: unknown }).message
  const content = (holder as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join(' ')
    .trim()
}

/**
 * One event's one-line summary text for row expansion (issue #8):
 * user/assistant messages show their joined text blocks; a tool call shows
 * the tool name plus brief raw arguments; every other type renders as the
 * bare type name. Anything longer than the line cap is cut and marked.
 */
export function summarizeEventText(event: GraphEvent): string {
  const data = event.data
  switch (event.type) {
    case 'user/message': {
      const text = contentText(data, 'content')
      return truncateLine(text === '' ? 'user/message' : text)
    }
    case 'assistant/message': {
      const text = contentText(data, 'message')
      return truncateLine(text === '' ? 'assistant/message' : text)
    }
    case 'tool/call': {
      if (data === null || typeof data !== 'object') return 'tool/call'
      const { name, arguments: args } = data as { name?: unknown; arguments?: unknown }
      if (typeof name !== 'string') return 'tool/call'
      const brief = typeof args === 'string' ? args : ''
      return truncateLine(`tool ${name}: ${brief}`)
    }
    default:
      return event.type
  }
}

/**
 * The lightweight event list of one closed turn span (inclusive
 * `startSeq..endSeq`, every event kind — tool calls included), for the
 * `turnEvents` endpoint's row-expansion UI. Pure over the log slice.
 */
export function summarizeTurnEvents(
  events: readonly GraphEvent[],
  startSeq: number,
  endSeq: number,
): TurnEventSummary[] {
  return events
    .filter(event => event.seq >= startSeq && event.seq <= endSeq)
    .map(event => ({ seq: event.seq, type: event.type, text: summarizeEventText(event) }))
}

/** The registry-facing slice of one branch record. */
export interface BranchLike {
  readonly name: string
  readonly sessionId: string
  readonly forkOrigin: { readonly parentSessionId: string; readonly atSeq: number } | null
}

/** The assembled graph served by the 'graph' endpoint. */
export interface BranchGraph {
  /** Rows newest-first (the order the vscode layout consumes). */
  readonly nodes: readonly GraphNode[]
  /** Node id of the payload session's latest own turn; null when it has none. */
  readonly head: string | null
}

const nodeId = (sessionId: string, turn: number): string => `${sessionId}:${turn}`

/**
 * Node id of one slice: ordinary turns are `${sessionId}:${turn}`;
 * transfer rows carry the envelope event's seq (no kernel turn handle), so
 * they take an `s`-prefixed seq form to stay collision-free with turn
 * numbers.
 */
const sliceId = (sessionId: string, slice: TurnSlice): string =>
  slice.transferOf === undefined ? nodeId(sessionId, slice.turn) : `${sessionId}:s${slice.turn}`

/**
 * The turn of `log` whose span contains `seq` (a turn/end seq anchors it).
 * Squash rows never anchor a fork — `atSeq` is the closing `turn/end` of a
 * human turn, so squash slices are skipped to keep the resolved id valid.
 */
function turnContaining(turns: readonly TurnSlice[], seq: number): TurnSlice | null {
  let found: TurnSlice | null = null
  for (const turn of turns) {
    if (turn.startSeq > seq) break
    if (turn.transferOf !== undefined) continue
    found = turn
  }
  return found
}

/**
 * Resolve the fork anchor node id for a child whose record cites
 * `forkOrigin = { parentSessionId, atSeq }`.
 *
 * `atSeq` is a seq in the parent's log coordinates, and a seeded child's
 * log repeats the parent's prefix with identical seqs — so the coordinates
 * stay valid while walking. When the anchor turn falls inside the parent's
 * OWN region, the parent session owns the node. When it falls inside the
 * parent's own inherited seed, ownership walks up `header.parentSession`
 * (seq unchanged) until a session owns the turn or lineage runs out.
 */
async function resolveForkAnchor(
  forkOrigin: { readonly parentSessionId: string; readonly atSeq: number },
  readSession: (sessionId: string) => Promise<GraphSessionLog | null>,
  knownSessions: ReadonlySet<string>,
  depth: number,
): Promise<string | null> {
  let sessionId: string | undefined = forkOrigin.parentSessionId
  const seq = forkOrigin.atSeq
  // One step per ancestor session; the cap only guards pathological logs.
  for (let step = 0; step < depth && sessionId !== undefined; step++) {
    const log = await readSession(sessionId)
    if (log === null) return null
    const turns = extractTurns(log.events)
    const anchor = turnContaining(turns, seq)
    if (anchor === null) return null
    if (anchor.startSeq >= (log.header.inheritedEventCount ?? 0)) {
      // The anchor turn is this session's own work: it owns the node — but
      // it only appears in the graph when this session is a branch target.
      return knownSessions.has(sessionId) ? nodeId(sessionId, anchor.turn) : null
    }
    sessionId = log.header.parentSession
  }
  return null
}

/**
 * Assemble the workspace branch graph.
 *
 * - Node set: the own turns of every registry branch target session
 *   (create and adopt records are equal citizens).
 * - Lineage: turns chain naturally inside a session; a forked child's
 *   first own turn additionally parents to the fork anchor turn (the
 *   right-jump lane in the vscode renderer). A squash row additionally
 *   parents to the merged child branch's head (the merge-join lane);
 *   unregistered children degrade by omission. Unreadable sessions and
 *   anchors that resolve outside the branch set degrade by omission.
 * - Rows carry the branch names whose head lands on them; `head` marks the
 *   payload session's latest own turn (the HEAD double ring).
 */
export async function assembleBranchGraph(
  branches: readonly BranchLike[],
  headSessionId: string,
  readSession: (sessionId: string) => Promise<GraphSessionLog | null>,
): Promise<BranchGraph> {
  const sessionIds = [...new Set(branches.map(branch => branch.sessionId))]
  const knownSessions = new Set(sessionIds)

  // Session logs and own turns (unreadable sessions skip gracefully).
  const logs = new Map<string, GraphSessionLog | null>()
  const ownTurns = new Map<string, TurnSlice[]>()
  for (const sessionId of sessionIds) {
    const log = await readSession(sessionId)
    logs.set(sessionId, log)
    ownTurns.set(sessionId, log === null ? [] : extractTurns(log.events, log.header.inheritedEventCount ?? 0))
  }

  // Fork anchor per session, taken from the first record citing one.
  const forkOriginOf = new Map<string, { parentSessionId: string; atSeq: number }>()
  for (const branch of branches) {
    if (branch.forkOrigin !== null && !forkOriginOf.has(branch.sessionId)) {
      forkOriginOf.set(branch.sessionId, branch.forkOrigin)
    }
  }

  // Branch name → session id, for resolving a squash transfer's source
  // branch (the preamble carries the point-in-time NAME; the registry
  // translates it into the session that owns the merge lane today).
  const sessionIdByName = new Map<string, string>(branches.map(branch => [branch.name, branch.sessionId]))

  const mutableNodes: Array<GraphNode & { parentIds: string[]; refs: GraphNodeRef[] }> = []
  const sortKeys = new Map<string, { time: number; sessionIndex: number; seq: number }>()
  for (const [sessionIndex, sessionId] of sessionIds.entries()) {
    const turns = ownTurns.get(sessionId) ?? []
    const forkOrigin = forkOriginOf.get(sessionId) ?? null
    const anchorId = forkOrigin === null ? null
      : await resolveForkAnchor(forkOrigin, readSession, knownSessions, sessionIds.length + 1)
    turns.forEach((turn, index) => {
      const previous = index > 0 ? turns[index - 1] : undefined
      const parentIds: string[] = []
      if (previous !== undefined) parentIds.push(sliceId(sessionId, previous))
      if (index === 0 && anchorId !== null) parentIds.push(anchorId)
      // A squash row is merge-shaped: the merged child's head is its second
      // parent, so the renderer draws the joining lane (vscode merge curve).
      // A rebased-into row is deliberately NOT merge-shaped (user decision,
      // 2026-08-26): rebased-into injects information into the target —
      // "a rebase commit on the target branch" — it does not attach the
      // source branch, so no second parent. Only a branch name the registry
      // still carries resolves — an unregistered child (or one renamed away
      // since the transfer) degrades by omission, matching how unreadable
      // sessions and outside anchors degrade (user decision).
      if (turn.transferOf?.kind === 'squash') {
        const childSessionId = sessionIdByName.get(turn.transferOf.fromName)
        const childHead = childSessionId === undefined ? undefined : ownTurns.get(childSessionId)?.at(-1)
        if (childSessionId !== undefined && childHead !== undefined) {
          parentIds.push(sliceId(childSessionId, childHead))
        }
      }
      const id = sliceId(sessionId, turn)
      mutableNodes.push({
        id,
        parentIds,
        subject: turn.subject,
        refs: [],
        sessionId,
        turn: turn.turn,
        // extractTurns only emits closed turns, so endSeq is always set.
        endSeq: turn.endSeq ?? undefined,
      })
      sortKeys.set(id, { time: turn.startTime ?? 0, sessionIndex, seq: turn.startSeq })
    })
  }

  // Branch-name refs land on each session's latest own row (branch head).
  for (const branch of branches) {
    const turns = ownTurns.get(branch.sessionId) ?? []
    const last = turns.at(-1)
    if (last === undefined) continue
    const node = mutableNodes.find(candidate => candidate.id === sliceId(branch.sessionId, last))
    node?.refs.push({ id: branch.name, name: branch.name })
  }

  // Newest-first row order: the vscode layout consumes git-log order. Turn
  // start time is the primary key; session then seq break ties so the order
  // stays deterministic without timestamps.
  const ordered = [...mutableNodes]
    .sort((left, right) => {
      const leftKey = sortKeys.get(left.id)!
      const rightKey = sortKeys.get(right.id)!
      if (leftKey.time !== rightKey.time) return rightKey.time - leftKey.time
      if (leftKey.sessionIndex !== rightKey.sessionIndex) return rightKey.sessionIndex - leftKey.sessionIndex
      return rightKey.seq - leftKey.seq
    })
    .map(node => ({
      id: node.id,
      parentIds: node.parentIds,
      subject: node.subject,
      sessionId: node.sessionId,
      turn: node.turn,
      endSeq: node.endSeq,
      ...(node.refs.length === 0 ? {} : { refs: node.refs }),
    }))

  const headTurns = ownTurns.get(headSessionId) ?? []
  const headLast = headTurns.at(-1)
  return {
    nodes: ordered,
    head: headLast === undefined ? null : sliceId(headSessionId, headLast),
  }
}
