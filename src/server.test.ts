import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test, { type TestContext } from "node:test"
import type { Plugin } from "@opencode/plugin"
import type { PartialSuggesterConfig } from "./domain/config.ts"
import { emptyFindings, type SeedArtifact } from "./domain/seed.ts"
import { loadLive, loadSeed, loadSessionState, saveConfig, saveSeed } from "./infra/store.ts"
import type { SuggestionSnapshot, SuggesterStatus } from "./rpc.ts"
import server from "./server.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

type SessionEvent = { type: string; data: { sessionID: string } }

class EventQueue {
  private readonly pending: SessionEvent[] = []
  private wake: (() => void) | undefined

  push(type: string, sessionID: string) {
    this.pending.push({ type, data: { sessionID } })
    this.wake?.()
  }

  async *subscribe({ signal }: { signal: AbortSignal }) {
    while (!signal.aborted) {
      const event = this.pending.shift()
      if (event) {
        yield event
        continue
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal.removeEventListener("abort", wake)
          this.wake = undefined
          resolve()
        }
        this.wake = wake
        signal.addEventListener("abort", wake, { once: true })
        if (signal.aborted || this.pending.length) wake()
      })
    }
  }
}

async function until(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(2)
  }
  assert.fail(message)
}

type Request = { sessionID: string; prompt: string; signal?: AbortSignal }
type FixtureOptions = {
  nested?: boolean
  config?: PartialSuggesterConfig
  generate?: (request: Request) => Promise<string>
}

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "suggester-server-"))
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = path.join(root, "state")
  const worktree = path.join(root, "project")
  const directory = options.nested ? path.join(worktree, "src") : worktree
  await saveConfig(worktree, "project", {
    inference: { suggesterModel: "session-default" },
    ...options.config,
  })

  const events = new EventQueue()
  const requests: Request[] = []
  const missing = new Set<string>()
  const busy = new Set<string>()
  const blockedLookups = new Map<string, Promise<void>>()
  const lookups: string[] = []
  let prompt!: (input: { sessionID: string; prompt: { text: string } }) => Promise<void>
  let handlers!: Record<string, (input: { sessionID: string; enabled?: boolean; revision?: string }) => Promise<unknown>>
  let disposedRegistration = false
  const ctx = {
    location: { directory, project: { id: "project", directory: worktree, canonical: worktree } },
    options: {},
    rpc: {
      register: async (_definition: unknown, methods: typeof handlers) => {
        handlers = methods
        return { dispose: async () => { disposedRegistration = true } }
      },
    },
    session: {
      hook: async (_kind: string, handler: typeof prompt) => { prompt = handler },
      get: async ({ sessionID }: { sessionID: string }) => {
        lookups.push(sessionID)
        await blockedLookups.get(sessionID)
        if (missing.has(sessionID)) throw new Error("Session not found: " + sessionID)
        return {
          id: sessionID, location: { directory }, model: { providerID: "test", id: sessionID },
          time: busy.has(sessionID) ? { busy: 2, idle: 1 } : { busy: 1, idle: 2 },
        }
      },
      context: async ({ sessionID }: { sessionID: string }) => [{
        type: "assistant", finish: "stop", content: [{ type: "text", text: "Completed the previous turn in " + sessionID }],
      }],
    },
    model: { default: async () => ({ data: { providerID: "test", modelID: "default" } }) },
    experimental: {
      generate: {
        text: async (input: { model: { id: string }; prompt: string }, requestOptions: { signal?: AbortSignal }) => {
          const request = { sessionID: input.model.id, prompt: input.prompt, signal: requestOptions.signal }
          requests.push(request)
          const text = await (options.generate?.(request) ?? Promise.resolve("Follow up " + request.sessionID + "."))
          return { text }
        },
      },
    },
    event: { subscribe: (input: { signal: AbortSignal }) => events.subscribe(input) },
  } as unknown as Plugin.Context
  const cleanup = await server.setup(ctx)
  assert.equal(typeof cleanup, "function")
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    await cleanup!()
  }
  t.after(async () => {
    await dispose()
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
    await rm(root, { recursive: true, force: true })
  })
  return {
    directory, worktree, events, requests, missing, busy, blockedLookups, lookups, prompt, dispose,
    registrationDisposed: () => disposedRegistration,
    get: (sessionID: string) => handlers.get!({ sessionID }) as Promise<SuggestionSnapshot>,
    status: (sessionID: string) => handlers.status!({ sessionID }) as Promise<SuggesterStatus>,
    configure: (sessionID: string, enabled: boolean) => handlers.configure!({ sessionID, enabled }) as Promise<SuggesterStatus>,
    refresh: (sessionID: string) => handlers.refresh!({ sessionID }) as Promise<SuggestionSnapshot>,
    clear: (sessionID: string, revision?: string) => handlers.clear!({ sessionID, revision }) as Promise<SuggestionSnapshot>,
  }
}

