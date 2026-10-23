/**
 * Fork interception: replace the shared client sessions service's `fork`
 * method so the official fork affordances route through this plugin's
 * branch pipeline (issue #3).
 * @module dsh-session-fork/src/client/fork-intercept
 *
 * Why this seam holds (deepseek-harness@528c682e): both official entries —
 * the sidebar row menu (ui-workspace/src/client/index.ts:88-94) and the
 * turn-tail branch button (ui-conversation/src/client/apply.ts:419-425) —
 * call `ctx.sessions.fork(opts)` with a runtime property lookup at click
 * time, on the one shared service instance this plugin can reach through
 * the same root context. Replacing the property before the first click
 * intercepts every official fork call without touching official code.
 *
 * The replacement keeps the official signature (callers stay unmodified
 * and unaware) but changes the flow: open the name dialog, pre-check the
 * name client-side (instant feedback, the shared gate core), then run the
 * whole named-fork pipeline host-side through the plugin's `/dsh-session-fork`
 * channel (`fork` endpoint) — where the authoritative registry gate runs
 * BEFORE any fork side effect — and finally open the created child, which
 * is the official button's own post-fork behavior. `increaseTitle` is
 * accepted and dropped: automatic "X (1)" naming is exactly what the
 * mandatory-name dialog replaces.
 *
 * The wrapper is tagged with a well-known registry Symbol so an HMR
 * invalidate cycle (fresh module record, installer re-run) recognizes our
 * own wrapper instead of nesting a new layer per reload.
 */

/** Options of the official client `ctx.sessions.fork` (structural slice). */
export interface ForkOptions {
  sessionId: string
  atSeq?: number
  increaseTitle?: boolean
  /** Official creation observer used for navigation analytics. */
  onCreated?: (sessionId: string) => void
  /** Accepted by the official path; the named-fork pipeline owns migration. */
  allowMigration?: boolean
}

/** Structural slice of the shared client sessions service we patch. */
export interface SessionsServiceLike {
  fork(opts: ForkOptions): Promise<string>
  /** Local addressability probe used to await the host-broadcast child. */
  binding(sessionId: string): unknown
}

/** Payload the host `fork` endpoint accepts (mirror of the zod schema). */
export interface ForkEndpointPayload {
  readonly sessionId: string
  readonly name: string
  readonly atSeq?: number
}

/** Structural mirror of the RPC result the generic channel transport returns. */
export type ForkEndpointResult =
  | { readonly ok: true; readonly value: { readonly sessionId: string } }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** Name-check verdict (shared gate core shape, `validateBranchName`). */
export type NameCheck = { ok: true } | { ok: false; reason: string }

/** Capabilities the interception needs; all injected for testability. */
export interface ForkInterceptDeps {
  readonly sessions: SessionsServiceLike
  /** Open the name dialog; resolves the accepted child id, or undefined on cancel. */
  readonly requestName: ForkInterceptDialogRequest
  /** Client-side pre-gate (shared `validateBranchName` core). */
  readonly validateName: (name: string) => NameCheck
  /** Localize the invalid-name message shown in the dialog's error row. */
  readonly formatInvalidName: (reason: string) => string
  /** One host `fork` round trip. */
  readonly callFork: (payload: ForkEndpointPayload) => Promise<ForkEndpointResult>
  /** Wait until the created child is locally addressable (broadcast race). */
  readonly waitForSession: (sessionId: string) => Promise<void>
  /** Select the created child in the Workspace navigation owner. */
  readonly openSession: (sessionId: string) => void
}

/** The dialog request face the interception consumes. */
export type ForkInterceptDialogRequest = (
  submit: (name: string) => Promise<
    { readonly ok: true; readonly sessionId: string } | { readonly ok: false; readonly message: string }
  >,
) => Promise<{ readonly sessionId: string } | undefined>

/** Registry Symbol tagging our installed wrapper (stable across bundles/reloads). */
const FORK_PATCH_TAG = Symbol.for('dsh-session-fork.client.fork-patch')

/**
 * Install the interception. The caller's `inject` declaration must include
 * `'sessions'` so this runs only once the shared service exists (boot time —
 * always before a user can click fork).
 * @param deps - all dsh touchpoints (sessions service, dialog, wire, gate).
 */
export function installForkIntercept(deps: ForkInterceptDeps): void {
  const sessions = deps.sessions
  const original = sessions.fork as typeof sessions.fork & { [FORK_PATCH_TAG]?: boolean }
  // Already ours (an HMR invalidate re-ran the installer on a fresh module
  // record): re-patching would nest wrappers; the existing one keeps holding.
  if (original[FORK_PATCH_TAG] === true) return

  const wrapper = (opts: ForkOptions): Promise<string> =>
    interceptedFork(deps, sessions, opts)
  ;(wrapper as typeof wrapper & { [FORK_PATCH_TAG]: boolean })[FORK_PATCH_TAG] = true
  sessions.fork = wrapper
}

/**
 * The intercepted flow. Cancel rejects (the official callers' `.catch`
 * swallows that silently — the dialog is the feedback surface); every
 * other failure is surfaced inside the dialog by the submit bridge, so
 * this promise settles only on cancel or full success.
 */
async function interceptedFork(
  deps: ForkInterceptDeps,
  sessions: SessionsServiceLike,
  opts: ForkOptions,
): Promise<string> {
  const accepted = await deps.requestName(async (candidate): Promise<
    { readonly ok: true; readonly sessionId: string } | { readonly ok: false; readonly message: string }
  > => {
    // Instant client-side feedback: the shared gate core rejects format
    // problems before any wire traffic. The host re-runs the authoritative
    // gate (registry uniqueness included) before forking.
    const check = deps.validateName(candidate)
    if (!check.ok) return { ok: false, message: deps.formatInvalidName(check.reason) }
    const result = await deps.callFork({
      sessionId: opts.sessionId,
      name: candidate,
      // The official client floors fractional anchors (frozen mid-turn
      // nodes carry fractional flow seqs); the wire takes integers only.
      ...(opts.atSeq === undefined ? {} : { atSeq: Math.floor(opts.atSeq) }),
    })
    if (!result.ok) return { ok: false, message: result.error.message }
    return { ok: true, sessionId: result.value.sessionId }
  })

  if (accepted === undefined) {
    // The user cancelled before any accepted submission: nothing was
    // forked (every submission that created a child resolved as accepted).
    throw new Error('fork cancelled')
  }

  // Official post-fork behavior: open the created child. The child arrives
  // through a host broadcast that may race the RPC response, so wait for
  // local addressability first; a timeout still opens best-effort.
  try {
    await deps.waitForSession(accepted.sessionId)
  } catch {
    // Addressability wait failed (e.g. timer exhaustion) — open anyway.
  }
  opts.onCreated?.(accepted.sessionId)
  deps.openSession(accepted.sessionId)
  return accepted.sessionId
}
