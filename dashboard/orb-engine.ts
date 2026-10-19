import {
  validObserverMessage, type CopilotActivity, type ObserverAttention,
  type ObserverMessage
} from '../observer/observer-protocol.js';
import { actionableAttention, attentionSignature, type PermissionDecision } from './permission.js';

export type OrbMood = 'idle' | 'thinking' | 'tool' | 'needsInput' | 'done' | 'error' | 'scared' | 'disconnected' |
  'prAssigned' | 'reviewRequested' | 'workflowFailure' | 'securityAlert';

export interface DashboardSettings {
  sound: boolean;
  volume: number;
  brightness: number;
  quietHours: { enabled: boolean; start: string; end: string };
}

interface Session {
  source: string;
  sessionId: string;
  name: string;
  // 0 = id fallback, 1 = project folder, 2 = first-prompt label, 3 = chat title (always wins, may be renamed).
  nameRank: 0 | 1 | 2 | 3;
  mood: OrbMood;
  tool: string | null;
  stateSince: number;
  lastSeen: number;
  pendingSince: number | null;
  // When the session stopped working or closed; null while busy.
  endedAt: number | null;
  closed: boolean;
  finished: boolean;
  observer?: { instanceId: string; startedAt: number; sequence: number; state: string; tool: string | null;
    activity: CopilotActivity | null; sessionName: string | null; agent?: string; subagent?: string; model?: string;
    inputTokens?: number; outputTokens?: number; contextPercent?: number; busySince?: number;
    attention?: ObserverAttention; ended: boolean; activityAt: number };
}

export interface GithubAlert {
  id: string;
  kind: string;
  title: string;
  url: string;
  repository: string;
  owner?: string;
  organization?: string;
  repositoryName?: string;
}

const EVENT_MOODS: Record<string, OrbMood | 'sessionEnd'> = {
  sessionstart: 'idle',
  userpromptsubmit: 'thinking',
  userpromptsubmitted: 'thinking',
  userprompt: 'thinking',
  pretooluse: 'tool',
  pretool: 'tool',
  posttooluse: 'thinking',
  posttool: 'thinking',
  notification: 'needsInput',
  permissionrequest: 'needsInput',
  needsinput: 'needsInput',
  stop: 'done',
  agentstop: 'done',
  erroroccurred: 'error',
  error: 'error',
  subagentstart: 'thinking',
  subagentstop: 'thinking',
  precompact: 'thinking',
  thinking: 'thinking',
  sessionend: 'sessionEnd'
};

export const SESSION_NAME_MAX = 40;
export const DISPLAY_SLOTS = 3;
export const ENDED_RETENTION_MS = 2 * 60_000;
const DONE_DISPLAY_MS = 10_000;
// Actionable permissions heartbeat every second; other observer states need not heartbeat.
const PERMISSION_FRESHNESS_MS = 10_000;
const BUSY = new Set<OrbMood>(['thinking', 'tool', 'needsInput']);

// Moods are changed only through here so busy/ended bookkeeping stays consistent.
function setMood(session: Session, mood: OrbMood, now: number): void {
  if (BUSY.has(mood)) {
    session.endedAt = null;
    session.finished = false;
  } else if (session.endedAt === null) session.endedAt = now;
  if (mood === 'done') session.finished = true;
  session.mood = mood;
}

function close(session: Session, now: number): void {
  session.closed = true;
  session.endedAt ??= now;
}

const owned = (session: Session | undefined) => !!session?.observer;

function cleanName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SESSION_NAME_MAX);
}

const PRIORITY: Record<string, number> = {
  needsInput: 5, error: 4, tool: 3, thinking: 2, done: 1, idle: 0
};
const activityLabel = (activity: CopilotActivity | null | undefined) =>
  activity === 'evaluating' ? 'Evaluating' : activity === 'analysing' ? 'Analysing' : 'Working';
