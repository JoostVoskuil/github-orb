import { presentation, presentationChanged, alertLabel } from './presentation.js';
import { SessionCarousel, sessionKey, sessionMood, workingSessionState } from './session-carousel.js';

const SIZE = 480;
const C = SIZE / 2;
const SOURCE_LABEL = { vscode: 'VS Code', cli: 'CLI', sim: 'Dashboard' };
const CONFETTI = ['#a371f7', '#2dd4bf', '#3fb950', '#f0a020', '#2f81f7', '#ffffff'];

// Shared with the firmware renderer: geometry for the split ring, cards.
export const ARC_HIT_RADIUS = 175;
export const APPROVAL_CARD = { x: 56, y: 76, w: 368, h: 328 };
export const SESSION_CARD = { x: 56, y: 86, w: 368, h: 308 };
const ENDED_COLOR = '#484f58';
const RING_TRACK = '#30363d';
const ATTENTION_HEADINGS = {
  shell: 'Run shell command', write: 'Edit file', read: 'Read file', url: 'Fetch URL', mcp: 'Use MCP tool',
  memory: 'Store memory', 'custom-tool': 'Use custom tool', other: 'Approve action',
  question: 'Question waiting', plan: 'Plan ready for review', limits: 'Session limit reached'
};
const inside = (box, x, y) => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
export const ago = (sec) => !Number.isFinite(sec) || sec < 60 ? 'just now'
  : sec < 3600 ? `${Math.floor(sec / 60)}m ago` : `${Math.floor(sec / 3600)}h ago`;
export const duration = (sec) => sec < 60 ? `${sec}s`
  : sec < 3600 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${Math.floor(sec / 3600)}h ${Math.floor(sec / 60) % 60}m`;
export const compactCount = (n) => n < 1000 ? String(n)
  : n < 1e6 ? `${(n / 1000).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '')}k` : `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
