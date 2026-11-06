import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { Script } from "node:vm"
import ts from "typescript"
import * as clientModule from "./tui-client.ts"
import { acceptTuiSuggestion, createTuiClient, type TuiSnapshot, type TuiTarget } from "./tui-client.ts"

const target = (sessionID = "A", directory = "/project/A"): TuiTarget => ({ sessionID, location: { directory } })
const ready = (sessionID = "A", updatedAt = "1"): TuiSnapshot => ({
  sessionID, suggestion: "Run the tests.", status: "ready", enabled: true, updatedAt, revision: `turn-${updatedAt}`, ghostAcceptKeys: ["space", "right"],
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function tuiDefinition() {
  const source = readFileSync(new URL("./tui.tsx", import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const module = { exports: {} as { default?: { setup(context: unknown): () => void } } }
  const signals = { createSignal: (initial?: unknown) => { let value = initial; return [() => value, (next: unknown) => { value = next }] }, createEffect: (effect: () => void) => effect(), Show: () => undefined }
  new Script(compiled).runInNewContext({
    module, exports: module.exports,
    require: (name: string) => {
      if (name === "@opencode/plugin/tui") return { Plugin: { define: (definition: unknown) => definition } }
      if (name === "solid-js") return signals
      if (name === "./rpc.ts") return { PromptSuggester: {} }
      if (name === "./tui-client.ts") return clientModule
      if (name === "@opentui/solid/jsx-runtime") return {}
      throw new Error(`Unexpected module ${name}`)
    },
    AbortController,
    setInterval: () => 0,
    clearInterval() {},
  })
  return module.exports.default!
}

test("TUI snapshots follow directory changes and discard superseded reads", async () => {
  let current = target()
  const requests: Array<{ target: TuiTarget; signal: AbortSignal; result: ReturnType<typeof deferred<TuiSnapshot>> }> = []
  const ui = createTuiClient({
    current: () => current,
    read: (target, signal) => {
      const result = deferred<TuiSnapshot>()
      requests.push({ target, signal, result })
      return result.promise
    },
    changed() {},
  })
  const previous = ui.refresh()
  current = target("A", "/project/B")
  const next = ui.refresh()
  assert.equal(requests[0].signal.aborted, true)
  assert.equal(requests[1].target.location.directory, "/project/B")
  requests[1].result.resolve({ ...ready(), suggestion: "B suggestion" })
  await next
  requests[0].result.resolve({ ...ready(), suggestion: "A suggestion" })
  await previous
  assert.equal(ui.visible()?.suggestion, "B suggestion")
  ui.dispose()
})

test("TUI read failures hide stale suggestions and polling does not overlap", async () => {
  let fail = false
  const wait = deferred<TuiSnapshot>()
  let reads = 0
  const ui = createTuiClient({
    current: () => target(),
    read: async () => { reads++; if (fail) throw new Error("disconnected"); return wait.promise },
    changed() {},
  })
  const first = ui.refresh()
  const duplicate = ui.refresh()
  assert.equal(reads, 1)
  wait.resolve(ready())
  await Promise.all([first, duplicate])
  assert.equal(ui.visible()?.suggestion, "Run the tests.")
  fail = true
  await ui.refresh()
  assert.equal(ui.visible(), undefined)
  ui.dispose()
})

test("TUI mutations invalidate pending snapshots and respect disabled server state", async () => {
  const old = deferred<TuiSnapshot>()
  let enabled = true
  let reads = 0
  const ui = createTuiClient({
    current: () => target(),
    read: async () => ++reads === 1 ? old.promise : { ...ready(), enabled },
    changed() {},
  })
  const pending = ui.refresh()
  const resume = ui.suspend(target())
  await ui.refresh()
  assert.equal(reads, 1)
  old.resolve(ready())
  await pending
  assert.equal(ui.visible(), undefined)
  enabled = false
  resume()
  await ui.refresh()
  assert.equal(ui.visible(), undefined)
  ui.dispose()
})

test("TUI dismissal hides a revision even if a late server read repeats it", async () => {
  let snapshot = ready()
  const ui = createTuiClient({ current: () => target(), read: async () => snapshot, changed() {} })
  await ui.refresh()
  ui.dismiss()
  await ui.refresh()
  assert.equal(ui.visible(), undefined)
  snapshot = { ...ready(), revision: "next-generation" }
  await ui.refresh()
  assert.equal(ui.visible()?.revision, "next-generation")
  ui.dispose()
})

test("TUI disposal aborts pending work and ignores late responses", async () => {
  const response = deferred<TuiSnapshot>()
  let signal: AbortSignal | undefined
  let updates = 0
  const ui = createTuiClient({
    current: () => target(),
    read: async (_, abort) => { signal = abort; return response.promise },
    changed: () => updates++,
  })
  const pending = ui.refresh()
  ui.dispose()
  const count = updates
  response.resolve(ready())
  await pending
  await ui.refresh()
  assert.equal(signal?.aborted, true)
  assert.equal(updates, count)
  assert.equal(ui.visible(), undefined)
})

test("TUI acceptance checks focus, empty composer and routed session at dispatch", () => {
  let focused = false
  let empty = true
  const writes: string[] = []
  const prompt = { focused: () => focused, isEmpty: () => empty, set: (text: string) => { writes.push(text); return true }, submit: (text: string) => { writes.push(`submit:${text}`); return true } }
  assert.equal(acceptTuiSuggestion(ready(), target(), prompt, false), false)
  focused = true
  empty = false
  assert.equal(acceptTuiSuggestion(ready(), target(), prompt, false), false)
  empty = true
  assert.equal(acceptTuiSuggestion(ready(), target("B"), prompt, true), false)
  assert.deepEqual(writes, [])
  assert.equal(acceptTuiSuggestion(ready(), target(), prompt, false), true)
  assert.equal(acceptTuiSuggestion(ready(), target(), prompt, true), true)
  assert.deepEqual(writes, ["Run the tests.", "submit:Run the tests."])
})

test("TUI commands use the routed RPC location after /cd", async () => {
  let directory = "/project/A"
  const calls: Array<{ method: string; directory: string }> = []
  const layerFactories: Array<() => { mode?: string; commands: Array<{ id: string; run(input?: string): Promise<void> | void }> }> = []
  const rpc = Object.fromEntries(["get", "clear", "configure", "reseed", "status", "refresh"].map(method => [method, async (_input: unknown, options: { location: { directory: string } }) => {
    calls.push({ method, directory: options.location.directory })
    return { ...ready(), enabled: false, seedReady: false, suggesterModel: "small" }
  }]))
  const dispose = tuiDefinition().setup({
    client: { rpc: () => rpc },
    data: { session: { get: () => ({ location: { directory } }), status: () => "idle" }, on: () => () => {} },
    ui: { router: { current: () => ({ type: "session", sessionID: "A" }) }, toast: { show() {} }, slot: () => () => {} },
    keymap: { layer: (factory: typeof layerFactories[number]) => layerFactories.push(factory) },
  })
  await Promise.resolve()
  directory = "/project/B"
  const command = layerFactories[0]().commands[0].run
  for (const action of ["off", "reseed", "status", "refresh"]) await command(action)
  for (const method of ["configure", "reseed", "status", "refresh"]) {
    assert.equal(calls.find(call => call.method === method)?.directory, "/project/B")
  }
  assert.equal(layerFactories[1]().mode, undefined, "composer shortcuts must retain base-mode scoping")
  dispose()
})

test("stock TUI warns on acceptance and allows dedicated dismissal without the prompt patch", async () => {
  type Command = { id: string; enabled?: () => boolean; run(): void | false }
  const factories: Array<() => { mode?: string; commands: Command[] }> = []
  const toasts: Array<{ message: string; variant: string }> = []
  let snapshot = ready()
  let clears = 0
  let dismissedRevision: string | undefined
  const dispose = tuiDefinition().setup({
    client: { rpc: () => ({
      get: async () => snapshot,
      clear: async (input: { revision?: string }) => { clears++; dismissedRevision = input.revision; snapshot = { ...ready(), suggestion: "", status: "none" }; return snapshot },
    }) },
    data: { session: { get: () => ({ location: { directory: "/project/A" } }), status: () => "idle" }, on: () => () => {} },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "A" }) },
      toast: { show: (toast: typeof toasts[number]) => toasts.push(toast) },
      slot: () => () => {},
    },
    keymap: { layer: (factory: typeof factories[number]) => factories.push(factory) },
  })
  await new Promise<void>(resolve => setImmediate(resolve))
  const layer = factories[1]()
  assert.equal(layer.mode, undefined)
  const accept = layer.commands.find(command => command.id === "suggester.accept")!
  const dismiss = layer.commands.find(command => command.id === "suggester.dismiss")!
  assert.equal(accept.enabled?.(), true)
  accept.run()
  assert.equal(toasts.at(-1)?.variant, "warning")
  assert.match(toasts.at(-1)?.message ?? "", /prompt-api\.patch/)
  assert.equal(clears, 0)
  assert.equal(dismiss.enabled?.(), true)
  dismiss.run()
  assert.equal(clears, 1)
  assert.equal(dismissedRevision, "turn-1")
  assert.equal(dismiss.enabled?.(), false)
  dispose()
})

