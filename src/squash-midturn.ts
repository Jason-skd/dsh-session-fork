/**
 * Mid-turn squash handoff: `/squash into <branch>` (and its RPC twin)
 * invoked while the source branch's agent is still running its turn.
 * @module dsh-session-fork/src/squash-midturn
 *
 * Design (agreed 2026-08-26):
 *
 * - **The running turn ends through the official cancellation path** —
 *   `agent.cancel(cause, { keepInbox: true })`. The log keeps only official
 *   shapes: a `turn/end` with an aborted reason, byte-identical in kind to
 *   a user interrupt. `keepInbox` guarantees queued mail survives the handoff
 *   (the preserved items are claimed by the follow-up turn).
 * - **The squash itself runs from a plugin-owned continuation** once the
 *   agent is quiescent (`agent.whenIdle()`), so `executeSquash` enters its
 *   vendored `runMaintenance` window legally and the checkpoint lands in
 *   the official idle-compaction form — identical to a between-turns
 *   `/squash`. The executor runs UNCHANGED.
 * - **The continuation reports back by opening a follow-up turn** on the
 *   source agent ("squash completed/failed: …") — the async-completion
 *   precedent of the official agent-teams tooling.
 * - **Unread-mail guard**: squashing while the inbox holds undelivered
 *   messages would summarize an incomplete picture (pending items are not
 *   on the surface yet). The handoff refuses instead. No artificial
 *   delivery trigger is needed: pending next-step items are claimed
 *   automatically at the running turn's next step boundary, so the refusal
 *   self-heals — read the mail, then squash again. Next-turn items
 *   legitimately wait for a turn boundary; the refusal text says so.
 * - **Precheck before the cancellation** (`precheckSquash`, `balance:
 *   false`): a bad target, self-squash, an unregistered source, or an
 *   empty region must never cost the source its turn. The
 *   boundary-pairing gates are deliberately NOT part of it — they are
 *   time-sensitive (the initiating call itself keeps the surface's final
 *   step open; go-ce-v3: `squash_into` on a running self was refused with
 *   "region end … the step is still open" and this handoff was
 *   unreachable). The executor re-validates on the post-cancellation
 *   idle surface, where the cancelled turn's `turn/end` closes the step.
 *
 * Pure over injected seams, mirroring the repo's cordis-free discipline:
 * the host shell in index.ts/rpc.ts wires `run` to its in-flight
 * bookkeeping so plugin disposal drains the continuation too.
 */

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { AgentCancelCause } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { BranchCommandResult } from './command.js'
import { loadRegistry } from './registry.js'
import { executeSquash, precheckSquash, SQUASH_USAGE } from './squash-command.js'
import type { SquashAction, SquashCommandDeps } from './squash-command.js'

/** The stable cancellation intent stamped on the interrupted turn. */
export const SQUASH_HANDOFF_CAUSE: AgentCancelCause = {
  kind: 'hook',
  reason: 'dsh-session-fork:squash-handoff',
}

/**
 * The agent surface the handoff needs, beyond the executor's
 * {@link SquashCommandDeps} slice. A structural narrowing of the public
 * `Agent` interface — live agents satisfy it directly; tests hand over
 * fakes carrying exactly these members.
 */
export interface SquashHandoffAgent {
  /** Public lifecycle state used by the executor's idle gate. */
  readonly status: 'idle' | 'running'
  /** Inbox state, for the unread-mail guard. */
  readonly inbox: {
    readonly nextStep: readonly unknown[]
    readonly nextTurn: readonly unknown[]
  }
  /** The official cancellation entry (aborts the live activity signal). */
  cancel(cause: AgentCancelCause, options?: { readonly keepInbox?: boolean }): void
  /** Resolve after no active driver or maintenance task remains. */
  whenIdle(): Promise<void>
  /** Queue a follow-up turn and wake the driver. */
  followup(message: UserMessage): void
}

/** The handoff's deps: the exact idle-pipeline deps plus the running source. */
export interface SquashHandoffDeps extends SquashCommandDeps {
  readonly childAgent: SquashCommandDeps['childAgent'] & SquashHandoffAgent
}

/**
 * Detached continuation runner. The host MUST wire this to the same
 * bookkeeping that drains in-flight command operations at dispose, so a
 * plugin unload never abandons a running compaction mid-flight.
 */
export type DetachedRunner = (operation: Promise<void>) => void

/** Text for one thrown value. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The unread-mail refusal. Self-healing by construction: next-step mail is
 * claimed at the running turn's next step boundary (the refusal's own
 * tool-result step), and next-turn mail awaits the next turn — the model
 * reads, then retries the squash with the complete picture.
 */
export function inboxPendingText(target: string, nextStep: number, nextTurn: number): string {
  return `Squash into '${target}' refused: ${nextStep + nextTurn} undelivered inbox message(s) pending`
    + ` (${nextStep} next-step, ${nextTurn} next-turn). Next-step mail arrives automatically at your`
    + ` next step boundary; next-turn mail arrives when this turn ends. Read it first so the summary`
    + ` covers everything, then squash again.`
}

