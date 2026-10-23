/**
 * Client-side graph model: map the host's `graph` RPC payload onto the
 * vendored vscode SCM history shapes.
 * @module dsh-session-fork/src/client/graph-model
 *
 * Pure and DOM-free, so the mapping is unit-testable without React; the
 * view component only adds layout (toISCMHistoryItemViewModelArray) and
 * rendering on top.
 */

import type {
  ISCMHistoryItem,
  ISCMHistoryItemRef,
  ISCMHistoryItemViewModel,
} from './vendor/vscode/types.js'

/**
 * Structural slice of dsh's client-side `RpcResult<T>` as the view consumes
 * it (success value or a displayable error message; never thrown here).
 */
export type GraphRpcResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** Wire shape of one graph node served by the host's `graph` endpoint. */
export interface GraphNodeDto {
  readonly id: string
  readonly parentIds: readonly string[]
  readonly subject: string
  readonly refs?: readonly { readonly id: string; readonly name: string }[] | undefined
  /** Owning session (mirror of the host's `GraphNode.sessionId`). */
  readonly sessionId?: string | undefined
  /** Turn handle of the row (mirror of the host's `GraphNode.turn`). */
  readonly turn?: number | undefined
  /**
   * Closing `turn/end` seq in the owning session's log — the `atSeq` the
   * right-click "fork from here" action sends (host's `GraphNode.endSeq`).
   */
  readonly endSeq?: number | undefined
}

/** Wire shape of the `graph` endpoint value. */
export interface GraphPayloadDto {
  readonly nodes: readonly GraphNodeDto[]
  readonly head: string | null
}

/** Wire shape of one event row served by the `turnEvents` endpoint. */
export interface TurnEventRowDto {
  readonly seq: number
  readonly type: string
  readonly text: string
}

/** Wire shape of the `turnEvents` endpoint value (row expansion). */
export interface TurnEventsPayloadDto {
  readonly events: readonly TurnEventRowDto[]
}

/** Wire shape of one `registry` endpoint branch row, as the view reads it. */
export interface RegistryBranchDto {
  readonly name: string
  readonly sessionId: string
  readonly dangling: boolean
  /** Fork lineage (host `BranchSnapshot.forkOrigin`); null on root branches. */
  readonly forkOrigin?: { readonly parentSessionId: string; readonly atSeq: number } | null
}

/** Result of the mapping: vscode history items plus the HEAD ref. */
export interface GraphHistoryModel {
  readonly items: readonly ISCMHistoryItem[]
  readonly headRef: ISCMHistoryItemRef | undefined
}

/** Ref id of the synthesized HEAD marker row reference. */
const HEAD_REF_ID = 'HEAD'

/**
 * Map one graph payload onto the vscode history model. The host already
 * orders nodes newest-first; the mapping is shape-only (id, parentIds,
 * subject, branch-name references, HEAD marker via `currentHistoryItemRef`).
 */
export function toGraphHistoryModel(payload: GraphPayloadDto): GraphHistoryModel {
  const items: ISCMHistoryItem[] = payload.nodes.map(node => ({
    id: node.id,
    parentIds: [...node.parentIds],
    subject: node.subject,
    message: node.subject,
    ...(node.refs === undefined || node.refs.length === 0
      ? {}
      : { references: node.refs.map(ref => ({ id: ref.id, name: ref.name, revision: node.id })) }),
  }))
  return {
    items,
    headRef: payload.head === null
      ? undefined
      : { id: HEAD_REF_ID, name: HEAD_REF_ID, revision: payload.head },
  }
}

/**
 * The palette identifier of one row's circle lane, mirroring the vendored
 * renderer's own pick (renderSCMHistoryItemGraph): the output swimlane's
 * color at the circle index when present, otherwise the input swimlane's.
 * `undefined` when neither lane exists (the renderer then falls back to its
 * ref color); consumers pass the result through the shims' asCssVariable to
 * get the CSS variable reference.
 */
export function rowLaneColor(viewModel: ISCMHistoryItemViewModel): string | undefined {
  const { historyItem, inputSwimlanes, outputSwimlanes } = viewModel
  const inputIndex = inputSwimlanes.findIndex(node => node.id === historyItem.id)
  const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length
  if (circleIndex < outputSwimlanes.length) return outputSwimlanes[circleIndex]?.color
  if (circleIndex < inputSwimlanes.length) return inputSwimlanes[circleIndex]?.color
  return undefined
}
