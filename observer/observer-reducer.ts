import { randomBytes } from "node:crypto"
import {
  ATTENTION_PREVIEW_MAX,
  ATTENTION_REASON_MAX,
  DISPLAY_ONLY_ATTENTION,
  validPermissionCommand,
  type AttentionKind,
  type CopilotActivity,
  type CopilotState,
  type ObserverAttention,
} from "./observer-protocol.js"

export interface LifecycleEvent {
  type: string
  id?: string
  agentId?: string
  data?: Record<string, unknown>
}

export interface ObserverState {
  state: CopilotState
  tool: string | null
  activity?: CopilotActivity
  // Selected custom agent for the session (not a running subagent).
  agent?: string
  subagent?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  contextPercent?: number
  // Host epoch milliseconds when the current request started; the sender converts it to a relative duration.
  busySince?: number
  attention?: ObserverAttention
}

export interface ObserverReducerOptions {
  now?: () => number
  nonce?: () => string
  permissionDecisions?: boolean
}

interface PendingRequest {
  agent: string
  permission: boolean
  addedAt: number
  toolId?: string
  localId: string
  kind: AttentionKind
  reason?: string
  preview?: string
  command?: string
  actionable?: boolean
}

function id(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function activityFromIntent(value: unknown): CopilotActivity {
  const intent = typeof value === "string" ? value : ""
  if (/\bevaluat(?:e|es|ed|ing|ion|ions)\b/i.test(intent)) return "evaluating"
  if (/\banaly[sz](?:e|es|ed|ing)\b|\banalys(?:is|es)\b/i.test(intent)) return "analysing"
  return "thinking"
}

export function metadataLabel(value: string, bytes: number): string {
  let result = ""
  for (const char of value.replace(/[\u0000-\u001f\u007f]/g, " ").trim()) {
    if (new TextEncoder().encode(result + char).length > bytes) break
    result += char
  }
  return result
}

function text(value: unknown, bytes: number): string | undefined {
  if (typeof value !== "string") return undefined
  const label = metadataLabel(value.replace(/\s+/gu, " "), bytes)
  return label || undefined
}

function basename(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  return text(
    value
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .pop(),
    ATTENTION_PREVIEW_MAX,
  )
}

function firstLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  return text(value.split(/\r?\n/u).find((line) => line.trim()) ?? "", ATTENTION_PREVIEW_MAX)
}

function urlHost(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  try {
    return text(new URL(value).host, ATTENTION_PREVIEW_MAX)
  } catch {
    return undefined
  }
}

// Reduces a permission request to an allowlisted kind, the model's stated intention and a short preview.
function permissionSummary(data: Record<string, unknown>, decisions = false): Pick<PendingRequest, "kind" | "reason" | "preview" | "command" | "actionable"> {
  const request = record(data.promptRequest) ?? record(data.permissionRequest) ?? {}
  const reason = text(request.intention, ATTENTION_REASON_MAX)
  switch (request.kind) {
    case "shell":
    case "commands":
      return { kind: "shell", reason, preview: firstLine(request.fullCommandText),
        ...(decisions && validPermissionCommand(request.fullCommandText)
          ? { command: request.fullCommandText, actionable: true } : {}) }
    case "write":
      return { kind: "write", reason, preview: basename(request.fileName) }
    case "read":
      return { kind: "read", reason, preview: basename(request.path) }
    case "path": {
      const paths = Array.isArray(request.paths) ? request.paths : []
      return { kind: request.accessKind === "write" ? "write" : "read", reason, preview: basename(paths[0]) }
    }
    case "url":
      return { kind: "url", reason, preview: urlHost(request.url) }
    case "mcp": {
      const server = id(request.serverName) ?? "mcp"
      const tool = id(request.toolTitle) ?? id(request.toolName) ?? "tool"
      return { kind: "mcp", reason, preview: text(`${server}/${tool}`, ATTENTION_PREVIEW_MAX) }
    }
    case "memory":
      return { kind: "memory", reason, preview: text(request.subject, ATTENTION_PREVIEW_MAX) }
    case "custom-tool":
      return { kind: "custom-tool", reason: text(request.toolDescription, ATTENTION_REASON_MAX), preview: text(request.toolName, ATTENTION_PREVIEW_MAX) }
    default:
      return { kind: "other", reason }
  }
}

