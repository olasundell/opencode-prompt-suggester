/** @jsxImportSource solid-js */
import { Command, ComposerPill, createKeyed, Plugin } from "@opencode/plugin/gui"
import type { MountedSession } from "@opencode/plugin/gui"
import { createSignal } from "solid-js"
import { PromptSuggester, type SuggestionSnapshot, type SuggesterStatus } from "./rpc.ts"
import { canInsertSuggestion, createSuggestionView } from "./gui-state.ts"

export default Plugin.define({
  setup(ctx) {
    const [suggestion, setSuggestion] = createSignal("")
    let snapshot: SuggestionSnapshot | undefined
    let snapshotKey: string | undefined
    let disposed = false
    const view = createSuggestionView(setSuggestion)

    const current = () => {
      const session = ctx.sessions.current()
      if (!session || session.pending || !session.location) return
      if (session.server.data.session.get(session.id)?.parentID) return
      return session
    }

    const routeKey = (session: MountedSession) => `${session.key}\n${JSON.stringify(session.location)}`

    function rpc(session: MountedSession) {
      return session.server.client.rpc(PromptSuggester)
    }

    async function sync() {
      const session = current()
      view.select(session ? routeKey(session) : undefined)
      if (!session || disposed) return
      await view.sync(routeKey(session), async (signal) => {
        const value = await rpc(session).get({ sessionID: session.id }, { location: session.location, signal }) as SuggestionSnapshot
        if (!signal.aborted && current() && routeKey(current()!) === routeKey(session) && !disposed) {
          snapshot = value
          snapshotKey = routeKey(session)
        }
        return value
      })
    }

    function dismissLocal(session: MountedSession) {
      view.dismiss(routeKey(session), snapshotKey === routeKey(session) ? snapshot?.revision ?? snapshot?.updatedAt ?? "" : "")
    }

    const idle = () => {
      const session = current()
      return session?.server.data.session.status(session.id) === "idle"
    }

    function insert(requireFocus = true): boolean {
      const session = current()
      const composer = ctx.screen.current()?.composer
      const text = suggestion()
      if (!session || !idle() || snapshotKey !== routeKey(session) || !text || !canInsertSuggestion(composer, requireFocus)) return false
      composer!.setText(text)
      if (!requireFocus) composer!.focus()
      dismissLocal(session)
      return true
    }

    ctx.add(ComposerPill, {
      id: "suggestion",
      show: (input) => {
        const session = current()
        if (!session || !idle() || routeKey(input.session) !== routeKey(session) || !suggestion()) return
        if (!canInsertSuggestion(input.screen.composer, false)) return
        return {
          label: suggestion(),
          title: "Suggested next prompt · Tab to insert · Enter to send",
          run: () => {
            if (current() && routeKey(current()!) === routeKey(session)) insert(false)
          },
        }
      },
    })

    ctx.add(Command, (): Command => ({
      id: "insert",
      title: "Insert suggested next prompt",
      bind: "tab",
      scope: '[data-component="composer"]',
      editable: true,
      hidden: true,
      enabled: Boolean(suggestion()) && idle() && canInsertSuggestion(ctx.screen.current()?.composer),
      run: () => insert() ? undefined : false,
    }))

    ctx.add(Command, (): Command => ({
      id: "send",
      title: "Send suggested next prompt",
      bind: "enter",
      scope: '[data-component="composer"]',
      editable: true,
      hidden: true,
      enabled: Boolean(suggestion()) && idle() && canInsertSuggestion(ctx.screen.current()?.composer),
      run: () => {
        insert()
        // The host's Enter handler owns submission, model selection and attachments.
        return false
      },
    }))

    ctx.add(Command, (): Command => ({
      id: "dismiss",
      title: "Dismiss suggested next prompt",
      bind: "escape",
      scope: '[data-component="composer"]',
      editable: true,
      hidden: true,
      enabled: Boolean(suggestion()) && idle() && canInsertSuggestion(ctx.screen.current()?.composer),
      run: () => {
        const session = current()
        if (!session || !suggestion() || !canInsertSuggestion(ctx.screen.current()?.composer)) return false
        const revision = snapshotKey === routeKey(session) ? snapshot?.revision : undefined
        dismissLocal(session)
        const resume = view.pause(routeKey(session))
        void rpc(session).clear({ sessionID: session.id, revision }, { location: session.location, signal: ctx.signal })
          .catch(() => {
            if (!disposed) ctx.toast.show({ title: "Prompt suggester", description: "Could not dismiss the server suggestion.", variant: "error" })
          })
          .finally(() => { resume(); if (!disposed) void sync() })
      },
    }))

    ctx.add(Command, {
      id: "suggester",
      title: "Suggester: Settings & Status",
      slash: { name: "suggester", arguments: true },
      run: async (input) => {
        const session = current()
        if (!session) {
          ctx.toast.show({ title: "Prompt suggester", description: "Open a root session first." })
          return
        }
        const action = (input ?? "").trim().toLowerCase()
        const options = { location: session.location, signal: ctx.signal }
        const api = rpc(session)
        const resume = action === "off" || action === "on" || action === "refresh" ? view.pause(routeKey(session)) : () => {}
        try {
          if (action === "on" || action === "off") {
            await api.configure({ sessionID: session.id, enabled: action === "on" }, options)
            ctx.toast.show({ title: "Prompt suggester", description: action === "on" ? "Suggestions enabled." : "Suggestions disabled." })
          } else if (action === "reseed") {
            await api.reseed({ sessionID: session.id }, options)
            ctx.toast.show({ title: "Prompt suggester", description: "Project intent cache cleared. Automatic reseeding follows your configuration." })
          } else if (action === "refresh") {
            await api.refresh({ sessionID: session.id }, options)
          } else {
            const status = await api.status({ sessionID: session.id }, options) as SuggesterStatus
            ctx.toast.show({
              title: "Prompt suggester",
              description: `Enabled: ${status.enabled} | Model: ${status.suggesterModel} | Seed: ${status.seedReady ? "ready" : "none"} | Current: ${status.suggestion || "(none)"}`,
            })
          }
        } catch (error) {
          console.error("[prompt-suggester] command failed", error)
          if (!disposed) ctx.toast.show({ title: "Prompt suggester", description: "Could not update the suggester.", variant: "error" })
        } finally {
          resume()
          if (!disposed) void sync()
        }
      },
    })

    createKeyed(
      () => {
        const session = current()
        return session ? routeKey(session) : undefined
      },
      () => { void sync() },
    )
    const timer = setInterval(() => { void sync() }, 500)
    return () => {
      disposed = true
      clearInterval(timer)
      view.dispose()
    }
  },
})