test("slow inference in A does not delay B's started or completed events", async (t) => {
  const modelA = deferred<string>()
  const app = await fixture(t, { generate: async ({ sessionID }) => sessionID === "A" ? modelA.promise : "Follow up B." })
  app.events.push("session.execution.succeeded", "A")
  await until(async () => app.requests.some((request) => request.sessionID === "A"), "A inference did not start")

  app.events.push("session.execution.started", "B")
  await until(async () => (await loadLive(app.worktree, "B"))?.status === "pending", "B started was blocked by A")
  app.events.push("session.execution.succeeded", "B")
  await until(async () => (await loadLive(app.worktree, "B"))?.text === "Follow up B.", "B completion was blocked by A")
  assert.equal(app.requests.find((request) => request.sessionID === "A")?.signal?.aborted, false)
  modelA.resolve("Follow up A.")
  await until(async () => (await loadLive(app.worktree, "A"))?.text === "Follow up A.", "A result was not published")
})

test("a missing session lookup does not stop the next valid event", async (t) => {
  const errors: unknown[][] = []
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args) })
  const app = await fixture(t)
  app.missing.add("deleted")
  app.events.push("session.execution.succeeded", "deleted")
  app.events.push("session.deleted", "deleted")
  app.events.push("session.execution.started", "B")
  await until(async () => (await loadLive(app.worktree, "B"))?.status === "pending", "Consumer stopped after missing session")
  assert(errors.some((args) => args.map(String).join(" ").includes("Session not found")))
})

for (const boundary of ["started", "prompt"] as const) {
  test(`${boundary} cancels an older result without overwriting the next prompt state`, async (t) => {
    t.mock.method(console, "error", () => {})
    const model = deferred<string>()
    const app = await fixture(t, { generate: async () => model.promise })
    app.events.push("session.execution.succeeded", "A")
    await until(async () => app.requests.length === 1, "Inference did not start")
    if (boundary === "started") app.events.push("session.execution.started", "A")
    else await app.prompt({ sessionID: "A", prompt: { text: "Actually change direction." } })
    await until(async () => (await loadLive(app.worktree, "A"))?.status === "pending", "Next prompt was not cleared")
    assert.equal(app.requests[0]?.signal?.aborted, true)
    model.resolve("Obsolete follow-up")
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal((await app.get("A")).suggestion, "")
    const state = await loadSessionState(app.worktree, "A")
    if (boundary === "prompt") assert.equal(state.steering[0]?.actualUserPrompt, "Actually change direction.")
    assert.notEqual(state.lastSuggestion, "Obsolete follow-up")
  })
}

test("switching off cancels inference and keeps RPC results empty", async (t) => {
  t.mock.method(console, "error", () => {})
  const model = deferred<string>()
  const app = await fixture(t, { generate: async () => model.promise })
  app.events.push("session.execution.succeeded", "A")
  await until(async () => app.requests.length === 1, "Inference did not start")
  assert.equal((await app.get("A")).status, "ready")
  assert.equal((await app.configure("A", false)).enabled, false)
  assert.equal(app.requests[0]?.signal?.aborted, true)
  model.resolve("Result after disabling")
  await new Promise<void>((resolve) => setImmediate(resolve))
  const current = await app.get("A")
  assert.equal(current.enabled, false)
  assert.equal(current.suggestion, "")
  assert.equal(current.status, "none")
  assert.equal((await loadLive(app.worktree, "A"))?.text, "")
})