const IGNORED_APPROVAL_TOOLS = new Set(['runSubagent', 'execution_subagent', 'task']);
const ASK_TOOLS = new Set(['vscode_askQuestions', 'ask_user', 'askQuestions']);
const ALERT_PRESENTATION: Record<string, { mood: OrbMood; clip: string; task: string }> = {
  prAssigned: { mood: 'prAssigned', clip: 'mona-pr', task: 'PR assigned' },
  reviewRequested: { mood: 'reviewRequested', clip: 'mona-pr', task: 'PR needs review' },
  workflowFailure: { mood: 'workflowFailure', clip: 'mona-workflow', task: 'Workflow failed' },
  workflowUpdate: { mood: 'workflowFailure', clip: 'mona-workflow', task: 'Workflow failed' },
  githubNotification: { mood: 'needsInput', clip: 'mona-pr', task: 'GitHub needs attention' },
  securityAlert: { mood: 'securityAlert', clip: 'mona-security', task: 'Security alert' },
  criticalSecurity: { mood: 'securityAlert', clip: 'mona-security', task: 'Security alert' },
  monaIdle: { mood: 'idle', clip: 'mona-idle', task: 'Resting' },
  monaThinking: { mood: 'thinking', clip: 'mona-thinking', task: 'Working' },
  monaTool: { mood: 'tool', clip: 'mona-tool', task: 'Executing' },
  monaDone: { mood: 'done', clip: 'mona-done', task: 'Done' },
  monaScared: { mood: 'scared', clip: 'mona-security', task: 'Scared' },
  monaOffline: { mood: 'disconnected', clip: 'mona-offline', task: 'Offline' }
};

export const DEFAULT_SETTINGS: DashboardSettings = {
  sound: false,
  volume: 0.5,
  brightness: 1,
  quietHours: { enabled: true, start: '22:00', end: '08:00' }
};

function validTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function validateSettings(current: DashboardSettings, input: unknown): DashboardSettings | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const next = input as Record<string, unknown>;
  const result: DashboardSettings = structuredClone(current);
  if ('sound' in next) {
    if (typeof next.sound !== 'boolean') return null;
    result.sound = next.sound;
  }
  if ('volume' in next) {
    if (typeof next.volume !== 'number' || !Number.isFinite(next.volume)) return null;
    result.volume = Math.max(0, Math.min(1, next.volume));
  }
  if ('brightness' in next) {
    if (typeof next.brightness !== 'number' || !Number.isFinite(next.brightness)) return null;
    result.brightness = Math.max(0.05, Math.min(1, next.brightness));
  }
  if ('quietHours' in next) {
    if (!next.quietHours || typeof next.quietHours !== 'object' || Array.isArray(next.quietHours)) return null;
    const quiet = next.quietHours as Record<string, unknown>;
    if ('enabled' in quiet) {
      if (typeof quiet.enabled !== 'boolean') return null;
      result.quietHours.enabled = quiet.enabled;
    }
    if ('start' in quiet) {
      if (!validTime(quiet.start)) return null;
      result.quietHours.start = quiet.start;
    }
    if ('end' in quiet) {
      if (!validTime(quiet.end)) return null;
      result.quietHours.end = quiet.end;
    }
  }
  return result;
}

export class OrbEngine {
  private sessions = new Map<string, Session>();
  private slots: string[] = [];
  private settings: DashboardSettings = structuredClone(DEFAULT_SETTINGS);
  private latestAlert: GithubAlert | null = null;
  private copilotDoneAt: number | null = null;
  private presentationId = 0;
  private previousPresentation = '';
  // At most one decision for each of the 16 bounded sessions. Never extend TTL on retries.
  private decisions = new Map<string, { session: Session; instanceId: string; startedAt: number;
    attention: string; value: PermissionDecision; expiresAt: number }>();

  constructor(private readonly catalog: any) {}

  reset(): void {
    this.sessions.clear();
    this.decisions.clear();
    this.slots = [];
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.latestAlert = null;
    this.copilotDoneAt = null;
    this.presentationId = 0;
    this.previousPresentation = '';
  }

  private evictIfFull(): void {
    if (this.sessions.size < 16) return;
    const oldest = [...this.sessions.entries()].sort((a, b) =>
      Number(!a[1].closed) - Number(!b[1].closed) || a[1].lastSeen - b[1].lastSeen)[0];
    if (oldest) this.sessions.delete(oldest[0]);
  }