/** The immediate result handed back while the handoff proceeds. */
function initiatedText(target: string): string {
  return `Squash into '${target}' initiated: the running turn is ending, the squash runs at the next`
    + ` idle point, and a follow-up message will report the outcome.`
}

/** The notice-source shape of the follow-up report (mirrors branch-events). */
interface HandoffNoticeSource {
  readonly kind: 'dsh-session-fork'
  readonly form: 'notice'
  readonly summary: string
}

/**
 * The follow-up report the continuation delivers to the source agent after
 * the deferred squash settles. Success carries the executor's own stats;
 * failure carries the executor's error text plus a retry hint. Rides the
 * official plugin notice shape (source.kind 'plugin', bounded summary).
 */
export function handoffReport(target: string, result: BranchCommandResult): UserMessage {
  const body = result.kind === 'success'
    ? `${result.text} This is an automated report of your earlier squash request`
      + ` into '${target}'; continue only if further work is needed.`
    : `Squash into '${target}' failed: ${result.text} Nothing was transferred; retry when ready.`
  return createUserMessage({
    content: [{ type: 'text', text: body }],
    source: {
      kind: 'dsh-session-fork',
      form: 'notice',
      summary: boundContextSummary(
        `squash handoff ${result.kind === 'success' ? 'completed' : 'failed'}: ${target}`,
      ),
    } satisfies HandoffNoticeSource,
  })
}

/**
 * Initiate the mid-turn handoff: end the running turn through the official
 * cancellation path, then run the UNCHANGED squash pipeline from a detached
 * continuation once the agent is idle, and report by follow-up.
 *
 * Lifetime notes: the dispatching UI request's signal dies with this reply,
 * so the deferred run owns a fresh signal (`AbortSignal.none`). The runner
 * seam owns rejection safety and dispose-time draining.
 */
export function initiateSquashHandoff(
  target: string,
  deps: SquashHandoffDeps,
  run: DetachedRunner,
): BranchCommandResult {
  const agent = deps.childAgent
  agent.cancel(SQUASH_HANDOFF_CAUSE, { keepInbox: true })
  const operation = (async (): Promise<void> => {
    let result: BranchCommandResult
    try {
      await agent.whenIdle()
      // Fresh lifetime: a never-aborting signal — the dispatching UI
      // request's own signal dies with the initiated reply, but the
      // deferred squash belongs to the plugin until it settles.
      result = await executeSquash(target, {
        ...deps,
        signal: new AbortController().signal,
      })
    } catch (error) {
      result = { kind: 'error', text: errorText(error) }
    }
    agent.followup(handoffReport(target, result))
  })()
  run(operation)
  return { kind: 'success', text: initiatedText(target) }
}

/**
 * Dispatch one squash target: idle sources take the unchanged executor
 * synchronously; running sources take the mid-turn handoff after the
 * unread-mail guard and the pre-compaction precheck. The handoff's refusal
 * results are errors in the caller's face — the turn is never ended for a
 * squash that cannot proceed.
 */
export async function dispatchSquash(
  target: string,
  deps: SquashHandoffDeps,
  run: DetachedRunner,
): Promise<BranchCommandResult> {
  if (deps.childAgent.status === 'idle') {
    return executeSquash(target, deps)
  }
  if (deps.childAgent.inbox.nextStep.length + deps.childAgent.inbox.nextTurn.length > 0) {
    const { nextStep, nextTurn } = deps.childAgent.inbox
    return { kind: 'error', text: inboxPendingText(target, nextStep.length, nextTurn.length) }
  }
  // Precheck BEFORE the cancellation: everything decidable without
  // compaction (target existence, self-squash, registration, region) must
  // not cost the running turn. The boundary-pairing gates are deliberately
  // absent here (`balance: false`): they are time-sensitive — the
  // initiating call itself keeps the surface's final step open, so a
  // running source can never balance at dispatch time (go-ce-v3: the
  // squash_into tool was refused with "region end … the step is still
  // open" and the handoff below was unreachable). The executor
  // re-validates the region on the post-cancellation idle surface, where
  // the cancelled turn's official turn/end closes the step.
  const state = await loadRegistry(deps.store)
  const precheck = precheckSquash(
    state,
    deps.childAgent.session as Session,
    target,
    { balance: false },
  )
  if (!precheck.ok) {
    return { kind: 'error', text: precheck.text }
  }
  return initiateSquashHandoff(target, deps, run)
}

/** The parsed-action twin of {@link dispatchSquash} (usage guard + dispatch). */
export async function dispatchSquashAction(
  action: SquashAction,
  deps: SquashHandoffDeps,
  run: DetachedRunner,
): Promise<BranchCommandResult> {
  if (action.kind === 'usage') {
    return { kind: 'error', text: `${action.problem}\n${SQUASH_USAGE}` }
  }
  return dispatchSquash(action.target, deps, run)
}
