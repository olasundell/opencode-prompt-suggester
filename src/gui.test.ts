import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"
import { canInsertSuggestion, createSuggestionView, type SuggestionViewSnapshot } from "./gui-state.ts"

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((done) => { resolve = done })
  return { promise, resolve }
}

const ready = (updatedAt = "first", suggestion = "Run the tests."): SuggestionViewSnapshot => ({
  suggestion, status: "ready", enabled: true, updatedAt, revision: "generation-" + updatedAt,
})

function compile(source: string, require: (name: string) => unknown, extra = {}) {
  const module = { exports: {} }
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  vm.runInNewContext(output.outputText, { module, exports: module.exports, require, console, AbortController, ...extra })
  return module.exports
}

type Command = { id: string; enabled?: boolean; run(input?: string): unknown }

function mountGui() {
  let text = ""
  let normalMode = true
  let focused = true
  let parentID: string | undefined
  let running = false
  let enabled = true
  let latest = ready()
  let read = async () => ({ sessionID: "same-id", ...latest })
  const calls: Array<{ sessionID: string; location: unknown }> = []
  const clears: Array<{ sessionID: string; revision?: string }> = []
  const composer = {
    quotable: () => normalMode,
    text: () => text,
    focused: () => focused,
    setText: (value: string) => { text = value },
    focus: () => { focused = true },
  }
  const api = {
    get: async (input: { sessionID: string }, options: { location: unknown }) => {
      calls.push({ sessionID: input.sessionID, location: options.location })
      return read()
    },
    configure: async (input: { enabled: boolean }) => {
      enabled = input.enabled
      latest = { ...latest, enabled, status: enabled ? "ready" : "none" }
      return latest
    },
    clear: async (input: { sessionID: string; revision?: string }) => {
      clears.push(input)
      latest = { ...latest, status: "none", suggestion: "" }
      return latest
    },
    status: async () => ({ enabled, suggesterModel: "small", seedReady: false, suggestion: "", status: "none" }),
    reseed: async () => ({}),
    refresh: async () => latest,
  }
  const server = {
    data: { session: { get: () => ({ parentID }), status: () => running ? "running" : "idle" } },
    client: { rpc: () => api },
  }
  let session = { key: "server-A\nsame-id", id: "same-id", pending: false, location: { directory: "/project/A" }, server }
  const additions: Array<unknown> = []
  const effects: Array<() => void> = []
  const intervals: Array<() => void> = []
  const context = {
    sessions: { current: () => session },
    screen: { current: () => ({ composer }) },
    toast: { show: () => {} },
    add: (_registry: unknown, contribution: unknown) => { additions.push(contribution) },
  }
  const helper = compile(readFileSync(new URL("./gui-state.ts", import.meta.url), "utf8"), () => { throw Error("unexpected helper import") })
  const plugin = compile(readFileSync(new URL("./gui.tsx", import.meta.url), "utf8"), (name) => {
    if (name === "./gui-state.ts") return helper
    if (name === "./rpc.ts") return { PromptSuggester: {} }
    if (name === "solid-js") return {
      createSignal: (initial: string) => {
        let value = initial
        return [() => value, (next: string) => { value = next }]
      },
    }
    if (name === "@opencode/plugin/gui") return {
      Plugin: { define: (definition: unknown) => definition },
      Command: {}, ComposerPill: {},
      createKeyed: (_key: () => string, effect: () => void) => { effects.push(effect); effect() },
    }
    throw Error(`unexpected GUI import ${name}`)
  }, {
    setInterval: (tick: () => void) => { intervals.push(tick); return 1 },
    clearInterval: () => {},
  }) as { default: { setup(context: unknown): () => void } }
  const dispose = plugin.default.setup(context)
  return {
    command: (id: string) => {
      for (const addition of additions) {
        const command = (typeof addition === "function" ? addition() : addition) as Command
        if (command.id === id) return command
      }
      throw Error(`missing command ${id}`)
    },
    poll: () => intervals.forEach((tick) => tick()),
    route: (key: string, directory: string) => {
      session = { ...session, key, location: { directory } }
      effects.forEach((effect) => effect())
    },
    setRead: (next: typeof read) => { read = next },
    setMode: (normal: boolean) => { normalMode = normal },
    setFocus: (value: boolean) => { focused = value },
    setParent: (value: string | undefined) => { parentID = value },
    setRunning: (value: boolean) => { running = value },
    text: () => text,
    calls,
    clears,
    dispose,
  }
}

const settle = () => new Promise<void>((done) => setImmediate(done))

test("Desktop acceptance refuses shell mode, including mode changes after enabling a command", async () => {
  const gui = mountGui()
  try {
    await settle()
    const send = gui.command("send")
    assert.equal(send.enabled, true)
    gui.setMode(false)
    assert.equal(gui.command("send").enabled, false)
    assert.equal(send.run(), false)
    assert.equal(gui.command("insert").run(), false)
    assert.equal(gui.text(), "")
  } finally { gui.dispose() }
})

