export interface TuiTarget {
  sessionID: string
  location: { directory: string; workspaceID?: string }
}

export interface TuiSnapshot {
  sessionID: string
  suggestion: string
  status: string
  enabled: boolean
  updatedAt: string
  revision?: string
  ghostAcceptKeys: readonly ("space" | "right")[]
}

export interface TuiPrompt {
  isEmpty(): boolean
  focused(): boolean
  set(text: string): boolean
  submit(text: string): boolean
}

export function tuiTargetKey(target: TuiTarget | undefined): string {
  return target ? JSON.stringify([target.sessionID, target.location.directory, target.location.workspaceID]) : ""
}

/** Keeps server snapshots tied to the route that requested them. */
export function createTuiClient(input: {
  current(): TuiTarget | undefined
  read(target: TuiTarget, signal: AbortSignal): Promise<TuiSnapshot>
  changed(snapshot: TuiSnapshot | undefined): void
}) {
  let disposed = false
  let epoch = 0
  let pending: { key: string; abort: AbortController; promise: Promise<void> } | undefined
  let snapshot: TuiSnapshot | undefined
  let snapshotKey = ""
  let dismissed = ""
  const paused = new Map<string, number>()

  function fingerprint(target: TuiTarget, value: TuiSnapshot) {
    return JSON.stringify([tuiTargetKey(target), value.revision ?? value.updatedAt, value.suggestion])
  }

  function hide() {
    snapshot = undefined
    snapshotKey = ""
    input.changed(undefined)
  }

  function invalidate() {
    epoch++
    pending?.abort.abort()
    pending = undefined
    hide()
  }

  async function refresh(): Promise<void> {
    if (disposed) return
    const target = input.current()
    const key = tuiTargetKey(target)
    if (!target || paused.has(key)) {
      invalidate()
      return
    }
    if (pending?.key === key) return pending.promise
    if (snapshotKey && snapshotKey !== key) hide()
    pending?.abort.abort()
    const version = ++epoch
    const abort = new AbortController()
    const promise = (async () => {
      try {
        const result = await input.read(target, abort.signal)
        if (disposed || version !== epoch || tuiTargetKey(input.current()) !== key) return
        if (result.sessionID !== target.sessionID || !result.enabled || result.status !== "ready" || !result.suggestion) {
          hide()
          return
        }
        if (fingerprint(target, result) === dismissed) {
          hide()
          return
        }
        snapshot = result
        snapshotKey = key
        input.changed(result)
      } catch {
        // A failed or disconnected server must never leave an actionable stale suggestion.
        if (!disposed && version === epoch) hide()
      } finally {
        if (pending?.abort === abort) pending = undefined
      }
    })()
    pending = { key, abort, promise }
    return promise
  }

  function visible(): TuiSnapshot | undefined {
    return !disposed && snapshotKey === tuiTargetKey(input.current()) ? snapshot : undefined
  }

  function dismiss() {
    const target = input.current()
    const value = visible()
    if (target && value) dismissed = fingerprint(target, value)
    invalidate()
  }

  /** Prevents snapshots fetched before a mutation from restoring what it cleared. */
  function suspend(target: TuiTarget): () => void {
    const key = tuiTargetKey(target)
    paused.set(key, (paused.get(key) ?? 0) + 1)
    invalidate()
    let resumed = false
    return () => {
      if (resumed) return
      resumed = true
      const remaining = (paused.get(key) ?? 1) - 1
      if (remaining) paused.set(key, remaining)
      else paused.delete(key)
      if (!disposed) void refresh()
    }
  }

  return {
    refresh,
    visible,
    invalidate,
    dismiss,
    suspend,
    dispose() {
      disposed = true
      invalidate()
    },
  }
}

export function acceptTuiSuggestion(
  snapshot: TuiSnapshot | undefined,
  target: TuiTarget | undefined,
  prompt: TuiPrompt | undefined,
  submit: boolean,
): boolean {
  if (!snapshot?.suggestion || !target || snapshot.sessionID !== target.sessionID || !prompt?.focused() || !prompt.isEmpty()) return false
  return submit ? prompt.submit(snapshot.suggestion) : prompt.set(snapshot.suggestion)
}