test("subdirectory sessions honour project-root configuration and cached intent", async (t) => {
  const app = await fixture(t, { nested: true, config: { enabled: false } })
  const seed: SeedArtifact = {
    seedVersion: 3, generatedAt: new Date().toISOString(), generatorVersion: "test",
    seederPromptVersion: "test", suggestionPromptVersion: "test", configFingerprint: "test",
    projectIntentSummary: "Shared root project intent", objectivesSummary: "Objectives", constraintsSummary: "Constraints",
    principlesGuidelinesSummary: "Principles", implementationStatusSummary: "Status", topObjectives: [],
    constraints: [], keyFiles: [], categoryFindings: emptyFindings(), openQuestions: [],
  }
  await saveSeed(app.worktree, seed)
  const status = await app.status("A")
  assert.equal(status.enabled, false)
  assert.equal(status.seedReady, true)
  await app.configure("A", true)
  app.events.push("session.execution.succeeded", "A")
  await until(async () => (await loadLive(app.worktree, "A"))?.text === "Follow up A.", "Project-root result was not published")
  assert.match(app.requests[0]!.prompt, /Shared root project intent/)
  assert.equal(await loadLive(app.directory, "A"), null)
})

for (const outcome of ["failed", "interrupted"] as const) {
  test(`${outcome} event publishes continue despite the previous successful assistant`, async (t) => {
    const app = await fixture(t)
    app.events.push("session.execution." + outcome, "A")
    await until(async () => (await loadLive(app.worktree, "A"))?.text === "continue", "Recovery suggestion was not published")
    assert.equal(app.requests.length, 0)
  })
}