test("Desktop does not accept a stale suggestion while running or viewing a subagent", async () => {
  const gui = mountGui()
  try {
    await settle()
    gui.setRunning(true)
    assert.equal(gui.command("send").enabled, false)
    gui.command("send").run()
    assert.equal(gui.text(), "")
    gui.setRunning(false)
    gui.setParent("parent")
    assert.equal(gui.command("send").enabled, false)
    gui.command("insert").run()
    assert.equal(gui.text(), "")
  } finally { gui.dispose() }
})

test("Desktop Enter fills a normal focused composer and yields native submission", async () => {
  const gui = mountGui()
  try {
    await settle()
    assert.equal(gui.command("send").run(), false)
    assert.equal(gui.text(), "Run the tests.")
    assert.equal(gui.command("send").enabled, false)
  } finally { gui.dispose() }
})

test("Desktop off invalidates an older in-flight snapshot", async () => {
  const gui = mountGui()
  try {
    await settle()
    const stale = deferred<{ sessionID: string } & SuggestionViewSnapshot>()
    gui.setRead(() => stale.promise)
    gui.poll()
    gui.setRead(async () => ({ sessionID: "same-id", ...ready(), enabled: false, status: "none" }))
    await gui.command("suggester").run("off")
    stale.resolve({ sessionID: "same-id", ...ready() })
    await settle()
    assert.equal(gui.command("send").enabled, false)
  } finally { gui.dispose() }
})

test("Desktop polls the routed server and location and ignores the previous route response", async () => {
  const gui = mountGui()
  try {
    await settle()
    const previous = deferred<{ sessionID: string } & SuggestionViewSnapshot>()
    gui.setRead(() => previous.promise)
    gui.poll()
    gui.setRead(async () => ({ sessionID: "same-id", ...ready("second", "Check project B.") }))
    gui.route("server-B\nsame-id", "/project/B")
    await settle()
    previous.resolve({ sessionID: "same-id", ...ready("first", "Wrong server.") })
    await settle()
    gui.command("insert").run()
    assert.equal(gui.text(), "Check project B.")
    assert.equal((gui.calls.at(-1)?.location as { directory: string }).directory, "/project/B")
  } finally { gui.dispose() }
})

test("dismissed snapshots stay hidden while a newer generation remains visible", async () => {
  let text = ""
  const view = createSuggestionView((value) => { text = value })
  await view.sync("A", async () => ready())
  assert.equal(text, "Run the tests.")
  view.dismiss("A", "generation-first")
  await view.sync("A", async () => ready())
  assert.equal(text, "")
  await view.sync("A", async () => ready("second"))
  assert.equal(text, "Run the tests.")
  view.dispose()
})

test("Desktop Escape clears only the displayed generation", async () => {
  const gui = mountGui()
  try {
    await settle()
    gui.command("dismiss").run()
    await settle()
    assert.equal(gui.clears.length, 1)
    assert.equal(gui.clears[0]?.sessionID, "same-id")
    assert.equal(gui.clears[0]?.revision, "generation-first")
  } finally { gui.dispose() }
})

test("pending mutation remains paused after leaving and returning to its route", async () => {
  let text = ""
  let reads = 0
  const view = createSuggestionView((value) => { text = value })
  const read = async () => { reads++; return ready() }
  const resume = view.pause("A")
  await view.sync("B", read)
  assert.equal(text, "Run the tests.")
  await view.sync("A", read)
  assert.equal(text, "")
  assert.equal(reads, 1)
  resume()
  await view.sync("A", read)
  assert.equal(reads, 2)
  assert.equal(text, "Run the tests.")
  view.dispose()
})

test("overlapping mutations resume polling only after both finish", async () => {
  let reads = 0
  const view = createSuggestionView(() => {})
  const resumeFirst = view.pause("A")
  const resumeSecond = view.pause("A")
  resumeFirst()
  resumeFirst()
  await view.sync("A", async () => { reads++; return ready() })
  assert.equal(reads, 0)
  resumeSecond()
  await view.sync("A", async () => { reads++; return ready() })
  assert.equal(reads, 1)
  view.dispose()
})

test("generation revisions distinguish suggestions with identical timestamps", async () => {
  let text = ""
  const view = createSuggestionView((value) => { text = value })
  await view.sync("A", async () => ready("same-time"))
  view.dismiss("A", "generation-same-time")
  await view.sync("A", async () => ({ ...ready("same-time"), revision: "new-generation" }))
  assert.equal(text, "Run the tests.")
  view.dispose()
})

test("failed snapshots and disposal clear suggestions and ignore late results", async () => {
  let text = ""
  const view = createSuggestionView((value) => { text = value })
  await view.sync("A", async () => ready())
  await view.sync("A", async () => { throw Error("server unavailable") })
  assert.equal(text, "")
  const result = deferred<SuggestionViewSnapshot>()
  const pending = view.sync("A", () => result.promise)
  view.dispose()
  result.resolve(ready())
  await pending
  assert.equal(text, "")
})

test("suggestion insertion preserves populated drafts and keyboard focus", () => {
  assert.equal(canInsertSuggestion({ quotable: () => true, text: () => "my own prompt", focused: () => true }), false)
  assert.equal(canInsertSuggestion({ quotable: () => true, text: () => "", focused: () => false }), false)
})
