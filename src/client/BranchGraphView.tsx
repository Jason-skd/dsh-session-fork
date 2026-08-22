/**
 * Branch graph view: one `conversation.view` tab entry rendering the
 * workspace's session branches with the vendored vscode SCM history
 * swimlane renderer — one row per turn, the turn's user message as the row
 * label, forked branches right-jumping to new lanes, and the current
 * session's latest turn as the HEAD double ring.
 *
 * P4 polish on top: theme-following palette (dark-theme override in the CSS
 * module), solid vscode-style ref badges (lane-color fill, branch icon +
 * name, per scmHistoryViewPane._renderBadge), a strong `current` treatment
 * on the HEAD row, full-text hover through the official Tooltip primitive
 * (issue #8), a loading skeleton, and a retry affordance in the error
 * state. Shared chrome (row rhythm, typography, hover) follows the
 * official trajectory tab (user decision, 2026-08-21); branch-specific
 * elements follow the vscode Source Control Graph source.
 * @module dsh-session-fork/src/client/BranchGraphView
 */

import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { IconBranchOutline16, Menu, RiskConfirmation, Toast, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { validateBranchName } from '../branch-name.js'
import type { BranchNameDialogController } from './branch-name-dialog.tsx'
import {
  rowLaneColor,
  toGraphHistoryModel,
  type GraphPayloadDto,
  type GraphRpcResult,
  type RegistryBranchDto,
} from './graph-model.ts'
import { NS } from './locales.ts'
import {
  renderSCMHistoryItemGraph,
  toISCMHistoryItemViewModelArray,
} from './vendor/vscode/scm-history.js'
import { asCssVariable } from './vendor/vscode/shims.js'
import type { ISCMHistoryItemViewModel } from './vendor/vscode/types.js'
import css from './BranchGraphView.module.css'

/** Session-bound capabilities the view reads (see the registration in index.ts). */
export interface BranchGraphInjected {
  /** Load the workspace branch graph anchored at one session. */
  loadGraph(signal?: AbortSignal): Promise<GraphRpcResult<GraphPayloadDto>>
  /**
   * Load the workspace's branch rows (registry liveness + fork lineage):
   * dangling names feed the demoted section, `forkOrigin` decides which
   * rows offer the squash action (issue #8).
   */
  loadBranches(signal?: AbortSignal): Promise<GraphRpcResult<readonly RegistryBranchDto[]>>
  /**
   * Right-click "Fork from here" (issue #8): one host `fork` round trip
   * with the row's `endSeq` as the `atSeq` anchor.
   */
  createBranch(request: {
    readonly name: string
    readonly sessionId: string
    readonly atSeq?: number
  }): Promise<GraphRpcResult<{ readonly sessionId: string }>>
  /**
   * Right-click "Squash into branch" (issue #8): one host `squash` round
   * trip; the host keeps the command's lineage constraint (the target
   * must own this session's parent), so failures carry user-facing text.
   */
  squashBranch(request: {
    readonly sessionId: string
    readonly target: string
  }): Promise<GraphRpcResult<{ readonly message: string }>>
  /**
   * Right-click "Remove branch" (issue #23): one host `removeBranch`
   * round trip — the `/branch rm --yes` semantics (ref only, session
   * data untouched). The payload's `sessionId` resolves the workspace,
   * so it is always the view's own session, never the removed branch's
   * (that one may be dangling and unresolvable).
   */
  removeBranch(request: {
    readonly sessionId: string
    readonly name: string
  }): Promise<GraphRpcResult<{ readonly message: string }>>
  /**
   * Open the shared branch-name dialog (the same controller the fork
   * interception uses); resolves the accepted outcome, undefined on cancel.
   */
  requestBranchName: BranchNameDialogController['requestName']
}

type ViewProps = ConvViewProps & InjectFace<BranchGraphInjected> & PropsLocale<typeof NS>

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly rows: readonly ISCMHistoryItemViewModel[] }

/** Data-plane address of one row (issue #8's GraphNode metadata). */
interface RowMeta {
  readonly sessionId: string
  readonly turn: number
  /** Closing `turn/end` seq — the fork endpoint's atSeq anchor. */
  readonly endSeq: number
}

/**
 * One graph row: the rendered swimlane SVG plus the turn's label and ref
 * pills. Rows carrying issue-#8 metadata open the right-click menu
 * (fork/squash); the click-to-expand event subtree is offline for now
 * (the host `turnEvents` endpoint is kept for its planned return).
 */
