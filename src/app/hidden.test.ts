import assert from "node:assert/strict"
import test from "node:test"
import type { Plugin } from "@opencode/plugin"
import { createRuntime, toLegacyMessages, type SourceMessage } from "./hidden.ts"

test("toLegacyMessages keeps user text and assistant text parts", () => {
  const messages: SourceMessage[] = [
    { type: "user", text: "Add a health endpoint" },
    {
      type: "assistant",
      finish: "stop",
      content: [
        { type: "text", text: "I added /healthz." },
        { type: "reasoning", text: "internal" },
      ],
    },
  ]

  assert.deepEqual(toLegacyMessages(messages), [
    {
      info: { role: "user" },
      parts: [{ type: "text", text: "Add a health endpoint" }],
    },
    {
      info: { role: "assistant", error: undefined, finishReason: "stop" },
      parts: [{ type: "text", text: "I added /healthz." }],
    },
  ])
})

test("toLegacyMessages maps tool content and skips non-conversation messages", () => {
  const messages: SourceMessage[] = [
    { type: "system", text: "system" },
    {
      type: "assistant",
      finish: "tool-calls",
      content: [
        {
          type: "tool",
          name: "read",
          state: { status: "completed", input: { filePath: "src/server.ts" } },
        },
      ],
    },
    { type: "idle" },
  ]

  assert.deepEqual(toLegacyMessages(messages), [
    {
      info: { role: "assistant", error: undefined, finishReason: "tool-calls" },
      parts: [
        {
          type: "tool",
          tool: "read",
          state: { status: "completed", input: { filePath: "src/server.ts" }, title: undefined },
        },
      ],
    },
  ])
})

test("toLegacyMessages preserves empty user entries", () => {
  assert.deepEqual(toLegacyMessages([{ type: "user", text: "" }]), [
    { info: { role: "user" }, parts: [] },
  ])
})

test("stateless generation passes the model and abort signal to the host", async () => {
  const controller = new AbortController()
  const calls: unknown[] = []
  const ctx = {
    experimental: {
      generate: {
        text: async (input: unknown, options: { signal?: AbortSignal }) => {
          calls.push(input, options.signal)
          return { text: "  Run the tests.  " }
        },
      },
    },
  } as unknown as Plugin.Context
  const runtime = createRuntime(ctx, "/project")

  assert.equal(
    await runtime.generate("Suggest a prompt", "example/small/model", undefined, "session", controller.signal),
    "Run the tests.",
  )
  assert.deepEqual(calls[0], {
    model: { providerID: "example", id: "small/model" },
    prompt: "Suggest a prompt",
  })
  assert.equal(calls[1], controller.signal)
})

test("generation rejects an already cancelled request without calling the host", async () => {
  const controller = new AbortController()
  controller.abort()
  const runtime = createRuntime({} as Plugin.Context, "/project")
  await assert.rejects(
    runtime.generate("Unused", "example/model", undefined, undefined, controller.signal),
    { name: "AbortError" },
  )
})

test("runtime converts session context without creating hidden sessions", async () => {
  const ctx = {
    session: {
      context: async (input: unknown) => {
        assert.deepEqual(input, { sessionID: "session" })
        return [{ type: "user", text: "Fix it" }]
      },
    },
  } as unknown as Plugin.Context
  const runtime = createRuntime(ctx, "/project")
  assert.deepEqual(await runtime.messages("session"), [{
    info: { role: "user" },
    parts: [{ type: "text", text: "Fix it" }],
  }])
})
