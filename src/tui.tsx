/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, Show } from "solid-js"
import { PromptSuggester, type SuggesterStatus } from "./rpc.ts"
import { acceptTuiSuggestion, createTuiClient, type TuiPrompt, type TuiSnapshot, type TuiTarget } from "./tui-client.ts"

export default Plugin.define({
  id: "opencode-prompt-suggester",
  setup(context) {
    const [ghost, setGhost] = createSignal<TuiSnapshot>()
    const prompt = (context.ui as typeof context.ui & { prompt?: TuiPrompt }).prompt
    const rpc = context.client.rpc(PromptSuggester)
    const controller = new AbortController()

    function current(): TuiTarget | undefined {
      const route = context.ui.router.current()
      if (route.type !== "session") return
      const session = context.data.session.get(route.sessionID)
      if (!session || session.parentID) return
      return { sessionID: route.sessionID, location: { ...session.location } }
    }

    const client = createTuiClient({
      current: () => {
        const target = current()
        return target && context.data.session.status(target.sessionID) !== "running" ? target : undefined
      },
      read: async (target, signal) => await rpc.get({ sessionID: target.sessionID }, { location: target.location, signal }) as TuiSnapshot,
      changed: setGhost,
    })

    async function clear(target: TuiTarget, revision?: string) {
      const resume = client.suspend(target)
      try {
        await rpc.clear({ sessionID: target.sessionID, ...(revision === undefined ? {} : { revision }) }, { location: target.location, signal: controller.signal })
      } catch {
        if (!controller.signal.aborted) context.ui.toast.show({ message: "Could not dismiss the server suggestion.", variant: "warning" })
      } finally {
        resume()
      }
    }

    function dismiss() {
      const target = current()
      const suggestion = client.visible()
      if (!target || !suggestion || (prompt && !prompt.focused())) return false
      client.dismiss()
      void clear(target, suggestion.revision)
    }

    function accept(submit: boolean) {
      const target = current()
      const suggestion = client.visible()
      if (!target || !suggestion) return false
      if (!prompt) {
        context.ui.toast.show({
          title: "Prompt suggester",
          message: "This OpenCode build needs patches/tui-prompt-api.patch to insert or submit suggestions.",
          variant: "warning",
        })
        return
      }
      if (!acceptTuiSuggestion(suggestion, target, prompt, submit)) return false
      client.dismiss()
    }

    async function command(input?: string) {
      const target = current()
      if (!target) {
        context.ui.toast.show({ message: "Open a root session first.", variant: "info" })
        return
      }
      const options = { location: target.location, signal: controller.signal }
      const action = (input ?? "").trim().toLowerCase()
      const resume = client.suspend(target)
      try {
        if (action === "on" || action === "off") {
          await rpc.configure({ sessionID: target.sessionID, enabled: action === "on" }, options)
          if (controller.signal.aborted) return
          context.ui.toast.show({ message: action === "on" ? "Suggestions enabled." : "Suggestions disabled.", variant: "success" })
        } else if (action === "reseed") {
          await rpc.reseed({ sessionID: target.sessionID }, options)
          if (controller.signal.aborted) return
          context.ui.toast.show({ message: "Project intent cache cleared. Automatic reseeding follows your configuration.", variant: "info" })
        } else if (action === "refresh") {
          await rpc.refresh({ sessionID: target.sessionID }, options)
        } else {
          const status = await rpc.status({ sessionID: target.sessionID }, options) as SuggesterStatus
          if (controller.signal.aborted) return
          context.ui.toast.show({
            title: "Prompt suggester",
            message: `Enabled: ${status.enabled} | Model: ${status.suggesterModel} | Seed: ${status.seedReady ? "ready" : "none"} | Current: ${status.suggestion || "(none)"}`,
            variant: "info",
          })
        }
      } catch {
        if (!controller.signal.aborted) context.ui.toast.show({ message: "Could not contact the prompt suggester.", variant: "error" })
      } finally {
        resume()
      }
    }

    const removeSlot = context.ui.slot({
      append: "session.composer.top",
      render: (input) => (
        <Show when={ghost()?.suggestion && input.sessionID === ghost()?.sessionID}>
          <box flexDirection="row" gap={1} paddingLeft={2} paddingRight={2}>
            <text fg={context.theme.text.faint}>↳</text>
            <text fg={context.theme.text.muted}>{ghost()?.suggestion}</text>
            <text fg={context.theme.text.faint}>{prompt ? "ctrl+alt+n · ctrl+alt+x" : "prompt API patch required"}</text>
          </box>
        </Show>
      ),
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "suggester.command",
        title: "Suggester: Settings & Status",
        palette: true,
        slash: { name: "suggester", arguments: true },
        run: command,
      }],
    }))

    // Use the host's base input mode and check focus again when dispatching a key.
    context.keymap.layer(() => {
      const suggestion = ghost()
      const available = () => Boolean(client.visible()) && (!prompt || prompt.focused())
      const insertable = () => available() && Boolean(prompt?.isEmpty())
      return {
        priority: 100,
        commands: [
          { id: "suggester.accept", title: "Submit suggested next prompt", bind: "ctrl+alt+n", enabled: available, run: () => accept(true) },
          { id: "suggester.dismiss", title: "Dismiss suggested next prompt", bind: "ctrl+alt+x", enabled: available, run: dismiss },
          ...(prompt ? [
            { id: "suggester.insert-space", title: "Insert suggested next prompt", bind: "space", enabled: () => insertable() && Boolean(suggestion?.ghostAcceptKeys.includes("space")), run: () => accept(false) },
            { id: "suggester.insert-right", title: "Insert suggested next prompt", bind: "right", enabled: () => insertable() && Boolean(suggestion?.ghostAcceptKeys.includes("right")), run: () => accept(false) },
            { id: "suggester.dismiss-backspace", title: "Dismiss suggested next prompt", bind: "backspace", enabled: insertable, run: dismiss },
          ] : []),
        ],
      }
    })

    const refresh = () => void client.refresh()
    const offStarted = context.data.on("session.execution.started", (event) => {
      if (event.data.sessionID === current()?.sessionID) client.invalidate()
    })
    const offSucceeded = context.data.on("session.execution.succeeded", refresh)
    const offFailed = context.data.on("session.execution.failed", refresh)
    const offInterrupted = context.data.on("session.execution.interrupted", refresh)
    const timer = setInterval(refresh, 500)
    createEffect(refresh)

    return () => {
      controller.abort()
      clearInterval(timer)
      client.dispose()
      offStarted()
      offSucceeded()
      offFailed()
      offInterrupted()
      removeSlot()
    }
  },
})
