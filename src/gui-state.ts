/** The suggestion snapshot and the request that may replace it belong to one routed session. */
export interface SuggestionViewSnapshot {
  suggestion: string
  status: string
  enabled: boolean
  updatedAt: string
  revision?: string
}

export function createSuggestionView(onChange: (text: string) => void) {
  let key: string | undefined
  let epoch = 0
  let request: AbortController | undefined
  let disposed = false
  const dismissed = new Map<string, string>()
  const pauses = new Map<string, number>()

  function invalidate() {
    epoch++
    request?.abort()
    request = undefined
    onChange("")
  }

  function select(next: string | undefined) {
    if (next === key) return
    key = next
    invalidate()
  }

  return {
    select,
    async sync(next: string, read: (signal: AbortSignal) => Promise<SuggestionViewSnapshot>) {
      select(next)
      if (disposed || pauses.has(next) || request) return
      const version = epoch
      const controller = new AbortController()
      request = controller
      try {
        const value = await read(controller.signal)
        if (disposed || controller.signal.aborted || version !== epoch || key !== next) return
        const ready = value.enabled && value.status === "ready" && value.suggestion
        const revision = value.revision ?? value.updatedAt
        const suppressed = dismissed.get(next)
        if (suppressed !== revision) dismissed.delete(next)
        onChange(ready && suppressed !== revision ? value.suggestion : "")
      } catch {
        if (!disposed && !controller.signal.aborted && version === epoch && key === next) onChange("")
      } finally {
        if (request === controller) request = undefined
      }
    },
    /** A mutation must finish before a newer read may restore a suggestion. */
    pause(next: string) {
      select(next)
      invalidate()
      pauses.set(next, (pauses.get(next) ?? 0) + 1)
      let resumed = false
      return () => {
        if (resumed) return
        resumed = true
        const count = pauses.get(next) ?? 0
        if (count > 1) pauses.set(next, count - 1)
        else pauses.delete(next)
      }
    },
    dismiss(next: string, revision: string) {
      select(next)
      dismissed.set(next, revision)
      invalidate()
    },
    dispose() {
      disposed = true
      invalidate()
      dismissed.clear()
      pauses.clear()
    },
  }
}

export interface SuggestionComposer {
  quotable(): boolean
  text(): string
  focused(): boolean
}

export function canInsertSuggestion(composer: SuggestionComposer | undefined, requireFocus = true): boolean {
  return Boolean(
    composer?.quotable() && !composer.text().trim() && (!requireFocus || composer.focused()),
  )
}