function GraphRow({
  viewModel,
  meta,
  onContextMenu,
  t,
}: {
  readonly viewModel: ISCMHistoryItemViewModel
  readonly meta: RowMeta | undefined
  readonly onContextMenu: (event: ReactMouseEvent, meta: RowMeta) => void
  readonly t: ViewProps['t']
}) {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = container.current
    if (host === null) return
    host.replaceChildren(renderSCMHistoryItemGraph(viewModel))
    return () => { host.replaceChildren() }
  }, [viewModel])
  const references = viewModel.historyItem.references ?? []
  // The badge fill: the row's lane color (vscode paints refs with their
  // own swimlane color; the fallback mirrors the renderer's default).
  const badgeColor = asCssVariable(rowLaneColor(viewModel) ?? 'scmGraph.historyItemRefColor')
  return (
    <div
      className={viewModel.kind === 'HEAD' ? `${css.historyItem} ${css.current}` : css.historyItem}
      onContextMenu={(event) => {
        if (meta === undefined) return
        event.preventDefault()
        onContextMenu(event, meta)
      }}
      role={meta === undefined ? undefined : 'button'}
      aria-haspopup={meta === undefined ? undefined : 'menu'}
    >
      <div className={css.graphContainer} ref={container} />
      <Tooltip
          label={viewModel.historyItem.subject}
          side="bottom"
          delayMs={300}
          maxWidth={480}
        >
          <span className={css.label}>{viewModel.historyItem.subject}</span>
        </Tooltip>
        {references.length > 0 && (
          <div className={css.labelContainer}>
            {references.map(ref => (
              <span
                key={ref.id}
                className={css.ref}
                style={{ backgroundColor: badgeColor }}
                title={ref.name}
              >
                <span className={css.refIcon}><IconBranchOutline16 size={12} /></span>
                <span className={css.refName}>{ref.name}</span>
              </span>
            ))}
          </div>
        )}
      </div>
  )
}

/** Where the row context menu opened (viewport coordinates, issue #8). */
interface RowMenu {
  readonly x: number
  readonly y: number
  /** The row's data plane; null when opened on a dangling ref (remove only). */
  readonly meta: RowMeta | null
  /** Squash lineage facts of the row's session, when it has a fork origin. */
  readonly squashTarget: { readonly parentSessionId: string; readonly parentName: string } | null
  /** The branch name the remove action would delete (null: no registered ref). */
  readonly removeName: string | null
}

