/**
 * Tests for the browser-half fork interception: the dialog controller's
 * state machine and the full intercepted flow (dialog → client pre-gate →
 * host `fork` endpoint → open), with every dsh touchpoint faked.
 * @module dsh-session-fork/tests/client-patch.test
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import { BranchNameDialog } from '../src/client/branch-name-dialog.tsx'
import { createBranchNameDialog } from '../src/client/branch-name-dialog.tsx'
import { installForkIntercept } from '../src/client/fork-intercept.js'
import type {
  ForkEndpointPayload,
  ForkEndpointResult,
  ForkInterceptDeps,
  SessionsServiceLike,
} from '../src/client/fork-intercept.js'
import { Simulate } from 'react-dom/test-utils'

let window: Window

beforeAll(() => {
  window = new Window()
  const globals = globalThis as unknown as Record<string, unknown>
  globals.window = window
  globals.document = window.document
  globals.navigator = window.navigator
  globals.IS_REACT_ACT_ENVIRONMENT = true
})

afterAll(() => {
  const globals = globalThis as unknown as Record<string, unknown>
  globals.IS_REACT_ACT_ENVIRONMENT = false
  globals.document = undefined
  globals.window = undefined
  window.close()
})
const t = (key: string): string => `#${key}`
interface MountedDialog {
  readonly root: Root
  readonly container: HTMLElement
}

function mountDialog(controller: ReturnType<typeof createBranchNameDialog>): MountedDialog {
  const container = window.document.createElement('div') as unknown as HTMLElement
  window.document.body.appendChild(container)
  const root = createRoot(container)

  act(() => {
    root.render(<BranchNameDialog controller={controller} t={t} />)
  })

  return { root, container }
}

/** Fake sessions service recording calls, receiver identity, addressability. */
function fakeSessions(options: { addressableFrom?: string[] } = {}): SessionsServiceLike & {
  readonly opened: string[]
  readonly calls: { thisArg: unknown; opts: unknown[] }[]
} {
  const opened: string[] = []
  const calls: { thisArg: unknown; opts: unknown[] }[] = []
  const service: SessionsServiceLike = {
    fork(...opts: [{ sessionId: string }]): Promise<string> {
      calls.push({ thisArg: this, opts })
      return Promise.resolve(`child-of-${opts[0]!.sessionId}`)
    },
    open(sessionId) {
      opened.push(sessionId)
    },
    binding(sessionId) {
      return options.addressableFrom?.includes(sessionId) ? { session: sessionId } : undefined
    },
  }
  return Object.assign(service, { opened, calls })
}

/** Deps harness: scripted dialog + recording wire/gate. */
function depsHarness(overrides: Partial<ForkInterceptDeps> = {}): {
  deps: ForkInterceptDeps
  forkCalls: ForkEndpointPayload[]
  nextResults: ForkEndpointResult[]
  waitFor: string[]
} {
  const forkCalls: ForkEndpointPayload[] = []
  const nextResults: ForkEndpointResult[] = [{ ok: true, value: { sessionId: 'child-1' } }]
  const waitFor: string[] = []
  const sessions = fakeSessions({ addressableFrom: ['child-1'] })
  const deps: ForkInterceptDeps = {
    sessions,
    requestName: (submit) => submit('review').then(outcome =>
      outcome.ok ? { sessionId: outcome.sessionId } : undefined),
    validateName: () => ({ ok: true }),
    formatInvalidName: (reason) => `Invalid branch name: ${reason}`,
    callFork: async (payload) => {
      forkCalls.push(payload)
      return nextResults.length > 1 ? nextResults.shift()! : nextResults[0]!
    },
    waitForSession: async (sessionId) => {
      waitFor.push(sessionId)
    },
    ...overrides,
  }
  return { deps, forkCalls, nextResults, waitFor }
}

