import { unlink } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { Plugin } from "@opencode/plugin"
import { createRuntime, forgetRuntime, rememberRuntime } from "./app/hidden.ts"
import { SessionTasks } from "./app/session-tasks.ts"
import { onSessionIdle, onUserMessage } from "./app/suggester.ts"
import type { TurnStatus } from "./domain/suggestion.ts"
import { PLUGIN_ID, seedPath } from "./infra/paths.ts"
import { loadConfig, loadLive, loadSeed, saveConfig, saveLive } from "./infra/store.ts"
import { PromptSuggester, type SuggestionSnapshot, type SuggesterStatus } from "./rpc.ts"

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx: Plugin.Context) {
    const directory = ctx.location.directory
    const worktree = ctx.location.project.directory
    const smallModel = typeof ctx.options.smallModel === "string" ? ctx.options.smallModel : undefined
    const tasks = new SessionTasks()
    const controller = new AbortController()
    rememberRuntime(directory, createRuntime(ctx, directory, smallModel))

    const report = (message: string, error: unknown) => {
      if (!controller.signal.aborted) console.error("[" + PLUGIN_ID + "] " + message, error)
    }

    async function session(sessionID: string) {
      const current = await ctx.session.get({ sessionID }, { signal: controller.signal })
      controller.signal.throwIfAborted()
      if (current.parentID || current.location.directory !== directory) return
      return current
    }

    async function requireSession(sessionID: string) {
      const current = await session(sessionID)
      if (!current) throw new Error("Prompt suggestions require a root session at this location")
      return current
    }

    function isBusy(current: Awaited<ReturnType<typeof requireSession>>): boolean {
      const time = current.time
      return Boolean(time?.busy && (!time.idle || time.busy > time.idle))
    }

    async function snapshot(sessionID: string, busy = false): Promise<SuggestionSnapshot> {
      const [config, live] = await Promise.all([loadConfig(worktree), loadLive(worktree, sessionID)])
      const visible = config.enabled && !busy && live?.sessionID === sessionID
      return {
        sessionID,
        enabled: config.enabled,
        suggestion: visible ? live.text : "",
        status: visible ? live.status : "none",
        updatedAt: live?.updatedAt ?? "",
        revision: tasks.revision(sessionID),
        ghostAcceptKeys: config.suggestion.ghostAcceptKeys,
      }
    }

    async function status(sessionID: string): Promise<SuggesterStatus> {
      const [config, seed, current] = await Promise.all([
        loadConfig(worktree), loadSeed(worktree), snapshot(sessionID),
      ])
      return {
        enabled: config.enabled,
        suggesterModel: config.inference.suggesterModel,
        seedReady: Boolean(seed),
        suggestion: current.suggestion,
        status: current.status,
        ghostAcceptKeys: config.suggestion.ghostAcceptKeys,
      }
    }

    async function clear(sessionID: string, pending = false): Promise<void> {
      await saveLive(worktree, {
        sessionID, text: "", status: pending ? "pending" : "none", updatedAt: new Date().toISOString(),
      })
    }

    function suggest(sessionID: string, turnStatus?: TurnStatus): Promise<void> {
      return tasks.run(sessionID, async ({ signal, commit }) => {
        try {
          await onSessionIdle({
            directory, worktree, sessionID, turnStatus, signal,
            commit: (write) => commit(async () => {
              // Active locations in this worktree share project configuration.
              if ((await loadConfig(worktree)).enabled) await write()
            }),
          })
        } catch (error) {
          if (!signal.aborted) throw error
        }
      }).catch((error) => report("suggestion failed", error))
    }

    const registration = await ctx.rpc.register(PromptSuggester, {
      get: async (input) => {
        const { sessionID } = input as { sessionID: string }
        const current = await requireSession(sessionID)
        return tasks.mutate(sessionID, () => snapshot(sessionID, isBusy(current)))
      },
      clear: async (input) => {
        const { sessionID, revision } = input as { sessionID: string; revision?: string }
        await requireSession(sessionID)
        return tasks.mutate(sessionID, async () => {
          // Dismiss the displayed generation, including its refinements, without
          // allowing a delayed request to cancel a subsequent turn.
          if (revision !== undefined && revision !== tasks.revision(sessionID)) return snapshot(sessionID)
          tasks.cancel(sessionID)
          await clear(sessionID)
          return snapshot(sessionID)
        })
      },
      refresh: async (input) => {
        const { sessionID } = input as { sessionID: string }
        const current = await requireSession(sessionID)
        if (!isBusy(current)) {
          const outcome = current.outcome
          await suggest(sessionID, outcome === "failed" ? "error" : outcome === "interrupted" ? "aborted" : undefined)
        }
        return tasks.mutate(sessionID, () => snapshot(sessionID, isBusy(current)))
      },
      status: async (input) => {
        const { sessionID } = input as { sessionID: string }
        await requireSession(sessionID)
        return tasks.mutate(sessionID, () => status(sessionID))
      },
      configure: async (input) => {
        const { sessionID, enabled } = input as { sessionID: string; enabled: boolean }
        await requireSession(sessionID)
        if (!enabled) tasks.cancelAll()
        return tasks.mutate(sessionID, async () => {
          await saveConfig(worktree, "project", { enabled })
          if (!enabled) await clear(sessionID)
          return status(sessionID)
        })
      },
      reseed: async (input) => {
        const { sessionID } = input as { sessionID: string }
        await requireSession(sessionID)
        // Invalidates the cache; automatic reseeding keeps its existing policy.
        return tasks.mutate(sessionID, async () => {
          await unlink(seedPath(worktree)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error
          })
          return status(sessionID)
        })
      },
    })

    await ctx.session.hook("prompt", async (event) => {
      tasks.cancel(event.sessionID)
      try {
        if (!await session(event.sessionID)) return
        await tasks.mutate(event.sessionID, () => onUserMessage({
          directory, worktree, sessionID: event.sessionID, text: event.prompt.text,
        }))
      } catch (error) {
        // An auxiliary plugin must not prevent admission of the user's prompt.
        report("could not record prompt", error)
      }
    })

    const consume = (async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({
            types: [
              "session.execution.started", "session.execution.succeeded", "session.execution.failed",
              "session.execution.interrupted", "session.deleted", "session.moved",
            ],
            signal: controller.signal,
          })) {
            if (controller.signal.aborted) break
            const sessionID = event.data.sessionID
            const revision = tasks.revision(sessionID)
            // Invalidate before I/O, including lookups of a deleted/moved session.
            if (event.type === "session.execution.started" || event.type === "session.deleted" || event.type === "session.moved") {
              tasks.cancel(sessionID)
            }
            try {
              if (event.type === "session.deleted" || event.type === "session.moved") {
                continue
              }
              const current = await session(sessionID)
              if (!current) continue
              if (event.type === "session.execution.started") {
                await tasks.mutate(sessionID, () => clear(sessionID, true))
                continue
              }
              // Prompt admission can run concurrently with this lookup, and a
              // reconnected stream can contain a completion from an older turn.
              if (revision !== tasks.revision(sessionID) || isBusy(current)) continue
              const outcome: TurnStatus = event.type === "session.execution.failed" ? "error"
                : event.type === "session.execution.interrupted" ? "aborted" : "success"
              // The model runs outside this consumer. Its commits queue separately.
              void suggest(sessionID, outcome)
            } catch (error) {
              report("could not process session event", error)
            }
          }
        } catch (error) {
          report("event stream disconnected", error)
        }
        if (!controller.signal.aborted) {
          await delay(1_000, undefined, { signal: controller.signal }).catch(() => {})
        }
      }
    })()

    return async () => {
      controller.abort()
      await tasks.dispose()
      forgetRuntime(directory)
      await registration.dispose()
      // The abort signal owns the subscription. A host request which ignores
      // it must not hold unload open; session() rejects its eventual result.
      void consume
    }
  },
})