test("TUI insertion and submission never send a delayed server clear", async () => {
  type Command = { id: string; run(): void | false }
  const factories: Array<() => { commands: Command[] }> = []
  const events = new Map<string, () => void>()
  let snapshot = ready()
  let clears = 0
  const actions: string[] = []
  const dispose = tuiDefinition().setup({
    client: { rpc: () => ({ get: async () => snapshot, clear: async () => { clears++; return snapshot } }) },
    data: {
      session: { get: () => ({ location: { directory: "/project/A" } }), status: () => "idle" },
      on: (name: string, handler: () => void) => { events.set(name, handler); return () => events.delete(name) },
    },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "A" }) },
      toast: { show() {} },
      slot: () => () => {},
      prompt: {
        focused: () => true,
        isEmpty: () => true,
        set: (text: string) => { actions.push(`insert:${text}`); return true },
        submit: (text: string) => { actions.push(`submit:${text}`); return true },
      },
    },
    keymap: { layer: (factory: typeof factories[number]) => factories.push(factory) },
  })
  await new Promise<void>(resolve => setImmediate(resolve))
  factories[1]().commands.find(command => command.id === "suggester.insert-space")!.run()
  assert.deepEqual(actions, ["insert:Run the tests."])
  assert.equal(clears, 0)
  snapshot = ready("A", "2")
  events.get("session.execution.succeeded")!()
  await new Promise<void>(resolve => setImmediate(resolve))
  factories[1]().commands.find(command => command.id === "suggester.accept")!.run()
  assert.deepEqual(actions, ["insert:Run the tests.", "submit:Run the tests."])
  assert.equal(clears, 0)
  dispose()
})
