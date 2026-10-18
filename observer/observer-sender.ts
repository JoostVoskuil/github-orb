import { randomUUID } from "node:crypto"
import type { OrbConnectionConfig } from "./config-store.js"
import type { ObserverMessage } from "./observer-protocol.js"
import type { ObserverState } from "./observer-reducer.js"

export type DeliveryError = "observer_missing" | "observer_conflict"
export interface DeliveryResult {
  error?: DeliveryError
  failures?: number
}
// Legacy test doubles may still resolve to a bare error string or null.
type Delivery = (message: ObserverMessage) => Promise<DeliveryResult | DeliveryError | string | null>

export function httpDelivery(config: OrbConnectionConfig): Delivery {
  return async (message) => {
    const response = await fetch(`http://${config.host}:${config.port}/event`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(1200),
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(message),
    })
    const body: unknown = await response.json()
    if (response.status === 202 && body && typeof body === "object" && "accepted" in body && body.accepted === true) {
      return {}
    }

    if (response.status === 409 && body && typeof body === "object" && "error" in body) {
      if (body.error === "observer_missing" || body.error === "observer_conflict") return { error: body.error }
    }
    throw new Error(`observer_http_${response.status}`)
  }
}

const REQUEST_TIMEOUT_MS = 350

export function httpFanoutDelivery(configs: readonly OrbConnectionConfig[]): Delivery {
  if (!configs.length) throw new Error("invalid_orb_config")
  return async (message) => {
    const results = await Promise.allSettled(configs.map(async (config): Promise<DeliveryResult> => {
      const response = await fetch(`http://${config.host}:${config.port}/event`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Authorization: ["Bearer", config.token].join(" "), "Content-Type": "application/json" },
        body: JSON.stringify(message),
      })
      const body: unknown = await response.json()
      if (response.status === 202 && body && typeof body === "object" && "accepted" in body && body.accepted === true) {
        return {}
      }
      if (response.status === 409 && body && typeof body === "object" && "error" in body) {
        if (body.error === "observer_missing" || body.error === "observer_conflict") return { error: body.error }
      }
      throw new Error(`observer_http_${response.status}`)
    }))
    const failures = results.filter((result) =>
      result.status === "rejected" || (result.status === "fulfilled" && result.value.error !== undefined)
    ).length
    return failures ? { failures } : {}
  }
}

function normalize(result: DeliveryResult | string | null): DeliveryResult {
  if (result === null) return {}
  if (typeof result === "string") {
    return result === "observer_missing" || result === "observer_conflict" ? { error: result } : {}
  }
  return result
}

export class ObserverSender {
  private sequence = 0
  private desired: ObserverState | null = null
  private desiredKey = ""
  private sessionName = ""
  // Coalesce updates to the latest snapshot instead of building a stale delivery backlog.
  private pending: "observerState" | "observerEnd" | null = null
  private draining: Promise<void> | null = null
  private stopped = false
  private closing = false
  private lastWarning = -Infinity
  private readonly instanceId = randomUUID()
  private readonly startedAt = Date.now()

  constructor(
    private sessionId: string,
    private project: string,
    private deliver: Delivery,
    private report: (message: string) => void,
  ) {}

  update(state: ObserverState): void {
    if (this.stopped || this.closing) return
    const key = JSON.stringify(state)
    if (this.desired && key === this.desiredKey) return
    this.desired = structuredClone(state)
    this.desiredKey = key
    this.queueState()
  }

  setSessionName(name: string): void {
    if (this.stopped || this.closing || this.sessionName === name) return
    this.sessionName = name
    if (this.desired) this.queueState()
  }

  private queueState(): void {
    this.pending = this.closing ? "observerEnd" : "observerState"
    this.start()
  }

  async close(): Promise<void> {
    if (this.stopped) return
    this.closing = true
    if (this.desired) this.pending = "observerEnd"
    this.start()
    await this.flush()
    this.stopped = true
  }

  async flush(): Promise<void> {
    while (this.draining) await this.draining
  }

  private start(): void {
    if (this.draining || this.stopped) return
    // Serialize delivery so sequence numbers remain ordered; changes during a send replace pending state.
    this.draining = this.drain().finally(() => {
      this.draining = null
      if (this.pending && !this.stopped) this.start()
    })
  }

  private stateFields(state: ObserverState): Partial<ObserverMessage> {
    const { busySince, ...rest } = state
    const busyForMs = busySince === undefined ? undefined : Math.max(0, Math.min(0xffffffff, Math.round(Date.now() - busySince)))
    return {
      ...rest,
      project: this.project,
      ...(busyForMs !== undefined ? { busyForMs } : {}),
      ...(this.sessionName ? { sessionName: this.sessionName } : {}),
    }
  }

  private async drain(): Promise<void> {
    let failures = 0
    while (this.pending && !this.stopped) {
      const event = this.pending
      this.pending = null
      const state = this.desired
      const message: ObserverMessage = {
        source: "cli",
        observerVersion: 1,
        event,
        sessionId: this.sessionId,
        instanceId: this.instanceId,
        startedAt: this.startedAt,
        sequence: ++this.sequence,
        ...(event === "observerState" && state ? this.stateFields(state) : {}),
      }
      try {
        const { error, failures: endpointFailures = 0 } = normalize(await this.deliver(message))
        if (error === "observer_conflict") {
          this.report("Orb observer replaced by another instance; reload this extension to take ownership.")
          this.stopped = true
        } else if (error === "observer_missing") {
          if (event === "observerState") throw new Error("invalid_observer_response")
        } else {
          failures = 0
          if (endpointFailures && Date.now() - this.lastWarning >= 30_000) {
            this.lastWarning = Date.now()
            this.report(`Orb observer delivery failed for ${endpointFailures} destination(s); check network reachability.`)
          }
        }
      } catch {
        if (Date.now() - this.lastWarning >= 30_000) {
          this.lastWarning = Date.now()
          this.report("Orb observer delivery failed; check configuration, API version and network reachability.")
        }
        if (++failures < 3) {
          this.pending = this.closing ? "observerEnd" : "observerState"
          await new Promise((resolve) => setTimeout(resolve, failures * 200))
        } else {
          this.pending = null
        }
      }
    }
  }
}
