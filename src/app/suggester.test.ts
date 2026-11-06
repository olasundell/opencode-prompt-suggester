import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"
import { loadLive, loadSessionState } from "../infra/store.ts"
import { forgetRuntime, rememberRuntime, type SuggesterRuntime } from "./hidden.ts"
import { onSessionIdle, onUserMessage } from "./suggester.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(t: TestContext, generate: SuggesterRuntime["generate"]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "suggester-engine-"))
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = path.join(root, "state")
  const directory = path.join(root, "project")
  const sessionID = "session"
  rememberRuntime(directory, {
    directory,
    generate,
    messages: async () => [{
      info: { role: "assistant" },
      parts: [{ type: "text", text: "Completed the previous turn." }],
    }],
  })
  t.after(async () => {
    forgetRuntime(directory)
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
    await rm(root, { recursive: true, force: true })
  })
  return { directory, worktree: directory, sessionID }
}

for (const turnStatus of ["error", "aborted"] as const) {
  test(`${turnStatus} execution uses recovery fast path despite a previous successful assistant`, async (t) => {
    let calls = 0
    const input = await fixture(t, async () => {
      calls++
      return "Ordinary follow-up"
    })
    let notifications = 0
    await onSessionIdle({ ...input, turnStatus, onPublish: async () => { notifications++ } })
    assert.equal(calls, 0)
    assert.equal((await loadLive(input.worktree, input.sessionID))?.text, "continue")
    assert.equal(notifications, 1)
  })
}

test("a cancelled generation cannot overwrite the next prompt or its steering history", async (t) => {
  const entered = deferred<void>()
  const result = deferred<string>()
  const controller = new AbortController()
  const input = await fixture(t, async (_prompt, _spec, _smallModel, _sessionID, signal) => {
    assert.equal(signal, controller.signal)
    entered.resolve()
    return result.promise
  })
  const job = onSessionIdle({ ...input, signal: controller.signal, turnStatus: "success" })
  await entered.promise
  assert.equal((await loadLive(input.worktree, input.sessionID))?.text, "Go ahead.")

  controller.abort()
  await onUserMessage({ ...input, text: "Actually, change direction." })
  result.resolve("This result belongs to the previous turn.")
  await assert.rejects(job, { name: "AbortError" })

  const live = await loadLive(input.worktree, input.sessionID)
  assert.equal(live?.text, "")
  assert.equal(live?.status, "pending")
  const state = await loadSessionState(input.worktree, input.sessionID)
  assert.equal(state.steering.length, 1)
  assert.equal(state.steering[0]?.actualUserPrompt, "Actually, change direction.")
})

test("cancellation is rechecked when a queued commit is eventually executed", async (t) => {
  const queued = deferred<() => Promise<void>>()
  const input = await fixture(t, async () => "Unused")
  const controller = new AbortController()
  const job = onSessionIdle({
    ...input,
    signal: controller.signal,
    commit: (write) => {
      queued.resolve(write)
      return Promise.resolve()
    },
  })
  const write = await queued.promise
  controller.abort()
  await assert.rejects(write(), { name: "AbortError" })
  await assert.rejects(job, { name: "AbortError" })
  assert.equal(await loadLive(input.worktree, input.sessionID), null)
})