  private create(source: string, sessionId: string, now: number): Session {
    this.evictIfFull();
    const session: Session = {
      source, sessionId, name: sessionId.slice(0, 8), nameRank: 0, mood: 'idle', tool: null,
      stateSince: now, lastSeen: now, pendingSince: null, endedAt: now, closed: false, finished: false
    };
    this.sessions.set(`${source}:${sessionId}`, session);
    return session;
  }

  handleEvent(payload: unknown, now = Date.now()): boolean {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const event = payload as Record<string, unknown>;
    if (typeof event.event === 'string' && event.event.startsWith('observer')) {
      return this.handleObserver(payload, now) === null;
    }
    const source = event.source;
    const sessionId = event.sessionId ?? 'default';
    const eventName = typeof event.event === 'string' ? event.event.toLowerCase() : '';
    const mood = EVENT_MOODS[eventName];
    if (typeof source !== 'string' || !['vscode', 'cli', 'sim'].includes(source) || typeof sessionId !== 'string' ||
        !sessionId || sessionId.length > 96 || !mood) return false;

    const key = `${source}:${sessionId}`;
    let session = this.sessions.get(key);
    if (owned(session)) return false;
    if (mood === 'sessionEnd') {
      if (!session || session.closed) return false;
      this.copilotDoneAt = null;
      close(session, now);
      session.lastSeen = now;
      this.assignSlots(now);
      return true;
    }
    this.copilotDoneAt = null;

    if (!session || session.closed) session = this.create(source, sessionId, now);
    const chat = cleanName(event.chat);
    const title = cleanName(event.title);
    const project = cleanName(event.project);
    if (chat) {
      session.name = chat;
      session.nameRank = 3;
    } else if (title && session.nameRank < 2) {
      session.name = title;
      session.nameRank = 2;
    } else if (project && session.nameRank < 1) {
      session.name = project;
      session.nameRank = 1;
    }
    const tool = typeof event.tool === 'string' ? event.tool.slice(0, 63) : null;
    const nextMood: OrbMood = mood === 'tool' && tool && ASK_TOOLS.has(tool) ? 'needsInput' : mood;
    setMood(session, nextMood, now);
    session.tool = nextMood === 'tool' || nextMood === 'needsInput' ? tool : null;
    session.lastSeen = now;
    session.stateSince = now;
    session.pendingSince = mood === 'tool' ? now : null;
    this.assignSlots(now);
    return true;
  }

