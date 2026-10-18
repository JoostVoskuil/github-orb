export const COPILOT_STATES = ["idle", "thinking", "tool", "needsInput", "done", "error"] as const
export type CopilotState = (typeof COPILOT_STATES)[number]
export const COPILOT_ACTIVITIES = ["thinking", "evaluating", "analysing"] as const
export type CopilotActivity = (typeof COPILOT_ACTIVITIES)[number]
export const ATTENTION_KINDS = ["shell", "write", "read", "url", "mcp", "memory", "custom-tool", "other", "question", "plan", "limits"] as const
export type AttentionKind = (typeof ATTENTION_KINDS)[number]
// These kinds carry no host text and can only be answered on the computer.
export const DISPLAY_ONLY_ATTENTION: readonly AttentionKind[] = ["question", "plan", "limits"]
export const ATTENTION_REASON_MAX = 80
export const ATTENTION_PREVIEW_MAX = 60
export type ObserverEventName = "observerState" | "observerEnd"

export interface ObserverAttention {
  // Opaque per-request nonce created by the observer; never the SDK request ID.
  id: string
  kind: AttentionKind
  reason?: string
  preview?: string
  pending: number
}

export interface ObserverMessage {
  source: "cli"
  event: ObserverEventName
  observerVersion: 1
  sessionId: string
  instanceId: string
  startedAt: number
  sequence: number
  state?: CopilotState
  activity?: CopilotActivity
  sessionName?: string
  agent?: string
  subagent?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  contextPercent?: number
  busyForMs?: number
  attention?: ObserverAttention
  tool?: string | null
  project?: string
}

export function observerEvent(value: unknown): boolean {
  return value === "observerState" || value === "observerEnd"
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && new TextEncoder().encode(value).length <= max && !/[\u0000-\u001f\u007f]/.test(value)
}

function uint(value: unknown, max: number): boolean {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= max
}

export function validAttentionId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{16}$/.test(value)
}

export function validAttention(value: unknown): value is ObserverAttention {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const a = value as Record<string, unknown>
  const allowed = new Set(["id", "kind", "reason", "preview", "pending"])
  if (Object.keys(a).some((key) => !allowed.has(key))) return false
  const displayOnly = DISPLAY_ONLY_ATTENTION.includes(a.kind as AttentionKind)
  return (
    validAttentionId(a.id) &&
    ATTENTION_KINDS.includes(a.kind as AttentionKind) &&
    Number.isInteger(a.pending) &&
    Number(a.pending) >= 1 &&
    Number(a.pending) <= 255 &&
    (a.reason === undefined || (!displayOnly && bounded(a.reason, ATTENTION_REASON_MAX))) &&
    (a.preview === undefined || (!displayOnly && bounded(a.preview, ATTENTION_PREVIEW_MAX)))
  )
}

export function validObserverMessage(input: unknown): input is ObserverMessage {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const p = input as Record<string, unknown>
  const update = p.event === "observerState"
  return (
    p.source === "cli" &&
    p.observerVersion === 1 &&
    ["observerState", "observerEnd"].includes(String(p.event)) &&
    typeof p.sessionId === "string" &&
    /^[A-Za-z0-9_-]{1,95}$/.test(p.sessionId) &&
    typeof p.instanceId === "string" &&
    /^[0-9a-f-]{36}$/.test(p.instanceId) &&
    Number.isSafeInteger(p.startedAt) &&
    Number(p.startedAt) > 0 &&
    Number.isInteger(p.sequence) &&
    Number(p.sequence) > 0 &&
    Number(p.sequence) <= 0xffffffff &&
    (!update || COPILOT_STATES.includes(p.state as CopilotState)) &&
    (p.activity === undefined || (update && p.state === "thinking" && COPILOT_ACTIVITIES.includes(p.activity as CopilotActivity))) &&
    (p.sessionName === undefined || (update && bounded(p.sessionName, 40))) &&
    (p.agent === undefined || (update && bounded(p.agent, 24))) &&
    (p.subagent === undefined || (update && bounded(p.subagent, 24))) &&
    (p.model === undefined || (update && bounded(p.model, 32))) &&
    ((p.inputTokens === undefined && p.outputTokens === undefined) || (update && uint(p.inputTokens, 0xffffffff) && uint(p.outputTokens, 0xffffffff))) &&
    (p.contextPercent === undefined || (update && uint(p.contextPercent, 100))) &&
    (p.busyForMs === undefined || (update && uint(p.busyForMs, 0xffffffff))) &&
    (p.attention === undefined || (update && p.state === "needsInput" && validAttention(p.attention))) &&
    (p.tool === undefined || p.tool === null || bounded(p.tool, 63)) &&
    (p.project === undefined || bounded(p.project, 40))
  )
}
