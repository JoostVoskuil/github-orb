import { basename } from "node:path"
import { loadOrbEndpoints } from "./config-store.js"
import { ObserverReducer, metadataLabel, type LifecycleEvent } from "./observer-reducer.js"
import { ObserverSender, httpFanoutDelivery } from "./observer-sender.js"

const PERMISSION_POLL_MS = 1_000

export interface ObserverSession {
  sessionId: string
  on(handler: (event: LifecycleEvent) => void): () => void
  log(message: string, options: { level: "warning" | "info" }): Promise<unknown>
  rpc?: {
    metadata?: {
      snapshot?: () => Promise<{
        workingDirectory?: unknown
        initialName?: unknown
        summary?: unknown
      }>
    }
    permissions?: {
      pendingRequests?: () => Promise<{ items?: unknown }>
    }
  }
}

function pendingItems(value: { items?: unknown } | undefined): Array<{ requestId: string; request: unknown }> {
  const items = Array.isArray(value?.items) ? value.items : []
  return items.flatMap((item) =>
    item && typeof item === "object" && typeof item.requestId === "string" ? [{ requestId: item.requestId as string, request: (item as { request?: unknown }).request }] : [],
  )
}

export async function observeSession(session: ObserverSession): Promise<() => Promise<void>> {
  const reducer = new ObserverReducer()
  let sender: ObserverSender | undefined
  let sessionName = ""
  const unsubscribe = session.on((event) => {
    if (event.type === "session.title_changed" && !event.agentId && typeof event.data?.title === "string") {
      const title = metadataLabel(event.data.title.replace(/\s+/gu, " ").trim(), 40)
      // An empty title must not replace a known one, or the Orb falls back to the project name.
      if (title) {
        sessionName = title
        sender?.setSessionName(sessionName)
      }
    }
    const state = reducer.accept(event)
    if (state) sender?.update(state)
    if (reducer.ended) void stop()
  })
  const warn = (message: string) => {
    void session.log(message, { level: "warning" }).catch(() => {
      process.stderr.write("Orb observer: diagnostic channel unavailable.\n")
    })
  }
  let timer: ReturnType<typeof setInterval> | undefined
  let stopping: Promise<void> | undefined
  function stop(): Promise<void> {
    if (stopping) return stopping
    clearInterval(timer)
    unsubscribe()
    process.removeListener("SIGTERM", onSignal)
    process.removeListener("SIGINT", onSignal)
    stopping = sender?.close() ?? Promise.resolve()
    return stopping
  }
  function onSignal(): void {
    void stop().finally(() => process.exit(0))
  }
  try {
    const endpoints = await loadOrbEndpoints()
    if (!/^[A-Za-z0-9_-]{1,95}$/.test(session.sessionId)) throw new Error("unsupported_session_id")
    const permissions = session.rpc?.permissions
    let project = ""
    try {
      const metadata = await session.rpc?.metadata?.snapshot?.()
      if (typeof metadata?.workingDirectory === "string" && metadata.workingDirectory) {
        project = metadataLabel(basename(metadata.workingDirectory), 40)
      }
      const initialName = [metadata?.summary, metadata?.initialName].find((v) => typeof v === "string" && v.trim())
      if (!sessionName && typeof initialName === "string") {
        sessionName = metadataLabel(initialName.replace(/\s+/gu, " ").trim(), 40)
      }
    } catch {
      warn("Orb observer project label unavailable; using the session ID.")
    }
    // Some hosts do not deliver permission events to extensions, and prompts raised before this
    // extension subscribed are otherwise invisible; the host's pending list is authoritative.
    let polling = false
    let pollingAvailable = typeof permissions?.pendingRequests === "function"
    const pollPermissions = async () => {
      if (!pollingAvailable || polling) return
      polling = true
      try {
        const state = reducer.syncPermissions(pendingItems(await permissions!.pendingRequests!()))
        if (state) sender?.update(state)
      } catch {
        pollingAvailable = false
        warn("Orb observer cannot read pending permission prompts; attention prompts may not appear on the Orb.")
      } finally {
        polling = false
      }
    }
    await pollPermissions()
    sender = new ObserverSender(session.sessionId, project, httpFanoutDelivery(endpoints), warn)
    sender.setSessionName(sessionName)
    if (!reducer.ended) {
      const state = reducer.current()
      if (state) sender.update(state)
      timer = setInterval(() => {
        if (reducer.wantsPermissionPoll()) void pollPermissions()
      }, PERMISSION_POLL_MS)
      process.on("SIGTERM", onSignal)
      process.on("SIGINT", onSignal)
    } else await stop()
    return stop
  } catch {
    await stop()
    warn("Orb observer not started: check Orb connection configuration and session ID.")
    return stop
  }
}