test("cleanup does not wait for an uncooperative model or admit its late result", async (t) => {
  const model = deferred<string>()
  const app = await fixture(t, { generate: async () => model.promise })
  app.events.push("session.execution.succeeded", "A")
  await until(async () => app.requests.length === 1, "Inference did not start")
  const before = await loadLive(app.worktree, "A")
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      app.dispose(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Cleanup waited for an uncooperative model")), 200)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
  assert.equal(app.registrationDisposed(), true)
  assert.equal(app.requests[0]?.signal?.aborted, true)
  model.resolve("Late result after cleanup")
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(await loadLive(app.worktree, "A"), before)
})

test("cleanup rejects writes from an event lookup that finishes after unload", async (t) => {
  const app = await fixture(t)
  const lookup = deferred<void>()
  app.blockedLookups.set("A", lookup.promise)
  app.events.push("session.execution.started", "A")
  await until(async () => app.lookups.includes("A"), "Session lookup did not start")
  const disposing = app.dispose()
  lookup.resolve()
  await disposing
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(await loadLive(app.worktree, "A"), null)
})

test("refresh cannot generate during a turn already running when the plugin loads", async (t) => {
  const app = await fixture(t)
  app.busy.add("A")
  assert.equal((await app.refresh("A")).suggestion, "")
  assert.equal(app.requests.length, 0)
  app.busy.delete("A")
  assert.equal((await app.refresh("A")).suggestion, "Follow up A.")
  assert.equal(app.requests.length, 1)
  app.busy.add("A")
  assert.equal((await app.get("A")).suggestion, "")
  assert.equal((await app.refresh("A")).suggestion, "")
  assert.equal(app.requests.length, 1)
})

test("starting the next turn also cancels a background seeder after suggestion completion", async (t) => {
  t.mock.method(console, "error", () => {})
  const seeder = deferred<string>()
  let calls = 0
  const app = await fixture(t, {
    config: { reseed: { enabled: true, turnCheckInterval: 1 } },
    generate: async () => ++calls === 1 ? "Follow up A." : seeder.promise,
  })
  app.events.push("session.execution.succeeded", "A")
  await until(async () => app.requests.length === 2, "Background seeder did not start")
  app.events.push("session.execution.started", "A")
  await until(async () => (await loadLive(app.worktree, "A"))?.status === "pending", "New turn was not recorded")
  assert.equal(app.requests[1]?.signal?.aborted, true)
  seeder.resolve(JSON.stringify({ type: "final", seed: {
    projectIntentSummary: "Obsolete seed", objectivesSummary: "Objectives", constraintsSummary: "Constraints",
    principlesGuidelinesSummary: "Principles", implementationStatusSummary: "Status", topObjectives: [],
    constraints: [], keyFiles: [], categoryFindings: emptyFindings(), openQuestions: [],
  } }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(await loadSeed(app.worktree), null)
})

test("an older completion lookup cannot start generation after the next prompt arrives", async (t) => {
  const app = await fixture(t)
  app.events.push("session.execution.started", "A")
  await until(async () => (await loadLive(app.worktree, "A"))?.status === "pending", "First execution did not start")
  const lookup = deferred<void>()
  const previousLookups = app.lookups.length
  app.blockedLookups.set("A", lookup.promise)
  app.events.push("session.execution.succeeded", "A")
  await until(async () => app.lookups.length > previousLookups, "Completion lookup did not start")

  // Only the older event keeps its captured gate; prompt admission can proceed.
  app.blockedLookups.delete("A")
  await app.prompt({ sessionID: "A", prompt: { text: "Begin the next turn." } })
  lookup.resolve()
  app.events.push("session.execution.started", "B")
  await until(async () => (await loadLive(app.worktree, "B"))?.status === "pending", "Consumer did not process its next event")
  assert.equal(app.requests.length, 0)
  assert.equal((await loadLive(app.worktree, "A"))?.status, "pending")
  // If admission was rejected, authoritative idle state must still allow refresh.
  assert.equal((await app.refresh("A")).suggestion, "Follow up A.")
})

test("a prompt admission without a started event does not incorrectly mark the host busy", async (t) => {
  const app = await fixture(t)
  await app.prompt({ sessionID: "A", prompt: { text: "The host may reject or queue this draft." } })
  const refreshed = await app.refresh("A")
  assert.equal(refreshed.suggestion, "Follow up A.")
  assert.equal(app.requests.length, 1)
})

test("a delayed dismissal for an earlier revision cannot cancel the next generation", async (t) => {
  const first = deferred<string>()
  const second = deferred<string>()
  let calls = 0
  const app = await fixture(t, { generate: async () => ++calls === 1 ? first.promise : second.promise })
  app.events.push("session.execution.succeeded", "A")
  await until(async () => app.requests.length === 1, "First generation did not start")
  const old = await app.get("A")
  assert(old.revision)

  app.events.push("session.execution.started", "A")
  await until(async () => (await loadLive(app.worktree, "A"))?.status === "pending", "New turn did not clear the old suggestion")
  app.events.push("session.execution.succeeded", "A")
  await until(async () => app.requests.length === 2, "Second generation did not start")
  const current = await app.get("A")
  assert.notEqual(current.revision, old.revision)
  const afterStaleDismiss = await app.clear("A", old.revision)
  assert.equal(afterStaleDismiss.revision, current.revision)
  assert.equal(afterStaleDismiss.status, "ready")
  assert.equal(app.requests[1]?.signal?.aborted, false)

  first.resolve("Old result")
  second.resolve("New result")
  await until(async () => (await loadLive(app.worktree, "A"))?.text === "New result", "Stale dismissal prevented the new generation")
})

test("a dismissal cancels its own generation even after refinement changes updatedAt", async (t) => {
  const model = deferred<string>()
  const app = await fixture(t, { generate: async () => model.promise })
  app.events.push("session.execution.succeeded", "A")
  await until(async () => app.requests.length === 1, "Generation did not start")
  const fallback = await app.get("A")
  assert(fallback.revision)
  await delay(5)
  model.resolve("Refined suggestion")
  await until(async () => (await loadLive(app.worktree, "A"))?.text === "Refined suggestion", "Model refinement was not published")
  const refined = await app.get("A")
  assert.equal(refined.revision, fallback.revision)
  assert.notEqual(refined.updatedAt, fallback.updatedAt)
  assert.equal((await app.clear("A", fallback.revision)).status, "none")
  assert.equal(app.requests[0]?.signal?.aborted, true)
})