// Canonical ordering makes the reviewed structured request stable across SDK events and polls.
function canonicalRequest(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, (_key, item: unknown) => {
      const object = record(item)
      return object ? Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]])) : item
    }, 2)
  } catch {
    return undefined
  }
}

export function permissionAttention(data: Record<string, unknown>, decisions = false): Pick<PendingRequest, "kind" | "reason" | "preview" | "command" | "actionable"> {
  const details = permissionSummary(data, decisions)
  if (!decisions || details.kind === "shell" || details.kind === "other") return details
  // A basename/host/tool label is not enough to consent: include every permission field,
  // including full paths, URLs and arguments. Oversized requests remain computer-only.
  const command = canonicalRequest(record(data.promptRequest) ?? record(data.permissionRequest))
  return validPermissionCommand(command) ? { ...details, command, actionable: true } : details
}

export class ObserverReducer {
  private tools = new Map<string, { agent: string; name: string }>()
  private requests = new Map<string, PendingRequest>()
  private children = new Map<string, string>()
  private agentNames = new Map<string, string>()
  private seen = new Set<string>()
  private settled = new Set<string>()
  private customAgent = ""
  private sessionModel = ""
  private childModel = ""
  private inputTokens = 0
  private outputTokens = 0
  private usageSeen = false
  private contextPercent: number | undefined
  private busySince: number | undefined
  private active = false
  private activity: CopilotActivity = "thinking"
  private cancelled = false
  private failed = false
  private completed = false
  private known = false
  private readonly now: () => number
  private readonly nonce: () => string
  private readonly permissionDecisions: boolean
  ended = false

  constructor(options: ObserverReducerOptions = {}) {
    this.now = options.now ?? Date.now
    this.nonce = options.nonce ?? (() => randomBytes(8).toString("hex"))
    this.permissionDecisions = options.permissionDecisions ?? false
  }

  private remember(set: Set<string>, key: string): void {
    set.add(key)
    if (set.size > 4096) {
      const oldest = set.values().next().value
      if (oldest !== undefined) set.delete(oldest)
    }
  }