/** The branches graph tab body: loads over RPC, then renders the lanes. */
export function BranchGraphView({
  sessionId,
  loadGraph,
  loadBranches,
  createBranch,
  squashBranch,
  removeBranch,
  requestBranchName,
  t,
}: ViewProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [metaById, setMetaById] = useState<ReadonlyMap<string, RowMeta>>(new Map())
  const [branches, setBranches] = useState<readonly RegistryBranchDto[]>([])
  const [attempt, setAttempt] = useState(0)
  const [menu, setMenu] = useState<RowMenu | null>(null)
  /** The pending remove confirmation (issue #23): branch name + checkbox gate. */
  const [removeConfirm, setRemoveConfirm] = useState<{ readonly name: string } | null>(null)
  const [removeAcknowledged, setRemoveAcknowledged] = useState(false)
  const [toast, setToast] = useState<{ readonly seq: number; readonly text: string } | null>(null)
  const toastSeq = useRef(0)

  // Dangling names are a view over the branch rows (demoted section).
  const dangling = branches.filter(branch => branch.dangling).map(branch => branch.name)

  const showToast = (text: string): void => {
    toastSeq.current += 1
    setToast({ seq: toastSeq.current, text })
  }

  /**
   * Squash lineage of one session, from the registry rows: the fork
   * origin plus the parent branch's display name (null on root branches —
   * their rows keep the squash item disabled).
   */
  const squashTargetOf = (
    sessionId: string,
  ): { readonly parentSessionId: string; readonly parentName: string } | null => {
    const origin = branches.find(branch => branch.sessionId === sessionId)?.forkOrigin
    if (origin === undefined || origin === null) return null
    const parent = branches.find(branch => branch.sessionId === origin.parentSessionId)
    if (parent === undefined) return null
    return { parentSessionId: origin.parentSessionId, parentName: parent.name }
  }

  /**
   * The registered branch name of one session, when it has one — the
   * remove action's target (issue #23).
   */
  const branchNameOf = (sessionId: string): string | null =>
    branches.find(branch => branch.sessionId === sessionId)?.name ?? null

  /**
   * "Remove branch" (issue #23): the official RiskConfirmation gates the
   * host round trip behind the acknowledgement checkbox (the GUI parity
   * of `/branch rm --yes`). On confirm the dialog closes immediately
   * (the official PermissionRow pattern) and the failure, if any,
   * surfaces through a toast — removal itself can never corrupt state.
   */
  const removeFromMenu = (name: string): void => {
    void removeBranch({ sessionId, name }).then((result) => {
      if (!result.ok) {
        showToast(`${t('remove.failed')}${result.error.message}`)
        return
      }
      setAttempt(current => current + 1)
      showToast(`${t('toast.removed')}${name}`)
    })
  }

  /**
   * "Fork from here": collect a name through the shared dialog (client
   * pre-gate, then the host `fork` endpoint with the row's endSeq as the
   * atSeq anchor), refresh the graph on success, and toast the new branch.
   * Failures surface inside the dialog's error row; cancel is silent.
   */
  const forkFromRow = (meta: RowMeta): void => {
    let acceptedName = ''
    void requestBranchName(async (candidate) => {
      const check = validateBranchName(candidate)
      if (!check.ok) return { ok: false, message: `${t('fork.invalid')}${check.reason}` }
      const result = await createBranch({
        name: candidate,
        sessionId: meta.sessionId,
        atSeq: meta.endSeq,
      })
      if (!result.ok) return { ok: false, message: result.error.message }
      acceptedName = candidate
      return { ok: true, sessionId: result.value.sessionId }
    }, {
      title: t('fork.title'),
      description: t('fork.description'),
      placeholder: t('fork.placeholder'),
      confirm: t('fork.confirm'),
    }).then((accepted) => {
      if (accepted === undefined) return
      setAttempt(current => current + 1)
      showToast(`${t('toast.forked')}${acceptedName}`)
    })
  }

  /**
   * "Squash into branch" (issue #8): collect the target branch name
   * through the shared dialog (placeholder names the parent branch; the
   * input stays free-form for the future any-two-branches squash), then
   * run the host `squash` endpoint. The host keeps the command's lineage
   * constraint and returns readable failures for the dialog's error row;
   * success refreshes the graph and toasts.
   */
  const squashFromRow = (meta: RowMeta, parentName: string): void => {
    let acceptedTarget = ''
    void requestBranchName(async (candidate) => {
      const result = await squashBranch({ sessionId: meta.sessionId, target: candidate })
      if (!result.ok) return { ok: false, message: result.error.message }
      acceptedTarget = candidate
      return { ok: true, sessionId: meta.sessionId }
    }, {
      title: t('squash.title'),
      description: t('squash.description'),
      placeholder: `${t('squash.placeholder')}${parentName}`,
      confirm: t('squash.confirm'),
    }).then((accepted) => {
      if (accepted === undefined) return
      setAttempt(current => current + 1)
      showToast(`${t('toast.squashed')}${acceptedTarget}`)
    })
  }

  useEffect(() => {
    const controller = new AbortController()
    setState({ kind: 'loading' })
    setMetaById(new Map())
    setBranches([])
    loadGraph(controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return
        if (!result.ok) {
          setState({ kind: 'error', message: result.error.message })
          return
        }
        const model = toGraphHistoryModel(result.value)
        // Row→data-plane addresses for expansion (nodes without the new
        // issue-#8 metadata simply stay non-expandable).
        const meta = new Map<string, RowMeta>()
        for (const node of result.value.nodes) {
          if (node.sessionId !== undefined && node.turn !== undefined && node.endSeq !== undefined) {
            meta.set(node.id, { sessionId: node.sessionId, turn: node.turn, endSeq: node.endSeq })
          }
        }
        setMetaById(meta)
        setState({
          kind: 'ready',
          rows: toISCMHistoryItemViewModelArray([...model.items], undefined, model.headRef),
        })
      },
      (error: unknown) => {
        // The RPC carrier throwing is still a view state, never a crash.
        if (controller.signal.aborted) return
        setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      },
    )
    // The registry view is best-effort: a failing registry call must never
    // take the graph down (the graph endpoint already omits dead sessions).
    loadBranches(controller.signal).then(
      (result) => {
        if (controller.signal.aborted || !result.ok) return
        setBranches(result.value)
      },
      () => { /* best-effort */ },
    )
    return () => { controller.abort() }
  }, [sessionId, loadGraph, loadBranches, attempt])

  if (state.kind === 'loading') {
    return (
      <div className={css.graph} aria-busy="true">
        {t('state.loading')}
        <div className={css.skeletonRow} />
        <div className={css.skeletonRow} />
        <div className={css.skeletonRow} />
      </div>
    )
  }
  if (state.kind === 'error') {
    return (
      <div className={css.state}>
        {t('state.error')}
        <span className={css.errorDetail}>{state.message}</span>
        <button type="button" className={css.retry} onClick={() => { setAttempt(attempt + 1) }}>
          {t('state.retry')}
        </button>
      </div>
    )
  }
  if (state.rows.length === 0 && dangling.length === 0) {
    return <div className={css.state}>{t('state.empty')}</div>
  }
  const menuEntries: readonly MenuEntry[] = menu === null ? [] : [
    // Fork/squash are row actions: a menu opened on a dangling ref (no
    // row meta) keeps them visible but disabled.
    { id: 'fork', label: t('menu.fork'), disabled: menu.meta === null },
    // Squash is offered only on rows whose session has a fork origin —
    // root-branch rows keep the item visible but disabled.
    {
      id: 'squash',
      label: t('menu.squash'),
      disabled: menu.squashTarget === null,
    },
    // Remove is offered wherever a registered ref backs the target (the
    // row's session, or the dangling ref itself); disabled otherwise.
    {
      id: 'remove',
      label: t('menu.remove'),
      disabled: menu.removeName === null,
    },
  ]
  return (
    <div className={css.graph}>
      {state.rows.map(row => (
        <GraphRow
          key={row.historyItem.id}
          viewModel={row}
          meta={metaById.get(row.historyItem.id)}
          onContextMenu={(event, meta) => {
            setMenu({
              x: event.clientX,
              y: event.clientY,
              meta,
              squashTarget: squashTargetOf(meta.sessionId),
              removeName: branchNameOf(meta.sessionId),
            })
          }}
          t={t}
        />
      ))}
      {dangling.length > 0 && (
        <div className={css.danglingSection}>
          {t('state.dangling')}
          {dangling.map(name => (
            <span
              key={name}
              className={css.danglingRef}
              role="button"
              aria-haspopup="menu"
              onContextMenu={(event) => {
                event.preventDefault()
                setMenu({ x: event.clientX, y: event.clientY, meta: null, squashTarget: null, removeName: name })
              }}
            >
              {name}
            </span>
          ))}
        </div>
      )}
      {/* The row context menu: portal mode, fixed at the pointer (a
       * zero-size anchor rect at the recorded coordinates). */}
      <Menu
        open={menu !== null}
        anchor={<span className={css.menuAnchor} aria-hidden="true" />}
        items={menuEntries}
        portal
        getAnchorRect={() => (menu === null ? null : new window.DOMRect(menu.x, menu.y, 0, 0))}
        onSelect={(id) => {
          const current = menu
          setMenu(null)
          if (current === null) return
          if (id === 'fork' && current.meta !== null) forkFromRow(current.meta)
          if (id === 'squash' && current.meta !== null && current.squashTarget !== null) {
            squashFromRow(current.meta, current.squashTarget.parentName)
          }
          if (id === 'remove' && current.removeName !== null) {
            setRemoveAcknowledged(false)
            setRemoveConfirm({ name: current.removeName })
          }
        }}
        onClose={() => { setMenu(null) }}
      />
      {/* The remove confirmation (issue #23): the official gated dialog —
       * the primary action stays disabled until the acknowledgement
       * checkbox (the GUI parity of /branch rm --yes) is checked. */}
      <RiskConfirmation
        open={removeConfirm !== null}
        title={t('remove.title')}
        description={t('remove.description')}
        acknowledgeLabel={t('remove.acknowledge')}
        cancelLabel={t('remove.cancel')}
        confirmLabel={t('remove.confirm')}
        acknowledged={removeAcknowledged}
        onAcknowledgedChange={setRemoveAcknowledged}
        onCancel={() => {
          setRemoveAcknowledged(false)
          setRemoveConfirm(null)
        }}
        onConfirm={() => {
          const target = removeConfirm
          setRemoveAcknowledged(false)
          setRemoveConfirm(null)
          if (target !== null) removeFromMenu(target.name)
        }}
      />
      {toast !== null && (
        <Toast key={toast.seq} text={toast.text} onDone={() => { setToast(null) }} />
      )}
    </div>
  )
}