describe('fork-name dialog controller', () => {
  test('Enter does not confirm while composing, but confirms after composition ends', async () => {
    const dialog = createBranchNameDialog()
    const request = dialog.requestName(async () => ({
      ok: true,
      sessionId: 'child-ime',
    }))

    dialog.changeDraft('branch')

    const mounted = mountDialog(dialog)

    const input = window.document.body.querySelector('input')
    expect(input).not.toBeNull()

    await act(async () => {
      Simulate.compositionStart(input!)
      input!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(dialog.getSnapshot().phase).toBe('open')

    await act(async () => {
      Simulate.compositionEnd(input!)
      input!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    await expect(request).resolves.toEqual({ sessionId: 'child-ime' })
    expect(dialog.getSnapshot().phase).toBe('closed')

    await act(async () => {
      mounted.root.unmount()
    })
  })
  test('accept path: submit ok resolves the child id and closes', async () => {
    const dialog = createBranchNameDialog()
    const request = dialog.requestName(async () => ({ ok: true, sessionId: 'child-9' }))
    expect(dialog.getSnapshot().phase).toBe('open')
    dialog.confirm()
    await expect(request).resolves.toEqual({ sessionId: 'child-9' })
    expect(dialog.getSnapshot().phase).toBe('closed')
  })

  test('reject path: a failed submit shows the message and stays open; retry then accept', async () => {
    const dialog = createBranchNameDialog()
    let attempt = 0
    const request = dialog.requestName(async () => {
      attempt += 1
      return attempt === 1
        ? { ok: false, message: 'A branch with that name already exists.' }
        : { ok: true, sessionId: 'child-2' }
    })
    dialog.confirm()
    await Promise.resolve() // let the rejection settle into state
    expect(dialog.getSnapshot().phase).toBe('open')
    expect(dialog.getSnapshot().error).toBe('A branch with that name already exists.')
    dialog.confirm()
    await expect(request).resolves.toEqual({ sessionId: 'child-2' })
  })
  test('editing the draft clears a previous validation error', async () => {
    const dialog = createBranchNameDialog()
    const request = dialog.requestName(async () => ({
      ok: false,
      message: 'A branch with that name already exists.',
    }))

    dialog.confirm()
    await Promise.resolve()

    expect(dialog.getSnapshot().error).toBe('A branch with that name already exists.')

    dialog.changeDraft('x')

    expect(dialog.getSnapshot().error).toBeNull()

    dialog.cancel()
    await expect(request).resolves.toBeUndefined()
  })

  test('cancel settles undefined; a confirm landing mid-flight after cancel is dropped', async () => {
    const dialog = createBranchNameDialog()
    let release!: (outcome: { ok: true; sessionId: string }) => void
    const request = dialog.requestName(() => new Promise(resolve => {
      release = resolve
    }))
    dialog.confirm() // submission goes in flight; its promise is now pending
    dialog.cancel() // user cancels while the submission is still flying
    release({ ok: true, sessionId: 'child-late' }) // late outcome must be dropped
    await expect(request).resolves.toBeUndefined()
    expect(dialog.getSnapshot().phase).toBe('closed')
  })

  test('a second concurrent request settles undefined immediately', async () => {
    const dialog = createBranchNameDialog()
    void dialog.requestName(() => new Promise(() => { }))
    await expect(dialog.requestName(() => new Promise(() => { }))).resolves.toBeUndefined()
  })
})

describe('intercepted fork flow', () => {
  test('success: gate passes, wire called once, child awaited then opened, childId returned', async () => {
    const { deps, forkCalls, waitFor } = depsHarness()
    installForkIntercept(deps)
    const result = await deps.sessions.fork({ sessionId: 's1', increaseTitle: true })
    expect(result).toBe('child-1')
    expect(forkCalls).toEqual([{ sessionId: 's1', name: 'review' }]) // increaseTitle dropped
    expect(waitFor).toEqual(['child-1'])
    expect((deps.sessions as { opened: string[] }).opened).toEqual(['child-1'])
  })

  test('fractional atSeq floors to an integer on the wire', async () => {
    const { deps, forkCalls } = depsHarness()
    installForkIntercept(deps)
    await deps.sessions.fork({ sessionId: 's1', atSeq: 41.7, increaseTitle: true })
    expect(forkCalls).toEqual([{ sessionId: 's1', name: 'review', atSeq: 41 }])
  })

  test('cancel rejects with the cancel error and never touches the wire', async () => {
    const { deps, forkCalls } = depsHarness({
      requestName: () => Promise.resolve(undefined),
    })
    installForkIntercept(deps)
    await expect(deps.sessions.fork({ sessionId: 's1' })).rejects.toThrow('fork cancelled')
    expect(forkCalls).toEqual([])
    expect((deps.sessions as { opened: string[] }).opened).toEqual([])
  })

  test('client pre-gate failure surfaces through the dialog bridge without wire traffic', async () => {
    const seenSubmissions: string[] = []
    const { deps, forkCalls } = depsHarness({
      validateName: (name) => name === 'ok-name' ? { ok: true } : { ok: false, reason: 'name must not be empty' },
      requestName: (submit) =>
        submit('bad name').then(first => {
          seenSubmissions.push('first')
          if (!first.ok) return submit('ok-name').then(second =>
            second.ok ? { sessionId: second.sessionId } : undefined)
          return undefined
        }),
    })
    installForkIntercept(deps)
    await expect(deps.sessions.fork({ sessionId: 's1' })).resolves.toBe('child-1')
    expect(seenSubmissions).toEqual(['first'])
    expect(forkCalls).toEqual([{ sessionId: 's1', name: 'ok-name' }]) // only the valid name went out
  })

  test('host rejection surfaces as the dialog error message and allows a retry', async () => {
    const results: ForkEndpointResult[] = [
      { ok: false, error: { code: 'internal', message: 'A branch with that name already exists.' } },
      { ok: true, value: { sessionId: 'child-3' } },
    ]
    const { deps, forkCalls } = depsHarness({
      callFork: async (payload) => {
        forkCalls.push(payload)
        return results.shift()!
      },
      requestName: (submit) =>
        submit('dup').then(first =>
          first.ok || first.message === '' ? undefined
            : submit('unique').then(second => second.ok ? { sessionId: second.sessionId } : undefined)),
    })
    installForkIntercept(deps)
    await expect(deps.sessions.fork({ sessionId: 's1' })).resolves.toBe('child-3')
    expect(forkCalls.map(call => call.name)).toEqual(['dup', 'unique'])
  })

  test('re-install (HMR invalidate) does not nest wrappers', async () => {
    const { deps, forkCalls } = depsHarness()
    installForkIntercept(deps)
    const afterFirst = deps.sessions.fork
    installForkIntercept(deps)
    expect(deps.sessions.fork).toBe(afterFirst)
    await deps.sessions.fork({ sessionId: 's2' })
    expect(forkCalls.length).toBe(1)
  })
})
