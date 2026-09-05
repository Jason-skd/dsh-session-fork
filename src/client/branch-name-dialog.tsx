/**
 * The branch-name dialog: a full-viewport Modal the fork flows open to
 * collect the mandatory branch name (issue #3), generalized in issue #8
 * from the fork-only dialog into the shared name-collection surface for
 * every branch-naming action (fork, squash-into-branch).
 * @module dsh-session-fork/src/client/branch-name-dialog
 *
 * Split in two halves:
 * - a framework-free controller (the open/busy/error/draft state machine
 *   plus the `requestName` promise bridge) — unit-testable without React.
 *   Issue #8 adds one additive field: the per-request display texts, so
 *   fork and squash render their own title/description/placeholder/
 *   confirm copy through the same state machine (zero semantic change —
 *   a request without texts keeps the fork copy, exactly the issue-#3
 *   behavior the fork interception relies on);
 * - a thin React component rendering the official Modal + Button atoms,
 *   driven by the controller through useSyncExternalStore.
 *
 * The dialog stays open until the user cancels or a submission is fully
 * accepted: a failed submission (client-side gate or host-side rejection)
 * renders its message in the error row (the official rename dialog's
 * `role="alert"` pattern) and lets the user retry with another name.
 */

import { useRef, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './BranchNameDialog.module.css'

/** Result of one submission attempt: accepted (child id) or rejected (message). */
export type BranchSubmitOutcome =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly message: string }

/**
 * Per-request display texts (already localized by the caller). Absent on
 * a request, the dialog renders the fork copy — the issue-#3 behavior.
 */
export interface BranchDialogTexts {
  readonly title: string
  readonly description: string
  readonly placeholder: string
  readonly confirm: string
}

/** Controller-facing dialog snapshot (immutable; replaced on every change). */
export interface BranchDialogState {
  readonly phase: 'closed' | 'open'
  readonly busy: boolean
  readonly error: string | null
  readonly draft: string
  /** Texts of the open request; null keeps the fork copy (issue #3 flow). */
  readonly texts: BranchDialogTexts | null
}

/**
 * Translator for the dialog's fallback copy (the issue-#3 fork keys) and
 * fixed chrome; per-request copy arrives through {@link BranchDialogTexts}.
 */
export type BranchDialogTranslate = (key: BranchDialogFallbackKey) => string

/** Locale keys the dialog component reads when a request supplies no texts. */
export type BranchDialogFallbackKey =
  | 'fork.title'
  | 'fork.description'
  | 'fork.placeholder'
  | 'fork.confirm'
  | 'fork.cancel'
  | 'fork.close'

/** Framework-free state machine + promise bridge behind the dialog. */
export interface BranchNameDialogController {
  /** Subscribe to snapshot changes (useSyncExternalStore contract). */
  subscribe(listener: () => void): () => void
  /** Current immutable snapshot. */
  getSnapshot(): BranchDialogState
  /**
   * Open the dialog and wait for a name. Each confirm runs `submit`; an
   * accepted submission resolves the promise with the child session id,
   * a rejected one shows the message and keeps the dialog open. Cancel
   * (or a second concurrent request) resolves `undefined`.
   */
  requestName(
    submit: (name: string) => Promise<BranchSubmitOutcome>,
    texts?: BranchDialogTexts,
  ): Promise<{ sessionId: string } | undefined>
  /** Draft text changed (component input). */
  changeDraft(draft: string): void
  /** Confirm pressed: run the pending submission (no-op while busy/closed). */
  confirm(): void
  /** Cancel/Escape/mask pressed: settle with `undefined` and close. */
  cancel(): void
}

/** Build one controller. One dialog at a time; a second request settles `undefined`. */
export function createBranchNameDialog(): BranchNameDialogController {
  const listeners = new Set<() => void>()
  let state: BranchDialogState = { phase: 'closed', busy: false, error: null, draft: '', texts: null }
  let pending: {
    readonly submit: (name: string) => Promise<BranchSubmitOutcome>
    readonly settle: (value: { sessionId: string } | undefined) => void
  } | null = null

  const setState = (next: BranchDialogState): void => {
    state = next
    for (const listener of listeners) listener()
  }

  const close = (value: { sessionId: string } | undefined): void => {
    const request = pending
    pending = null
    setState({ phase: 'closed', busy: false, error: null, draft: '', texts: null })
    request?.settle(value)
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => state,
    requestName(submit, texts) {
      if (pending !== undefined && pending !== null) return Promise.resolve(undefined)
      return new Promise(resolve => {
        pending = { submit, settle: resolve }
        setState({
          phase: 'open',
          busy: false,
          error: null,
          draft: '',
          texts: texts === undefined ? null : texts,
        })
      })
    },
    changeDraft(draft) {
      if (state.phase !== 'open' || state.busy) return
      setState({ ...state, draft, error: null })
    },
    confirm() {
      const request = pending
      if (request === null || state.phase !== 'open' || state.busy) return
      setState({ ...state, busy: true, error: null })
      void request.submit(state.draft).then(outcome => {
        // A cancel may have landed while the submission was in flight;
        // the dialog is already closed and settled — drop the outcome.
        if (pending === null || state.phase !== 'open') return
        if (outcome.ok) {
          close({ sessionId: outcome.sessionId })
        } else {
          setState({ ...state, busy: false, error: outcome.message })
        }
      }, error => {
        if (pending === null || state.phase !== 'open') return
        setState({
          ...state,
          busy: false,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    },
    cancel() {
      if (pending === null) return
      close(undefined)
    },
  }
}

/**
 * The dialog component. Registered once into the `shell.overlay` slot by
 * the plugin apply; renders nothing unless a request is open. Copy: the
 * per-request {@link BranchDialogTexts} when the request supplied them,
 * otherwise the fork copy through `t`; chrome is the official Modal/Button.
 * @param props.controller - the shared controller instance.
 * @param props.t - bound locale translator (fixed chrome keys).
 * @returns the Modal tree (null when closed).
 */
export function BranchNameDialog({ controller, t }: {
  controller: BranchNameDialogController
  t: BranchDialogTranslate
}): ReactNode {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const composingRef = useRef(false)
  return (
    <Modal
      open={state.phase === 'open'}
      onClose={controller.cancel}
      title={state.texts?.title ?? t('fork.title')}
      closeLabel={t('fork.close')}
      description={state.texts?.description ?? t('fork.description')}
      footer={(
        <>
          <Button variant="outline" disabled={state.busy} onClick={controller.cancel}>
            {t('fork.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={state.busy || state.draft.length === 0}
            onClick={controller.confirm}
          >
            {state.texts?.confirm ?? t('fork.confirm')}
          </Button>
        </>
      )}
    >
      <input
        className={css.input}
        value={state.draft}
        autoFocus
        disabled={state.busy}
        placeholder={state.texts?.placeholder ?? t('fork.placeholder')}
        aria-label={state.texts?.title ?? t('fork.title')}
        onChange={(e) => { controller.changeDraft(e.target.value) }}
        onCompositionStart={() => {
          composingRef.current = true
        }}
        onCompositionEnd={() => {
          composingRef.current = false
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !composingRef.current) {
            e.preventDefault()
            if (!state.busy && state.draft.length > 0) controller.confirm()
          }
        }}
      />
      {state.error !== null && (
        <div className={css.error} role="alert">{state.error}</div>
      )}
    </Modal>
  )
}