  handleObserver(payload: unknown, now = Date.now()): string | null {
    if (!validObserverMessage(payload)) return 'invalid_observer_event';
    this.tick(now);
    const p: ObserverMessage = payload;
    const key = `cli:${p.sessionId}`;
    let session = this.sessions.get(key);
    if (owned(session)) {
      const owner = session!.observer!;
      if (p.startedAt < owner.startedAt ||
          (p.startedAt === owner.startedAt && p.instanceId !== owner.instanceId) ||
          (p.instanceId === owner.instanceId && (p.startedAt !== owner.startedAt || p.sequence <= owner.sequence || owner.ended))) return 'observer_conflict';
      if (p.instanceId !== owner.instanceId && p.event !== 'observerState') return 'observer_missing';
    } else if (p.event !== 'observerState') return 'observer_missing';
    if (!session) session = this.create('cli', p.sessionId, now);
    if (p.event === 'observerEnd') {
      session.observer!.ended = true;
      session.observer!.sequence = p.sequence;
      session.lastSeen = now;
      close(session, now);
      this.assignSlots(now);
      this.pruneDecisions(now);
      return null;
    }
    session.lastSeen = now;
    this.copilotDoneAt = null;
    const tool = p.state === 'tool' || p.state === 'needsInput' ? p.tool ?? null : null;
    const previous = session.observer;
    const ownerChanged = previous !== undefined && p.instanceId !== previous.instanceId;
    const activity = p.state === 'thinking' ? p.activity ?? 'thinking' : null;
    const sessionName = p.sessionName ?? null;
    const priorMetadata = ownerChanged ? undefined : previous;
    const agent = p.agent ?? priorMetadata?.agent;
    const model = p.model ?? priorMetadata?.model;
    const inputTokens = p.inputTokens ?? priorMetadata?.inputTokens;
    const outputTokens = p.outputTokens ?? priorMetadata?.outputTokens;
    const contextPercent = p.contextPercent ?? priorMetadata?.contextPercent;
    const attention = p.state === 'needsInput' ? p.attention : undefined;
    const revived = session.closed;
    const changed = !previous || previous.ended || revived || previous.state !== p.state ||
      previous.tool !== tool || previous.activity !== activity || previous.sessionName !== sessionName ||
      previous.attention?.id !== attention?.id;
    session.observer = { instanceId: p.instanceId, startedAt: p.startedAt, sequence: p.sequence,
      state: p.state!, tool, activity, sessionName,
      ...(agent ? { agent } : {}), ...(p.subagent ? { subagent: p.subagent } : {}), ...(model ? { model } : {}),
      ...(inputTokens !== undefined && outputTokens !== undefined ? { inputTokens, outputTokens } : {}),
      ...(contextPercent !== undefined ? { contextPercent } : {}),
      ...(p.busyForMs !== undefined ? { busySince: now - p.busyForMs } : {}),
      ...(attention ? { attention: { ...attention } } : {}),
      ended: false, activityAt: changed ? now : previous!.activityAt };
    session.closed = false;
    if (p.project) {
      if (session.nameRank < 1) {
        session.name = cleanName(p.project);
        session.nameRank = 1;
      }
    }
    if (p.sessionName) {
      session.name = cleanName(p.sessionName);
      session.nameRank = 3;
    }
    if (changed) {
      if (revived) session.endedAt = null;
      setMood(session, p.state!, now);
      session.tool = tool;
      session.pendingSince = null;
      session.stateSince = now;
    }
    this.assignSlots(now);
    this.pruneDecisions(now);
    return null;
  }

  queuePermissionDecision(sessionId: string, attentionId: string, decision: 'approve' | 'deny', now = Date.now()): boolean {
    this.tick(now);
    const session = this.sessions.get(`cli:${sessionId}`);
    const owner = session?.observer;
    if (!session || session.closed || owner?.ended || owner?.state !== 'needsInput' ||
      now - session.lastSeen > PERMISSION_FRESHNESS_MS ||
        !actionableAttention(owner.attention) || owner.attention?.id !== attentionId ||
        (decision !== 'approve' && decision !== 'deny')) return false;
    const queued = this.decisions.get(sessionId);
    if (queued) return queued.value.decision === decision;
    this.decisions.set(sessionId, { session, instanceId: owner.instanceId, startedAt: owner.startedAt,
      attention: attentionSignature(owner.attention), value: { attentionId, decision }, expiresAt: now + 30_000 });
    return true;
  }

  pendingPermissionDecision(payload: unknown, now = Date.now()): PermissionDecision | undefined {
    this.tick(now);
    if (!validObserverMessage(payload) || payload.event !== 'observerState') return;
    const queued = this.decisions.get(payload.sessionId);
    if (!queued || payload.instanceId !== queued.instanceId || payload.startedAt !== queued.startedAt ||
        payload.sequence !== queued.session.observer?.sequence) return;
    return { ...queued.value };
  }

  private pruneDecisions(now: number): void {
    for (const [id, queued] of this.decisions) {
      const session = this.sessions.get(`cli:${id}`), owner = session?.observer;
      if (now >= queued.expiresAt || session !== queued.session || session.closed || !owner || owner.ended ||
          now - session.lastSeen > PERMISSION_FRESHNESS_MS ||
          owner.instanceId !== queued.instanceId || owner.startedAt !== queued.startedAt ||
          owner.state !== 'needsInput' || !actionableAttention(owner.attention) ||
          attentionSignature(owner.attention) !== queued.attention) this.decisions.delete(id);
    }
  }