  private isTokenCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  }

  private addTokens(total: number, value: unknown): number {
    if (!this.isTokenCount(value)) return total
    return value > 0xffffffff - total ? 0xffffffff : total + value
  }

  private request(
    requestId: string | undefined,
    agent: string,
    toolId: string | undefined,
    details: Pick<PendingRequest, "kind" | "reason" | "preview" | "command" | "actionable">,
    permission = false,
  ): void {
    if (!requestId || this.settled.has(`request:${requestId}`) || this.requests.has(requestId)) return
    const displayOnly = DISPLAY_ONLY_ATTENTION.includes(details.kind)
    this.requests.set(requestId, {
      agent,
      permission,
      addedAt: this.now(),
      toolId,
      localId: this.nonce(),
      kind: details.kind,
      ...(displayOnly ? {} : { reason: details.reason, preview: details.preview, command: details.command,
        actionable: permission ? details.actionable : undefined }),
    })
    this.known = true
  }

  /** True while pending permission prompts may exist and should be polled from the host. */
  wantsPermissionPoll(): boolean {
    if (!this.known || this.ended) return false
    if (this.active || this.tools.size > 0 || this.children.size > 0) return true
    for (const request of this.requests.values()) if (request.permission) return true
    return false
  }

  /** Resolve only the displayed actionable nonce; SDK request IDs never leave this process. */
  permissionRequestId(localId: string): string | undefined {
    const first = this.requests.entries().next().value
    if (!first) return undefined
    const [requestId, request] = first
    return request.permission && request.actionable && request.localId === localId ? requestId : undefined
  }

  matchesPermission(localId: string, value: unknown): boolean {
    const requestId = this.permissionRequestId(localId)
    if (!requestId) return false
    const current = this.requests.get(requestId)!
    const details = permissionAttention({ promptRequest: value }, this.permissionDecisions)
    // Do not apply a reviewed decision if a host unexpectedly changes a request in place.
    return current.kind === details.kind && current.reason === details.reason &&
      current.preview === details.preview && current.command === details.command
  }

  /**
   * Reconciles permission prompts with the host's pending list. Some hosts do not deliver
   * permission events to extensions, so polling is the authoritative source.
   */
  syncPermissions(items: ReadonlyArray<{ requestId: string; request: unknown }>): ObserverState | null {
    const pending = new Set<string>()
    for (const item of items) {
      pending.add(item.requestId)
      const request = record(item.request)
      const details = permissionAttention({ promptRequest: request }, this.permissionDecisions)
      const previous = this.requests.get(item.requestId)
      // Changed review content requires a fresh nonce and a new human decision.
      if (previous?.permission && (previous.kind !== details.kind || previous.reason !== details.reason ||
        previous.preview !== details.preview || previous.command !== details.command)) this.requests.delete(item.requestId)
      this.request(item.requestId, previous?.agent ?? "", id(request?.toolCallId), details, true)
    }
    // A brief grace period avoids racing an event that arrived before the host's history caught up.
    const now = this.now()
    for (const [requestId, request] of this.requests) {
      if (request.permission && !pending.has(requestId) && now - request.addedAt >= 1500) this.requests.delete(requestId)
    }
    const busy = this.active || this.tools.size > 0 || this.children.size > 0 || this.requests.size > 0
    if (!busy) this.busySince = undefined
    else if (this.busySince === undefined) this.busySince = now
    return this.current()
  }

  accept(event: LifecycleEvent): ObserverState | null {
    if (event.id) {
      if (this.seen.has(event.id)) return this.current()
      this.remember(this.seen, event.id)
    }
    const d = event.data ?? {}
    const agent = event.agentId ?? ""
    const toolId = id(d.toolCallId)
    const requestId = id(d.requestId)
    switch (event.type) {
      case "user.message":
        if (agent) break
        this.cancelled = false
        this.failed = false
        this.completed = false
        this.active = true
        this.activity = "thinking"
        this.known = true
        break
      case "assistant.turn_start":
        this.active = true
        this.activity = "thinking"
        this.known = true
        this.completed = false
        break
      case "assistant.intent":
        if (!agent) {
          this.active = true
          this.known = true
          this.completed = false
          this.activity = activityFromIntent(d.intent)
        }
        break
      case "tool.execution_start":
        if (toolId && !this.settled.has(`tool:${toolId}`)) {
          this.tools.set(toolId, { agent, name: metadataLabel(id(d.toolName) ?? "tool", 63) })
          this.known = this.active = true
          this.completed = false
          this.activity = "thinking"
        }
        break
      case "tool.execution_complete":
        if (toolId) {
          this.tools.delete(toolId)
          this.remember(this.settled, `tool:${toolId}`)
        }
        break
      case "permission.requested":
        const permission = record(d.promptRequest) ?? record(d.permissionRequest)
        this.request(requestId, agent, toolId ?? id(permission?.toolCallId), permissionAttention(d, this.permissionDecisions), true)
        break
      case "user_input.requested":
      case "elicitation.requested":
        this.request(requestId, agent, toolId, { kind: "question" })
        break
      case "exit_plan_mode.requested":
        this.request(requestId, agent, toolId, { kind: "plan" })
        break
      case "session_limits_exhausted.requested":
        this.request(requestId, agent, toolId, { kind: "limits" })
        break
      case "permission.completed":
      case "user_input.completed":
      case "elicitation.completed":
      case "exit_plan_mode.completed":
      case "session_limits_exhausted.completed":
        if (requestId) {
          this.requests.delete(requestId)
          this.remember(this.settled, `request:${requestId}`)
        }
        break
      case "subagent.selected":
        if (!agent) this.customAgent = metadataLabel(id(d.agentDisplayName) ?? id(d.agentName) ?? "", 24)
        break
      case "subagent.deselected":
        if (!agent) this.customAgent = ""
        break
      case "subagent.started":
        if (toolId && !this.settled.has(`child:${toolId}`)) {
          this.children.set(toolId, agent)
          if (agent) {
            const name = metadataLabel(id(d.agentDisplayName) ?? id(d.agentName) ?? "", 24)
            if (name) this.agentNames.set(agent, name)
          }
          this.known = this.active = true
          this.completed = false
        }
        break
      case "subagent.completed":
      case "subagent.failed":
        if (toolId) {
          const child = this.children.get(toolId) || agent
          this.children.delete(toolId)
          this.remember(this.settled, `child:${toolId}`)
          if (child) {
            this.agentNames.delete(child)
            for (const [key, tool] of this.tools) {
              if (tool.agent === child) this.tools.delete(key)
            }
            for (const [key, request] of this.requests) {
              if (request.agent === child) this.requests.delete(key)
            }
          }
        }
        break
      case "assistant.usage": {
        const model = metadataLabel(id(d.modelDisplayName) ?? id(d.model) ?? "", 32)
        if (model) {
          if (agent) this.childModel = model
          else this.sessionModel = model
        }
        this.inputTokens = this.addTokens(this.inputTokens, d.inputTokens)
        this.outputTokens = this.addTokens(this.outputTokens, d.outputTokens)
        this.usageSeen ||= this.isTokenCount(d.inputTokens) || this.isTokenCount(d.outputTokens)
        this.known = this.active = true
        this.completed = false
        break
      }
      case "session.usage_info":
        if (!agent && typeof d.tokenLimit === "number" && d.tokenLimit > 0 && typeof d.currentTokens === "number" && Number.isFinite(d.currentTokens)) {
          this.contextPercent = Math.max(0, Math.min(100, Math.round((d.currentTokens / d.tokenLimit) * 100)))
        }
        break
      case "session.model_change": {
        const model = metadataLabel(id(d.newModel) ?? "", 32)
        if (model && !agent) this.sessionModel = model
        break
      }
      case "session.error":
        if (!agent) {
          this.known = true
          this.failed = true
          this.completed = false
        }
        break
      case "abort":
        if (!agent) {
          this.cancelled = true
          this.completed = false
          this.requests.clear()
        }
        break
      case "session.idle":
        if (!agent) {
          if (this.requests.size && !this.cancelled && d.aborted !== true) break
          this.completed = this.active && !this.cancelled && !this.failed && d.aborted !== true
          this.active = false
          this.known = true
          this.tools.clear()
          this.children.clear()
          this.requests.clear()
          this.agentNames.clear()
        }
        break
      case "session.shutdown":
        this.ended = true
        break
    }
    const busy = this.active || this.tools.size > 0 || this.children.size > 0 || this.requests.size > 0
    if (!busy) this.busySince = undefined
    else if (this.busySince === undefined) this.busySince = this.now()
    return this.current()
  }

  current(): ObserverState | null {
    if (!this.known || this.ended) return null
    const runningChild = [...this.children.values()].at(-1)
    const subagent = runningChild ? (this.agentNames.get(runningChild) ?? "Subagent") : ""
    const model = this.sessionModel || this.childModel
    const metadata = {
      ...(this.customAgent ? { agent: this.customAgent } : {}),
      ...(subagent ? { subagent } : {}),
      ...(model ? { model } : {}),
      ...(this.usageSeen ? { inputTokens: this.inputTokens, outputTokens: this.outputTokens } : {}),
      ...(this.contextPercent !== undefined ? { contextPercent: this.contextPercent } : {}),
      ...(this.busySince !== undefined ? { busySince: this.busySince } : {}),
    }
    const request = this.requests.values().next().value
    if (request) {
      const attention: ObserverAttention = {
        id: request.localId,
        kind: request.kind,
        ...(request.reason ? { reason: request.reason } : {}),
        ...(request.preview ? { preview: request.preview } : {}),
        ...(request.command ? { command: request.command } : {}),
        ...(request.actionable ? { actionable: true } : {}),
        pending: Math.min(255, this.requests.size),
      }
      return { state: "needsInput", tool: null, ...metadata, attention }
    }
    if (this.failed) return { state: "error", tool: null, ...metadata }
    const tool = this.tools.values().next().value
    if (tool) return { state: "tool", tool: tool.name, ...metadata }
    if (this.children.size || this.active) return { state: "thinking", tool: null, activity: this.activity, ...metadata }
    return { state: this.completed ? "done" : "idle", tool: null, ...metadata }
  }
}
