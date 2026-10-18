import { randomBytes, randomUUID } from 'node:crypto';
import type { OrbConnectionConfig } from '../observer/config-store.js';

export const DEMO_SESSION = {
  sessionId: 'orb-demo-session-one',
  sessionName: 'Session one',
  project: 'github-orb',
  agent: 'Copilot',
  model: 'claude-sonnet-4.5'
} as const;

export const DEMO_ALERT = {
  kind: 'criticalSecurity',
  title: 'Critical: SQL injection in orders API',
  repository: 'octo-org/shop-api',
  organization: true
} as const;

export interface DemoStatus {
  running: boolean;
  finished: boolean;
  step: string | null;
  stepIndex: number;
  steps: string[];
  elapsedMs: number;
  durationMs: number;
  otherSessions: number;
  error: string | null;
}

type OrbRequest = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<Record<string, unknown>>;

interface DemoContext {
  observer(state: Record<string, unknown>): Promise<void>;
  end(): Promise<void>;
  alert(): Promise<void>;
}

interface DemoStep {
  atMs: number;
  label: string;
  run(context: DemoContext): Promise<void>;
}

// Roughly 40 seconds; offsets leave time for each animation to read well on camera.
export const DEMO_STEPS: readonly DemoStep[] = [
  { atMs: 0, label: 'Copilot is sleeping', run: async () => {} },
  { atMs: 6_000, label: 'Session one starts working', run: (c) => c.observer({ state: 'thinking', tool: null }) },
  { atMs: 10_000, label: 'Copilot executes an edit', run: (c) => c.observer({ state: 'tool', tool: 'edit' }) },
  {
    atMs: 14_000, label: 'Session asks a question',
    run: (c) => c.observer({ state: 'needsInput', tool: null, attention: { id: randomBytes(8).toString('hex'), kind: 'question', pending: 1 } })
  },
  { atMs: 22_000, label: 'Question answered, working again', run: (c) => c.observer({ state: 'thinking', tool: null }) },
  { atMs: 25_000, label: 'Copilot executes tests', run: (c) => c.observer({ state: 'tool', tool: 'bash' }) },
  { atMs: 28_000, label: 'Copilot finished (happy done)', run: (c) => c.observer({ state: 'done', tool: null }) },
  { atMs: 33_000, label: 'Mona receives a security vulnerability', run: (c) => c.alert() },
  { atMs: 42_000, label: 'Demo complete', run: (c) => c.end() }
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function orbRequest(config: OrbConnectionConfig): OrbRequest {
  return async (method, path, body) => {
    let response: Response;
    try {
      response = await fetch(`http://${config.host}:${config.port}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
        redirect: 'error'
      });
    } catch (error) {
      throw new Error(error instanceof Error && error.name === 'TimeoutError' ? 'orb_timeout' : 'orb_unreachable');
    }
    const result: unknown = await response.json().catch(() => null);
    if (response.status === 401 || response.status === 403) throw new Error('orb_unauthorized');
    if (response.status === 404 && path === '/github/simulate') throw new Error('mona_simulation_unsupported');
    if (!response.ok) throw new Error(isRecord(result) && typeof result.error === 'string' && /^[a-z_]+$/.test(result.error)
      ? result.error : 'orb_rejected');
    if (!isRecord(result)) throw new Error('invalid_orb_response');
    return result;
  };
}

export interface DemoPlayerOptions {
  config: () => Promise<OrbConnectionConfig>;
  // Test hook: multiplies every step offset.
  timeScale?: number;
}

export class DemoPlayer {
  private readonly config: () => Promise<OrbConnectionConfig>;
  private readonly timeScale: number;
  private run = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private startedAt = 0;
  private request: OrbRequest | undefined;
  private alertId: string | null = null;
  private sessionOpen = false;
  private instanceId = '';
  private sessionStartedAt = 0;
  private sequence = 0;
  private current: DemoStatus = DemoPlayer.idleStatus();

  constructor(options: DemoPlayerOptions) {
    this.config = options.config;
    this.timeScale = options.timeScale ?? 1;
  }

  private static idleStatus(): DemoStatus {
    return {
      running: false, finished: false, step: null, stepIndex: -1,
      steps: DEMO_STEPS.map((step) => step.label), elapsedMs: 0,
      durationMs: DEMO_STEPS[DEMO_STEPS.length - 1].atMs, otherSessions: 0, error: null
    };
  }

  status(): DemoStatus {
    return {
      ...this.current,
      elapsedMs: this.current.running ? Math.round((Date.now() - this.startedAt) / this.timeScale) : this.current.elapsedMs
    };
  }

  async start(): Promise<DemoStatus> {
    if (this.current.running) throw new Error('demo_running');
    const run = ++this.run;
    const request = orbRequest(await this.config());
    const health = await request('GET', '/health');
    if (health.status !== 'ok') throw new Error('invalid_orb_response');
    if (health.dashboard === true) throw new Error('destination_is_dashboard');
    if (health.alertSimulation !== true) throw new Error('mona_simulation_unsupported');

    // Start from a sleeping Orb: dismiss any Mona alert that is already showing.
    const state = await request('GET', '/state');
    if (isRecord(state.alert) && typeof state.alert.id === 'string' && state.alert.id)
      await request('POST', '/github/acknowledge', { id: state.alert.id }).catch(() => undefined);
    const sessions = Array.isArray(state.sessions) ? state.sessions : [];
    const otherSessions = sessions.filter((session) => !isRecord(session) || session.sessionId !== DEMO_SESSION.sessionId).length;
    if (run !== this.run) throw new Error('demo_cancelled');

    this.request = request;
    this.alertId = null;
    this.sessionOpen = false;
    this.instanceId = randomUUID();
    this.sessionStartedAt = Date.now();
    this.sequence = 0;
    this.startedAt = Date.now();
    this.current = { ...DemoPlayer.idleStatus(), running: true, otherSessions };
    this.schedule(run, 0);
    return this.status();
  }

  async stop(): Promise<DemoStatus> {
    const active = this.current.running || this.current.finished;
    this.run++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (active) {
      this.current = { ...this.status(), running: false, finished: false, step: 'Demo stopped' };
      await this.cleanup();
    }
    return this.status();
  }

  private context(): DemoContext {
    const request = this.request!;
    const base = () => ({
      source: 'cli', observerVersion: 1, sessionId: DEMO_SESSION.sessionId,
      instanceId: this.instanceId, startedAt: this.sessionStartedAt, sequence: ++this.sequence
    });
    return {
      observer: async (state) => {
        this.sessionOpen = true;
        await request('POST', '/event', {
          ...base(), event: 'observerState', sessionName: DEMO_SESSION.sessionName,
          project: DEMO_SESSION.project, agent: DEMO_SESSION.agent, model: DEMO_SESSION.model, ...state
        });
      },
      end: async () => {
        if (!this.sessionOpen) return;
        this.sessionOpen = false;
        await request('POST', '/event', { ...base(), event: 'observerEnd' });
      },
      alert: async () => {
        const result = await request('POST', '/github/simulate', DEMO_ALERT);
        this.alertId = typeof result.id === 'string' ? result.id : null;
      }
    };
  }

  private schedule(run: number, index: number): void {
    const step = DEMO_STEPS[index];
    const delay = Math.max(0, this.startedAt + step.atMs * this.timeScale - Date.now());
    this.timer = setTimeout(() => void this.execute(run, index), delay);
  }

  private async execute(run: number, index: number): Promise<void> {
    if (run !== this.run) return;
    const step = DEMO_STEPS[index];
    this.current = { ...this.current, step: step.label, stepIndex: index };
    try {
      await step.run(this.context());
    } catch (error) {
      if (run !== this.run) return;
      this.run++;
      this.current = {
        ...this.status(), running: false,
        error: error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'demo_failed'
      };
      await this.cleanup();
      return;
    }
    if (run !== this.run) return;
    if (index + 1 < DEMO_STEPS.length) {
      this.schedule(run, index + 1);
      return;
    }
    // Leave Mona's alert on screen after the last step; tap the Orb to acknowledge it.
    this.current = { ...this.current, running: false, finished: true, elapsedMs: this.current.durationMs };
  }

  private async cleanup(): Promise<void> {
    const request = this.request;
    if (!request) return;
    const context = this.context();
    await context.end().catch(() => undefined);
    if (this.alertId) {
      await request('POST', '/github/acknowledge', { id: this.alertId }).catch(() => undefined);
      this.alertId = null;
    }
  }
}