  tick(now = Date.now()): void {
    if (this.copilotDoneAt !== null && now - this.copilotDoneAt >= DONE_DISPLAY_MS) {
      this.copilotDoneAt = null;
    }
    for (const [key, session] of this.sessions) {
      if (!session.closed && !owned(session) && now - session.lastSeen > 15 * 60_000) {
        close(session, session.lastSeen);
      }
      if (session.closed && session.endedAt !== null && now - session.endedAt >= ENDED_RETENTION_MS) {
        this.sessions.delete(key);
        continue;
      }
      if (session.closed) continue;
      if (!session.observer && session.pendingSince !== null && !IGNORED_APPROVAL_TOOLS.has(session.tool ?? '') &&
          now - session.pendingSince >= 8_000 && session.mood === 'tool') {
        setMood(session, 'needsInput', now);
        session.stateSince = now;
      }
      if ((session.mood === 'done' && now - session.stateSince >= DONE_DISPLAY_MS) ||
          (session.mood === 'error' && now - session.stateSince >= 30_000)) {
        setMood(session, 'idle', now);
        session.tool = null;
        session.pendingSince = null;
      }
    }
    this.assignSlots(now);
    this.pruneDecisions(now);
  }

  private visible(session: Session, now: number): boolean {
    if (owned(session) && session.endedAt === null && !session.closed) return true;
    return now - (session.endedAt ?? session.lastSeen) < ENDED_RETENTION_MS;
  }

  private rank(session: Session): number {
    return session.closed ? -1 : PRIORITY[session.mood] ?? -1;
  }

  private recency(session: Session): number {
    return session.endedAt ?? session.observer?.activityAt ?? session.lastSeen;
  }

  // Sticky display slots: a session keeps its arc until it leaves or a more urgent session needs the space.
  private assignSlots(now: number): void {
    const visible = new Map([...this.sessions].filter(([, session]) => this.visible(session, now)));
    this.slots = this.slots.filter(key => visible.has(key));
    const candidates = [...visible.entries()].filter(([key]) => !this.slots.includes(key))
      .sort((a, b) => this.rank(b[1]) - this.rank(a[1]) || this.recency(b[1]) - this.recency(a[1]));
    for (const [key, session] of candidates) {
      if (this.slots.length < DISPLAY_SLOTS) {
        this.slots.push(key);
        continue;
      }
      let worst = 0;
      for (let i = 1; i < this.slots.length; i++) {
        const a = visible.get(this.slots[i])!;
        const b = visible.get(this.slots[worst])!;
        if (this.rank(a) < this.rank(b) || (this.rank(a) === this.rank(b) && this.recency(a) < this.recency(b))) worst = i;
      }
      if (this.rank(session) > this.rank(visible.get(this.slots[worst])!)) this.slots[worst] = key;
    }
  }

  setSettings(input: unknown): boolean {
    const validated = validateSettings(this.settings, input);
    if (!validated) return false;
    this.settings = validated;
    return true;
  }

  getSettings(): DashboardSettings {
    return structuredClone(this.settings);
  }

  setAlert(alert: GithubAlert | null, now = Date.now()): void {
    if (alert?.kind === 'agentSessionFinished') {
      this.latestAlert = null;
      this.copilotDoneAt = now;
    } else {
      this.latestAlert = alert;
      if (alert) this.copilotDoneAt = null;
    }
  }

  acknowledgeAlert(id: string): boolean {
    if (!id || this.latestAlert?.id !== id) return false;
    this.latestAlert = null;
    return true;
  }