export const attentionHeading = (attention) => ATTENTION_HEADINGS[attention?.kind] ?? 'Needs input';
export function sessionStatus(sess) {
  if (sess.closed) return `Closed ${ago(sess.endedAgoSec)}`;
  switch (sess.state) {
    case 'needsInput': {
      const kind = sess.attention?.kind;
      if (kind === 'question' || kind === 'plan' || kind === 'limits') return ATTENTION_HEADINGS[kind];
      if (sess.attention) return 'Needs approval';
      return sess.tool ? `Approve ${sess.tool}?` : 'Needs input';
    }
    case 'tool': return `Executing ${sess.tool ?? 'tool'}`;
    case 'thinking': return sess.activity ?? 'Working';
    case 'done': return 'Done';
    case 'error': return 'Error';
    default: return sess.finished ? `Done ${ago(sess.endedAgoSec)}` : 'Idle';
  }
}
export function arcSlot(x, y, count) {
  const dx = x - 240, dy = y - 240;
  const radius = Math.hypot(dx, dy);
  if (!count || radius < ARC_HIT_RADIUS || radius > C) return -1;
  const span = (Math.PI * 2) / 3;
  const angle = (Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
  const slot = Math.floor((angle + span / 2) / span) % 3;
  return slot < count ? slot : -1;
}

// Shrinks the font until text fits; leaves the font set on the context.
const fitText = (ctx, text, maxWidth, weight, size, min) => {
  let px = size;
  ctx.font = `${weight} ${px}px system-ui, sans-serif`;
  while (px > min && ctx.measureText(text).width > maxWidth) {
    px -= 1;
    ctx.font = `${weight} ${px}px system-ui, sans-serif`;
  }
};
const lerp = (a, b, k) => a + (b - a) * k;
const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgb = ([r, g, b], a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

export class Face {
  emotions: any;
  artwork: any;
  frames: any;
  character: string;
  mood: string;
  state: any;
  enteredAt: number;
  shape: any;
  p: any;
  particles: any[];
  lastFrame: number;
  overlay: { mode: 'session' | 'approval' | 'notification'; key: string; until: number } | null;
  press: { x: number; y: number; at: number } | null;
  carousel = new SessionCarousel();
  avatarClocks = new Map<string, { mood: string; at: number }>();
  incoming: any;

  get selectedKey() { return this.carousel.selectedKey; }

  constructor(emotions, artwork = null, frames = null) {
    this.emotions = emotions;
    this.artwork = artwork;
    this.frames = frames;
    this.character = 'frames';
    this.mood = 'disconnected';
    this.state = presentation({ mood: this.mood, tool: null, source: null, sessions: [] }, this.emotions.presentations);
    this.enteredAt = 0;
    this.shape = { from: null, to: this.spec.eyes.shape, at: -1e9 };
    this.p = this.target();
    this.particles = [];
    this.lastFrame = 0;
    this.overlay = null;
    this.press = null;
  }

  get spec() {
    return this.emotions.moods[this.mood] ?? this.emotions.moods.idle;
  }

  setEmotions(emotions) {
    this.emotions = emotions;
  }

  setState(state, now) {
    state = workingSessionState(state);
    const membershipChanged = state.mascot !== 'mona' &&
      this.state.sessions.map(sessionKey).join('\0') !== state.sessions.map(sessionKey).join('\0');
    this.incoming = state;
    if (this.overlay && this.overlay.mode !== 'notification' &&
        (!state.sessions.some(sess => sessionKey(sess) === this.overlay.key) ||
         (state.sessions.some(sess => sessionKey(sess) === this.overlay.key && sess.backgroundOnly) &&
          this.state.sessions.some(sess => sessionKey(sess) === this.overlay.key && !sess.backgroundOnly)))) this.overlay = null;
    if (this.overlay?.mode === 'notification' && this.overlay.key !== state.alert?.id) this.overlay = null;
    const suspended = state.mascot === 'mona' || state.copilotNotification || state.mood === 'disconnected' ||
      (this.overlay && now < this.overlay.until);
    this.carousel.update(state.sessions ?? [], state.primary ?? 0, now, !!suspended);
    const selected = state.sessions?.find((sess) => sessionKey(sess) === this.selectedKey);
    if (selected && state.mascot !== 'mona' && !state.copilotNotification && state.mood !== 'disconnected') {
      const mood = sessionMood(selected);
      state = { ...state, mood, tool: selected.tool, task: undefined, ring: undefined,
        presentationId: this.state.presentationId,
        primary: state.sessions.indexOf(selected) };
    }
    const next = presentation(state, this.emotions.presentations);
    const changed = membershipChanged || presentationChanged(this.state, next) || (next.mascot !== 'mona' && (
      sessionKey(this.primarySession() ?? {}) !== sessionKey(next.sessions[next.primary ?? 0] ?? {}) ||
      (selected && selected.state !== 'idle' && this.primarySession()?.stateSince !== selected.stateSince)));
    const identityChanged = next.mascot !== this.state.mascot;
    this.state = next;
    const { mood } = next;
    if (!changed) return false;
    if ((identityChanged || membershipChanged) && this.frames) {
      this.frames.current = null;
      this.frames.transition = null;
    }
    const prevShape = this.spec.eyes.shape;
    this.mood = mood;
    this.enteredAt = now;
    this.particles = [];
    if (prevShape !== this.spec.eyes.shape) this.shape = { from: prevShape, to: this.spec.eyes.shape, at: now };
    if (this.spec.fx === 'confetti') this.spawnConfetti();
    return true;
  }

  target() {
    const s = this.spec;
    const ring = this.state?.ring ?? s.ring;
    return {
      eyeW: s.eyes.w,
      eyeH: s.eyes.h,
      ringW: ring.width,
      ring: hexToRgb(ring.color),
      tilt: s.head.tilt,
      brightness: s.brightness,
      gray: s.grayscale ? 1 : 0
    };
  }

  spawnConfetti() {
    for (let i = 0; i < 70; i++) {
      this.particles.push({
        x: C + (Math.random() - 0.5) * 60,
        y: C - 60,
        vx: (Math.random() - 0.5) * 420,
        vy: -200 - Math.random() * 320,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 12,
        color: CONFETTI[i % CONFETTI.length],
        life: 2.2 + Math.random()
      });
    }
  }

  draw(ctx, now, displayBrightness = 1) {
    const dt = Math.min(0.1, (now - (this.lastFrame || now)) / 1000);
    this.lastFrame = now;
    const k = 1 - Math.exp((-dt * 1000) / Math.max(1, this.emotions.transitionMs / 3));
    const t = this.target();
    for (const key of ['eyeW', 'eyeH', 'ringW', 'tilt', 'brightness', 'gray']) this.p[key] = lerp(this.p[key], t[key], k);
    this.p.ring = this.p.ring.map((v, i) => lerp(v, t.ring[i], k));

    const s = this.spec;
    const pal = this.emotions.palette;
    const sec = now / 1000;
    const since = (now - this.enteredAt) / 1000;

    ctx.save();
    ctx.filter = this.p.gray > 0.05 ? `grayscale(${this.p.gray.toFixed(2)})` : 'none';
    ctx.beginPath();
    ctx.arc(C, C, C, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = pal.background;
    ctx.fillRect(0, 0, SIZE, SIZE);

    if (this.splitRing()) this.drawSessionArcs(ctx, sec);
    else this.drawRing(ctx, sec);
    this.drawTopBadge(ctx);

    let dy = Math.sin(sec * Math.PI * 0.3) * s.head.bob;
    let dx = 0;
    let rot = this.p.tilt;
    if (s.head.shake && since < 1.2) dx = Math.sin(since * 50) * s.head.shake * (1 - since / 1.2);
    if (s.head.wobble) rot += Math.sin(sec * 6) * s.head.wobble * (0.5 + 0.5 * Math.sin(sec * 1.3));
    if (s.head.hop && since < 0.9) dy -= Math.abs(Math.sin(since * Math.PI * 2.2)) * 28 * (1 - since / 0.9);

    const mona = this.state.mascot === 'mona';
    const showAvatar = mona || this.mood === 'idle' || this.mood === 'done' ||
      this.state.copilotNotification || this.state.sessions.length > 0;
    if (this.splitRing() && this.state.sessions.length > 1) {
      this.drawCarousel(ctx, now);
    } else if (showAvatar) {
      ctx.save();
      const baked = this.character === 'frames' || mona;
      ctx.translate(C + (baked ? 0 : dx), C + 6 + (baked ? 0 : dy));
      if (!baked) ctx.rotate((rot * Math.PI) / 180);
      const rendered = ((mona || this.character === 'frames') && this.frames?.draw(ctx, this.state.clip, now, this.enteredAt, this.emotions.transitionMs)) ||
        (!mona && this.character !== 'vector' && this.artwork?.draw(ctx, this.mood, now, this.enteredAt, this.emotions.transitionMs));
      if (!rendered && mona) this.drawMona(ctx);
      else if (!rendered) {
        this.drawHead(ctx, pal);
        this.drawEyes(ctx, now, sec, pal);
        this.drawMouth(ctx, s.mouth, pal);
      }
      ctx.restore();
    }

    // Mona alert moods have no entry in emotions.moods; Mona idle/disconnected use their matching fx (zzz / wifi).
    const fx = (mona && !this.emotions.moods[this.mood]) || s.fx === 'question' || (this.splitRing() && s.fx === 'dots') ? 'none' : s.fx;
    this.drawFx(ctx, fx, sec, dt);
    if (this.splitRing()) this.drawCaption(ctx);
    else this.drawLabel(ctx);
    this.drawOverlay(ctx, now);

    const dim = 1 - this.p.brightness * displayBrightness;
    if (dim > 0.01) {
      ctx.fillStyle = `rgba(0,0,0,${Math.min(0.95, dim)})`;
      ctx.fillRect(0, 0, SIZE, SIZE);
    }
    ctx.restore();
  }

  drawRing(ctx, sec) {
    for (let i = 0; i < 72; i++) {
      ctx.fillStyle = RING_TRACK;
      this.drawRingDot(ctx, i);
    }
  }

  drawCarousel(ctx, now) {
    const list = this.state.sessions;
    const keys = new Set(list.map(sessionKey));
    for (const key of this.avatarClocks.keys()) if (!keys.has(key)) this.avatarClocks.delete(key);
    // Only the selected session is drawn, always at the front pose.
    const avatars = list.filter(session => sessionKey(session) === this.selectedKey)
      .map(session => ({ session, pose: { x: 240, y: 246, size: 320 } }));
    for (const { session, pose } of avatars) {
      const mood = sessionMood(session), key = sessionKey(session);
      let clock = this.avatarClocks.get(key);
      if (!clock || clock.mood !== mood) {
        clock = { mood, at: now };
        this.avatarClocks.set(key, clock);
      }
      ctx.save();
      ctx.translate(pose.x, pose.y);
      ctx.scale(pose.size / 320, pose.size / 320);
      const clip = mood === 'done' ? 'idle' : mood;
      const rendered = (this.character === 'frames' && this.frames?.drawClip(ctx, clip, now, clock.at)) ||
        (this.character !== 'vector' && this.artwork?.drawPose(ctx, clip, now, clock.at));
      if (!rendered) {
        const saved = { mood: this.mood, p: this.p, shape: this.shape, enteredAt: this.enteredAt };
        this.mood = clip;
        this.p = { ...this.p, ...this.target() };
        this.shape = { from: null, to: this.spec.eyes.shape, at: -1e9 };
        this.enteredAt = clock.at;
        this.drawHead(ctx, this.emotions.palette);
        this.drawEyes(ctx, now, now / 1000, this.emotions.palette);
        this.drawMouth(ctx, this.spec.mouth, this.emotions.palette);
        this.mood = saved.mood;
        this.p = saved.p;
        this.shape = saved.shape;
        this.enteredAt = saved.enteredAt;
      }
      ctx.restore();
    }
  }

  drawRingDot(ctx, index) {
    const angle = index * Math.PI * 2 / 72;
    ctx.beginPath();
    ctx.arc(C + Math.cos(angle) * 230, C + Math.sin(angle) * 230, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  splitRing() {
    return this.state.mascot !== 'mona' && !this.state.copilotNotification &&
      this.mood !== 'disconnected' && this.state.sessions.length > 0;
  }

  sessionColor(sess) {
    return sess.closed || sess.state === 'idle' || sess.state === 'done'
      ? '#3fb950' : this.emotions.presentations.copilot[sess.state]?.ring?.color ?? ENDED_COLOR;
  }

  drawSessionArcs(ctx, sec) {
    const list = this.state.sessions;
    const span = 24;
    ctx.save();
    for (let k = 0; k < 3; k++) {
      const sess = list[k];
      const asking = sess && !sess.closed && sess.state === 'needsInput';
      const running = sess && !sess.closed && (sess.state === 'thinking' || sess.state === 'tool');
      const color = !sess || (asking && Math.floor(sec * 2) % 2) ? RING_TRACK : this.sessionColor(sess);
      for (let within = 0; within < span; within++) {
        if (within === 0) continue;
        ctx.fillStyle = running && (within - 1 - Math.floor(sec * 10) % 23 + 23) % 23 >= 5 ? RING_TRACK : color;
        this.drawRingDot(ctx, (54 + k * span - span / 2 + within + 72) % 72);
      }
      if (asking) {
        const angle = -Math.PI / 2 + k * Math.PI * 2 / 3;
        const x = C + Math.cos(angle) * 230, y = C + Math.sin(angle) * 230;
        ctx.fillStyle = '#0d1117';
        ctx.fillRect(x - 10, y - 15, 20, 30);
        ctx.fillStyle = color;
        ctx.font = '700 26px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('?', x, y);
      }
    }
    ctx.restore();
  }

  drawTopBadge(ctx) {
    if (this.state.mascot === 'mona') {
      ctx.fillStyle = '#f0f6fc';
      ctx.beginPath();
      ctx.arc(C, 34, 7, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
  }

  primarySession() {
    const list = this.state.sessions;
    return list[this.state.primary ?? 0] ?? list[0];
  }

  drawCaption(ctx) {
    const sess = this.primarySession();
    if (!sess) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const status = sess.closed || sess.state === 'idle' ? 'Done'
      : sess.state === 'tool' ? 'Executing' : sess.state === 'needsInput' ? 'Ask' : sessionStatus(sess);
    ctx.fillStyle = this.sessionColor(sess);
    fitText(ctx, status, 290, 700, 22, 14);
    ctx.fillText(status, C, 64);
    if (sess.tool && !sess.closed) {
      ctx.fillStyle = '#8b949e';
      fitText(ctx, sess.tool, 270, 500, 14, 11);
      ctx.fillText(sess.tool, C, 90);
    }
    const name = sess.name || sess.sessionId.slice(0, 8);
    ctx.fillStyle = '#c9d1d9';
    this.wrap(ctx, name, C, C + 168, 250, 22, 2, '500 16px system-ui, sans-serif');
    ctx.restore();
  }

  findSession(key) {
    return this.state.sessions.find((sess) => sessionKey(sess) === key);
  }

  open(sess, now) {
    const approval = sess.state === 'needsInput' && !!sess.attention;
    this.overlay = { mode: approval ? 'approval' : 'session', key: sessionKey(sess), until: now + (approval ? 30_000 : 10_000) };
  }

  tap(now, x = C, y = C) {
    if (this.state.mascot === 'mona' && this.state.alert?.id) {
      if (this.overlay?.mode !== 'notification') {
        this.overlay = { mode: 'notification', key: this.state.alert.id, until: Infinity };
      } else if (inside(APPROVAL_CARD, x, y)) {
        return this.overlay.key;
      } else {
        this.overlay = null;
      }
      return null;
    }
    const list = this.state.sessions;
    if (this.state.mascot === 'mona' || this.state.copilotNotification || !list.length || this.mood === 'disconnected') return;
    const arc = arcSlot(x, y, list.length);
    const slot = arc;
    if (slot >= 0) {
      const key = sessionKey(list[slot]);
      if (list[slot].backgroundOnly || this.selectedKey === key) this.open(list[slot], now);
      else {
        this.carousel.select(key, now, true);
        this.overlay = null;
        this.setState(this.incoming, now);
      }
      return;
    }
    if (this.overlay && now < this.overlay.until) {
      const card = this.overlay.mode === 'approval' ? APPROVAL_CARD : SESSION_CARD;
      if (!inside(card, x, y)) {
        this.overlay = null;
        return;
      }
      const index = list.findIndex((sess) => sessionKey(sess) === this.overlay!.key);
      this.open(list[(index + 1) % list.length], now);
      return;
    }
    this.open(this.primarySession(), now);
  }

  pointerDown(now, x, y) {
    this.press = { x, y, at: now };
  }

  pointerUp(now) {
    const press = this.press;
    this.press = null;
    if (!press) return;
    if (now - press.at < 800) return this.tap(now, press.x, press.y);
    return null;
  }

  drawOverlay(ctx, now) {
    if (!this.overlay) return;
    if (this.overlay.mode === 'notification') {
      if (this.overlay.key !== this.state.alert?.id || this.state.mascot !== 'mona') {
        this.overlay = null;
        return;
      }
      ctx.save();
      ctx.fillStyle = 'rgba(13,17,23,0.86)';
      ctx.beginPath();
      ctx.arc(C, C, C, 0, Math.PI * 2);
      ctx.fill();
      this.drawNotificationCard(ctx);
      ctx.restore();
      return;
    }
    const sess = this.findSession(this.overlay.key);
    const stale = this.overlay.mode === 'approval' && (!sess?.attention || sess.state !== 'needsInput');
    if (!sess || now >= this.overlay.until || stale) {
      this.overlay = null;
      this.press = null;
      return;
    }
    ctx.save();
    // Dim everything (including the caption) so the card never competes with it.
    ctx.fillStyle = 'rgba(13,17,23,0.86)';
    ctx.beginPath();
    ctx.arc(C, C, C, 0, Math.PI * 2);
    ctx.fill();
    this.drawSessionArcs(ctx, now / 1000);
    if (this.overlay.mode === 'approval') this.drawApprovalCard(ctx, sess);
    else this.drawSessionCard(ctx, sess);
    ctx.restore();
  }

  drawNotificationCard(ctx) {
    const box = APPROVAL_CARD;
    const accent = this.state.ring?.color ?? '#f85149';
    this.card(ctx, box, accent);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = accent;
    fitText(ctx, this.state.task, 310, 700, 24, 15);
    ctx.fillText(this.state.task, C, box.y + 34);
    ctx.fillStyle = '#8b949e';
    const repository = this.state.alert.repository || '';
    const organization = this.state.alert.organization || '';
    const owner = organization || this.state.alert.owner || repository.split('/')[0] || '';
    const ownerLabel = organization ? 'Organization' : 'Owner';
    const repositoryName = this.state.alert.repositoryName || repository.split('/').at(-1) || '';
    const organizationLine = `${ownerLabel}: ${owner}`;
    const repositoryLine = `Repository: ${repositoryName}`;
    fitText(ctx, organizationLine, 340, 500, 14, 11);
    ctx.fillText(organizationLine, C, box.y + 72);
    fitText(ctx, repositoryLine, 340, 500, 14, 11);
    ctx.fillText(repositoryLine, C, box.y + 94);
    ctx.fillStyle = '#f0f6fc';
    this.wrap(ctx, this.state.alert.title || '', C, box.y + 132, 310, 26, 3, '500 18px system-ui, sans-serif');
    ctx.fillStyle = '#8b949e';
    ctx.font = '600 17px system-ui, sans-serif';
    ctx.fillText('Tap card to dismiss', C, box.y + 255);
  }

  card(ctx, box, color) {
    ctx.fillStyle = '#0d1117';
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    // Large corner radius keeps the card inside the round display.
    ctx.roundRect(box.x, box.y, box.w, box.h, 56);
    ctx.fill();
    ctx.stroke();
  }

  drawSessionCard(ctx, sess) {
    const color = this.sessionColor(sess);
    const box = SESSION_CARD;
    this.card(ctx, box, color);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f0f6fc';
    const name = sess.name || sess.sessionId.slice(0, 8);
    fitText(ctx, name, 310, 700, 24, 15);
    ctx.fillText(name, C, box.y + 34);
    const status = sessionStatus(sess);
    fitText(ctx, status, 280, 600, 18, 12);
    const chipW = Math.min(310, ctx.measureText(status).width + 36);
    ctx.fillStyle = rgb(hexToRgb(color) as [number, number, number], 0.18);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(C - chipW / 2, box.y + 56, chipW, 32, 16);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(status, C, box.y + 72);

    const rows: [string, string][] = [['Agent', sess.agent || 'Copilot']];
    if (sess.subagent) rows.push(['Subagent', sess.subagent]);
    rows.push(['Model', sess.model || 'not reported']);
    rows.push(['Tokens', sess.inputTokens !== undefined
      ? `${compactCount(sess.inputTokens)} in · ${compactCount(sess.outputTokens)} out` : 'not reported yet']);
    if (sess.contextPercent !== undefined) rows.push(['Context', `${sess.contextPercent}%`]);
    if (sess.busySec !== undefined) rows.push(['Working', duration(sess.busySec)]);
    else if (sess.ended) rows.push([sess.closed ? 'Closed' : 'Ended', ago(sess.endedAgoSec)]);
    rows.forEach(([label, value], i) => {
      const y = box.y + 120 + i * 30;
      ctx.textAlign = 'left';
      ctx.fillStyle = '#8b949e';
      ctx.font = '500 15px system-ui, sans-serif';
      ctx.fillText(label, 84, y);
      ctx.fillStyle = '#f0f6fc';
      fitText(ctx, value, 220, 600, 16, 11);
      ctx.fillText(value, 178, y);
      if (label === 'Context') {
        const width = 76;
        ctx.fillStyle = '#30363d';
        ctx.fillRect(322, y - 4, width, 8);
        ctx.fillStyle = sess.contextPercent >= 85 ? '#f85149' : '#2f81f7';
        ctx.fillRect(322, y - 4, width * Math.min(100, sess.contextPercent) / 100, 8);
      }
    });
  }

  drawApprovalCard(ctx, sess) {
    const attention = sess.attention;
    const amber = '#f0a020';
    const box = APPROVAL_CARD;
    this.card(ctx, box, amber);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = amber;
    const heading = attentionHeading(attention);
    fitText(ctx, heading, 310, 700, 24, 15);
    ctx.fillText(heading, C, box.y + 34);
    ctx.fillStyle = '#8b949e';
    const name = sess.name || sess.sessionId.slice(0, 8);
    fitText(ctx, name, 300, 500, 15, 11);
    ctx.fillText(name, C, box.y + 62);
    if (attention.reason) {
      ctx.fillStyle = '#f0f6fc';
      this.wrap(ctx, attention.reason, C, box.y + 98, 310, 24, 2, '500 18px system-ui, sans-serif');
    }
    if (attention.preview) {
      ctx.fillStyle = '#161b22';
      ctx.beginPath();
      ctx.roundRect(76, box.y + 146, 328, 56, 10);
      ctx.fill();
      ctx.fillStyle = '#c9d1d9';
      this.wrap(ctx, attention.preview, C, box.y + 164, 300, 20, 2, '500 15px ui-monospace, monospace');
    }
    if (attention.pending > 1) {
      ctx.fillStyle = '#8b949e';
      ctx.font = '500 13px system-ui, sans-serif';
      ctx.fillText(`+${attention.pending - 1} more waiting`, C, box.y + 218);
    }
    ctx.fillStyle = '#8b949e';
    ctx.font = '600 17px system-ui, sans-serif';
    ctx.fillText('Answer on computer', C, box.y + 252);
  }

  wrap(ctx, text, x, y, maxWidth, lineHeight, maxLines, font) {
    ctx.font = font;
    const words = String(text).split(/\s+/);
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= maxWidth || !line) line = next;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    const shown = lines.slice(0, maxLines);
    if (lines.length > maxLines) shown[maxLines - 1] = `${shown[maxLines - 1]}…`;
    shown.forEach((value, i) => {
      let clipped = value;
      while (clipped.length > 1 && ctx.measureText(clipped).width > maxWidth) clipped = `${clipped.slice(0, -2)}…`;
      ctx.fillText(clipped, x, y + i * lineHeight);
    });
  }

  // A compact cat-eared octopus silhouette, never Copilot artwork for Mona.
  drawMona(ctx) {
    ctx.fillStyle = '#c9b8f5';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * 40, -80);
      ctx.lineTo(side * 90, -140);
      ctx.lineTo(side * 100, -45);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.ellipse(0, -20, 110, 95, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#c9b8f5';
    ctx.lineWidth = 25;
    ctx.lineCap = 'round';
    for (const x of [-75, -25, 25, 75]) {
      ctx.beginPath();
      ctx.moveTo(x, 45);
      ctx.quadraticCurveTo(x * 1.7, 140, x * 1.8, 100);
      ctx.stroke();
    }
    ctx.fillStyle = '#0d1117';
    ctx.beginPath();
    ctx.ellipse(0, -12, 78, 59, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f0f6fc';
    for (const x of [-30, 30]) {
      ctx.beginPath();
      ctx.ellipse(x, -12, 11, 20, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawHead(ctx, pal) {
    ctx.lineWidth = 8;
    ctx.strokeStyle = pal.headStroke;
    ctx.lineJoin = 'round';

    ctx.fillStyle = pal.head;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.roundRect(side * 168 - 16, -20, 32, 80, 14);
      ctx.fill();
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.roundRect(-152, -100, 304, 235, [70, 70, 95, 95]);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#120d22';
    ctx.beginPath();
    ctx.roundRect(-108, -2, 216, 118, 46);
    ctx.fill();

    for (const side of [-1, 1]) {
      ctx.fillStyle = pal.lens;
      ctx.beginPath();
      ctx.roundRect(side * 70 - 62, -150, 124, 86, 40);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(side * 70 - 18, -118, 18, Math.PI * 1.05, Math.PI * 1.5);
      ctx.stroke();
      ctx.lineWidth = 8;
      ctx.strokeStyle = pal.headStroke;
    }
    ctx.beginPath();
    ctx.moveTo(-8, -112);
    ctx.lineTo(8, -112);
    ctx.stroke();
  }

  drawEyes(ctx, now, sec, pal) {
    const eyes = this.spec.eyes;
    const T = this.emotions.transitionMs;
    const phase = (now - this.shape.at) / T;
    let shape = this.shape.to;
    let squash = 1;
    if (phase < 1) {
      shape = phase < 0.5 ? this.shape.from : this.shape.to;
      squash = Math.abs(1 - 2 * phase);
    }
    if (eyes.blinkEverySec > 0 && sec % eyes.blinkEverySec < 0.14) squash *= 0.1;

    const lookX = eyes.wander ? (eyes.wander * (Math.sin(sec * 0.9) + 0.5 * Math.sin(sec * 2.3))) / 1.5 : 0;
    const lookY = eyes.wander ? Math.sin(sec * 0.6) * eyes.wander * 0.25 : 0;
    const w = this.p.eyeW;
    const h = Math.max(4, this.p.eyeH * Math.max(0.08, squash));

    ctx.fillStyle = pal.eye;
    ctx.strokeStyle = pal.eye;
    ctx.lineCap = 'round';
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(side * 40 + lookX, 46 + lookY);
      switch (shape) {
        case 'closed':
          ctx.beginPath();
          ctx.roundRect(-w / 2, -3, w, 6, 3);
          ctx.fill();
          break;
        case 'happy': {
          const since = (now - this.enteredAt) / 1000;
          const winking = side === 1 && since > 1.72 && since < 2.36;
          ctx.lineWidth = 9;
          ctx.beginPath();
          if (winking) {
            ctx.moveTo(-w / 2, 0);
            ctx.lineTo(w / 2, 0);
          } else {
            ctx.arc(0, h / 2, w / 2, Math.PI * 1.1, Math.PI * 1.9);
          }
          ctx.stroke();
          break;
        }
        case 'x':
          ctx.lineWidth = 8;
          ctx.beginPath();
          ctx.moveTo(-w / 2, -w / 2);
          ctx.lineTo(w / 2, w / 2);
          ctx.moveTo(w / 2, -w / 2);
          ctx.lineTo(-w / 2, w / 2);
          ctx.stroke();
          break;
        default:
          if (shape === 'wide') {
            ctx.translate(0, side === 1 ? -4 : 1);
            ctx.rotate(-side * 0.14);
          }
          ctx.beginPath();
          ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(w, h) / 2);
          ctx.fill();
          if (shape === 'wide' && squash > 0.5) {
            ctx.fillStyle = '#120d22';
            ctx.beginPath();
            ctx.arc(w * 0.15, -h * 0.22, w * 0.16, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = pal.eye;
          }
      }
      ctx.restore();
    }
  }

  drawMouth(ctx, mouth, pal) {
    ctx.strokeStyle = pal.eye;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    switch (mouth) {
      case 'smile':
        ctx.arc(0, 80, 22, Math.PI * 0.15, Math.PI * 0.85);
        break;
      case 'o':
        ctx.arc(0, 96, 9, 0, Math.PI * 2);
        break;
      case 'flat':
        ctx.moveTo(-16, 98);
        ctx.lineTo(16, 98);
        break;
      case 'wavy':
        for (let x = -24; x <= 24; x += 2) ctx.lineTo(x, 98 + Math.sin(x / 4) * 4);
        break;
      default:
        return;
    }
    ctx.stroke();
  }

  drawFx(ctx, fx, sec, dt) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (fx === 'zzz') {
      ctx.fillStyle = '#c9b8f5';
      for (let i = 0; i < 3; i++) {
        const p = (sec * 0.35 + i / 3) % 1;
        ctx.globalAlpha = Math.sin(p * Math.PI);
        ctx.font = `bold ${18 + p * 18}px system-ui, sans-serif`;
        ctx.fillText('z', C + 120 + p * 40, C - 150 - p * 60);
      }
    } else if (fx === 'dots') {
      ctx.fillStyle = '#c9d1d9';
      for (let i = 0; i < 3; i++) {
        const y = C - 172 - Math.max(0, Math.sin(sec * 1.5 - i * 0.7)) * 2;
        ctx.beginPath();
        ctx.arc(C - 18 + i * 18, y, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (fx === 'question') {
      ctx.fillStyle = '#f0a020';
      ctx.font = 'bold 56px system-ui, sans-serif';
      ctx.fillText('?', C + 150, C - 150);
    } else if (fx === 'wifi') {
      ctx.strokeStyle = '#8b949e';
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      for (const r of [10, 22, 34]) {
        ctx.beginPath();
        ctx.arc(C, C - 168, r, Math.PI * 1.25, Math.PI * 1.75);
        ctx.stroke();
      }
      ctx.strokeStyle = '#f85149';
      ctx.beginPath();
      ctx.moveTo(C - 26, C - 210);
      ctx.lineTo(C + 26, C - 166);
      ctx.stroke();
    }
    ctx.restore();

    this.particles = this.particles.filter((p) => (p.life -= dt) > 0);
    for (const p of this.particles) {
      p.vy += 700 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      ctx.save();
      ctx.globalAlpha = Math.min(1, p.life);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-5, -3, 10, 6);
      ctx.restore();
    }
  }

  drawLabel(ctx) {
    const { tool, source, sessions } = this.state;
    const src = SOURCE_LABEL[source] ?? '';
      const text = this.state.task ?? (this.state.mascot === 'mona' ? alertLabel(this.state) :
      {
        tool: [src, tool].filter(Boolean).join(' · '),
        needsInput: tool ? `${src} · ${tool}?` : `${src} needs you`,
        thinking: `${src} thinking`,
        done: 'Done!',
        error: `${src} error`,
        idle: sessions.length ? `${sessions.length} session${sessions.length > 1 ? 's' : ''}` : '',
        disconnected: 'No bridge'
      }[this.mood] ?? '');
    if (!text) return;
    ctx.save();
    ctx.font = '600 20px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#c9d1d9';
    const clipped = text.length > 24 ? text.slice(0, 23) + '…' : text;
    ctx.fillText(clipped.trim(), C, C + 196);
    ctx.restore();
  }
}
