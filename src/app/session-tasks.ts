import { randomUUID } from "node:crypto"

/** Serialise state mutations without holding up events while a model is running. */
export class SessionTasks {
  private readonly generations = new Map<string, AbortController>()
  private readonly versions = new Map<string, number>()
  private readonly instance = randomUUID()
  private readonly writes = new Map<string, Promise<unknown>>()
  private closed = false

  cancel(sessionID: string): void {
    this.versions.set(sessionID, (this.versions.get(sessionID) ?? 0) + 1)
    this.generations.get(sessionID)?.abort()
    this.generations.delete(sessionID)
  }

  revision(sessionID: string): string {
    return this.instance + ":" + (this.versions.get(sessionID) ?? 0)
  }

  cancelAll(): void {
    for (const sessionID of this.generations.keys()) this.cancel(sessionID)
  }

  mutate<T>(sessionID: string, write: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new DOMException("Plugin unloaded", "AbortError"))
    const previous = this.writes.get(sessionID) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => {
      if (this.closed) throw new DOMException("Plugin unloaded", "AbortError")
      return write()
    })
    this.writes.set(sessionID, next)
    void next.finally(() => {
      if (this.writes.get(sessionID) === next) this.writes.delete(sessionID)
    }).catch(() => {})
    return next
  }

  run(
    sessionID: string,
    generate: (input: {
      signal: AbortSignal
      commit: (write: () => Promise<void>) => Promise<void>
    }) => Promise<void>,
  ): Promise<void> {
    this.cancel(sessionID)
    if (this.closed) return Promise.resolve()
    const controller = new AbortController()
    this.generations.set(sessionID, controller)
    const commit = (write: () => Promise<void>) => this.mutate(sessionID, async () => {
      if (!this.closed && !controller.signal.aborted) await write()
    })
    // Read the next turn's state after earlier admitted prompt mutations finish.
    const ready = this.writes.get(sessionID) ?? Promise.resolve()
    return ready.catch(() => {})
      .then(() => {
        if (!controller.signal.aborted) return generate({ signal: controller.signal, commit })
      })
    // Retain the signal until invalidation: the engine may have started a
    // background reseed which outlives the suggestion's model call.
  }

  async dispose(): Promise<void> {
    this.closed = true
    this.cancelAll()
    // A provider may ignore cancellation. Late commits remain disabled; unload
    // only waits for filesystem operations already admitted to the write queue.
    await Promise.allSettled(this.writes.values())
  }
}
