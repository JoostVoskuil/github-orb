export interface CarouselSession {
  source: string;
  sessionId: string;
  state: string;
  tool?: string | null;
  activity?: string;
  closed?: boolean;
  finished?: boolean;
  endedAgoSec?: number;
  backgroundOnly?: boolean;
  attention?: { id: string };
}

export interface AvatarPose { x: number; y: number; size: number }
export const CAROUSEL_DWELL_MS = 4000;
export const CAROUSEL_MANUAL_MS = 6000;
export const CAROUSEL_TRANSITION_MS = 700;
export const sessionKey = (session: Pick<CarouselSession, 'source' | 'sessionId'>) =>
  `${session.source}:${session.sessionId}`;
export const sessionMood = (session: CarouselSession) =>
  session.closed || session.state === 'idle' ? 'done' : session.state;
export const workingSession = (session: CarouselSession) =>
  !session.closed && ['thinking', 'tool', 'needsInput'].includes(session.state);

export function workingSessionState<T extends { sessions?: CarouselSession[]; primary?: number }>(state: T) {
  const original = state.sessions ?? [];
  const hasWork = original.some(workingSession);
  const sessions = original.filter(session => workingSession(session) || (hasWork &&
    (session.state === 'done' || session.finished) && (session.endedAgoSec ?? 0) < 120))
    .map(session => ({ ...session, backgroundOnly: !workingSession(session) }));
  const selected = original[state.primary ?? 0];
  const primary = sessions.findIndex(session => selected && sessionKey(session) === sessionKey(selected) && !session.backgroundOnly);
  return { ...state, sessions, primary: primary >= 0 ? primary : Math.max(0, sessions.findIndex(session => !session.backgroundOnly)) };
}
const urgency = (session: CarouselSession) => session.closed ? 0
  : session.state === 'needsInput' ? 2 : session.state === 'error' ? 1 : 0;
const signature = (session: CarouselSession) =>
  JSON.stringify([sessionMood(session), session.tool, session.activity, !!session.closed, session.attention?.id]);

export class SessionCarousel {
  selectedKey: string | null = null;
  private seen = new Map<string, string>();
  private pending: string[] = [];
  private sessions: CarouselSession[] = [];
  private selectedAt = 0;
  private manualAt: number | null = null;
  private movedAt = -CAROUSEL_TRANSITION_MS;
  private from: AvatarPose[] = [];

  update(sessions: CarouselSession[], primary: number, now: number, suspended = false) {
    const keys = sessions.map(sessionKey);
    const membershipChanged = keys.join('\0') !== this.sessions.map(sessionKey).join('\0');
    const initialized = this.sessions.length > 0;
    const foreground = sessions.filter(session => !session.backgroundOnly);
    const selectableKeys = foreground.map(sessionKey);
    this.pending = this.pending.filter(key => selectableKeys.includes(key));
    // Remember changed, non-selected sessions so brief updates are not missed between dwell periods.
    for (const session of sessions) {
      const key = sessionKey(session), next = signature(session);
      if (!session.backgroundOnly && initialized && this.seen.get(key) !== next && key !== this.selectedKey && !this.pending.includes(key)) {
        this.pending.push(key);
      }
    }
    this.seen = new Map(sessions.map(session => [sessionKey(session), signature(session)]));
    this.sessions = sessions;
    if (!keys.includes(this.selectedKey)) {
      this.selectedKey = keys[primary] ?? keys[0] ?? null;
      this.selectedAt = now;
      this.manualAt = null;
    }
    if (membershipChanged) {
      this.from = sessions.map((_, index) => this.target(index));
      this.movedAt = now - CAROUSEL_TRANSITION_MS;
    }
    if (!selectableKeys.includes(this.selectedKey)) {
      const preferred = sessions[primary];
      const replacement = preferred && !preferred.backgroundOnly ? preferred : foreground[0];
      if (replacement) this.select(sessionKey(replacement), now);
      else this.selectedKey = null;
      this.manualAt = null;
    }
    this.pending = this.pending.filter(key => key !== this.selectedKey);
    if (suspended || (this.manualAt !== null && now - this.manualAt < CAROUSEL_MANUAL_MS)) return;
    const current = sessions.find(session => sessionKey(session) === this.selectedKey);
    const urgent = [...foreground].sort((a, b) => urgency(b) - urgency(a))[0];
    // Needs-input and error states preempt the regular rotation; less urgent updates wait their turn.
    if (urgent && urgency(urgent)) {
      if (!current || urgency(urgent) > urgency(current)) this.select(sessionKey(urgent), now);
      return;
    }
    if (now - this.selectedAt >= CAROUSEL_DWELL_MS && this.pending.length) this.select(this.pending[0], now);
  }

  select(key: string, now: number, manual = false) {
    if (!this.sessions.some(session => sessionKey(session) === key && !session.backgroundOnly)) return;
    if (manual) this.manualAt = now;
    if (key !== this.selectedKey) {
      this.from = this.sessions.map((_, index) => this.pose(index, now));
      this.selectedKey = key;
      this.selectedAt = this.movedAt = now;
    }
    this.pending = this.pending.filter(pending => pending !== key);
  }

  private target(index: number): AvatarPose {
    if (this.sessions.length < 2) return { x: 240, y: 246, size: 320 };
    const front = this.sessions.findIndex(session => sessionKey(session) === this.selectedKey);
    const role = (index - front + this.sessions.length) % this.sessions.length;
    return role === 0 ? { x: 240, y: 246, size: 256 }
      : { x: role === 1 ? 394 : 86, y: 258, size: 112 };
  }

  pose(index: number, now: number): AvatarPose {
    const target = this.target(index), from = this.from[index] ?? target;
    const t = Math.max(0, Math.min(1, (now - this.movedAt) / CAROUSEL_TRANSITION_MS));
    const weight = t * t * (3 - 2 * t);
    return { x: from.x + (target.x - from.x) * weight, y: from.y + (target.y - from.y) * weight,
      size: from.size + (target.size - from.size) * weight };
  }

  hit(x: number, y: number, now: number): number {
    return this.sessions.map((_, index) => ({ index, pose: this.pose(index, now) }))
      .sort((a, b) => b.pose.size - a.pose.size)
      .find(({ pose }) => Math.abs(x - pose.x) <= pose.size / 2 && Math.abs(y - pose.y) <= pose.size / 2)?.index ?? -1;
  }
}