  state(now = Date.now()) {
    this.tick(now);
    const displayed = this.slots.map(key => this.sessions.get(key)!).filter(Boolean);
    const live = [...this.sessions.values()].filter(session => !session.closed);
    const byPriority = (a: Session, b: Session) => this.rank(b) - this.rank(a) ||
      (b.observer?.activityAt ?? b.lastSeen) - (a.observer?.activityAt ?? a.lastSeen);
    const selected = [...displayed].sort(byPriority)[0];
    const alert = this.latestAlert;
    const alertPresentation = alert ? ALERT_PRESENTATION[alert.kind] : undefined;
    const copilotDone = this.copilotDoneAt !== null;
    const mascot = alertPresentation ? 'mona' : 'copilot';
    const mood = copilotDone ? 'done' : alertPresentation?.mood ?? (selected
      ? selected.closed || selected.mood === 'idle' ? 'done' : selected.mood : 'idle');
    const definition = this.catalog?.presentations?.[mascot]?.[mood] ?? {};
    const clip = copilotDone ? 'done' : alertPresentation?.clip ?? definition.animation ?? mood;
    const key = copilotDone ? `${mascot}:${mood}:${clip}:${this.copilotDoneAt}` :
      alertPresentation ? `${mascot}:${mood}:${clip}:${alert?.id}` :
      `${mascot}:${mood}:${clip}:${selected?.tool ?? ''}:${selected?.observer?.activity ?? ''}:${selected?.name ?? ''}`;
    if (key !== this.previousPresentation) {
      this.previousPresentation = key;
      this.presentationId++;
    }
    const ring = definition.ring ?? this.catalog?.presentations?.copilot?.idle?.ring;
    const visibleCount = [...this.sessions.values()].filter(session => this.visible(session, now)).length;
    return {
      type: 'state',
      mood,
      clip,
      task: copilotDone ? 'Done' : alertPresentation?.task ?? (mood === 'thinking'
        ? selected?.observer ? activityLabel(selected.observer.activity) : definition.task ?? 'Working'
        : definition.task ?? (mood === 'tool' ? 'Executing' : mood)),
      ring,
      tool: alert || copilotDone ? null : selected?.tool ?? null,
      source: alert ? 'github' : selected?.source ?? null,
      mascot,
      copilotNotification: copilotDone,
      presentationId: this.presentationId,
      agent: selected?.observer?.agent ?? 'Copilot',
      model: selected?.observer?.model ?? null,
      inputTokens: selected?.observer?.inputTokens ?? 0,
      outputTokens: selected?.observer?.outputTokens ?? 0,
      hasTokenUsage: selected?.observer?.inputTokens !== undefined && selected?.observer?.outputTokens !== undefined,
      sessions: displayed.map((session, slot) => this.sessionView(session, slot, now)),
      primary: selected ? Math.max(0, displayed.indexOf(selected)) : 0,
      hiddenSessions: Math.max(0, visibleCount - displayed.length),
      sessionCount: live.length,
      settings: this.getSettings(),
      alert: alert ? { ...alert } : null,
      ts: now
    };
  }

  private sessionView(session: Session, slot: number, now: number) {
    const { source, sessionId, name, mood, tool, observer } = session;
    const attention = mood === 'needsInput' && !session.closed ? observer?.attention : undefined;
    return {
      source, sessionId, name, state: mood, tool, slot,
      stateSince: session.stateSince,
      ...(mood === 'thinking' ? { activity: activityLabel(observer?.activity) } : {}),
      ended: session.endedAt !== null, closed: session.closed, finished: session.finished,
      ...(session.endedAt !== null ? { endedAgoSec: Math.max(0, Math.floor((now - session.endedAt) / 1000)) } : {}),
      ...(observer?.agent ? { agent: observer.agent } : {}),
      ...(observer ? { observerInstanceId: observer.instanceId, observerStartedAt: observer.startedAt } : {}),
      ...(observer?.subagent && !session.closed ? { subagent: observer.subagent } : {}),
      ...(observer?.model ? { model: observer.model } : {}),
      ...(observer?.inputTokens !== undefined && observer.outputTokens !== undefined
        ? { inputTokens: observer.inputTokens, outputTokens: observer.outputTokens } : {}),
      ...(observer?.contextPercent !== undefined ? { contextPercent: observer.contextPercent } : {}),
      ...(observer?.busySince !== undefined && session.endedAt === null
        ? { busySec: Math.max(0, Math.floor((now - observer.busySince) / 1000)) } : {}),
      ...(attention ? { attention: { ...attention,
        ...(attention.actionable === true && now - session.lastSeen > PERMISSION_FRESHNESS_MS
          ? { actionable: false } : {}) } } : {})
    };
  }
}
