import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GithubAlert } from './orb-engine.js';

const API_ROOT = 'https://api.github.com';
const NOTIFICATIONS_PATH = '/notifications?all=false&participating=false&per_page=30&page=1';
const API_VERSION = '2022-11-28';
const MAX_THREADS = 2_000;
const MAX_ALERTS = 4_000;

class GitHubRequestError extends Error {
  constructor(readonly statusCode?: number) {
    super('GitHub request failed');
  }
}

interface Notification {
  id?: string;
  updated_at?: string;
  reason?: string;
  subject?: { title?: string; type?: string; url?: string };
  repository?: {
    full_name?: string;
    name?: string;
    owner?: { login?: string; type?: string };
  };
}

interface StoredState {
  threads: Record<string, string>;
  alerts: string[];
}

export interface GitHubPollerOptions {
  token?: string;
  pollSec?: number;
  dataDir: string;
  startedAtMs?: number;
  onAlert: (alert: GithubAlert) => void;
  fetcher?: typeof fetch;
}

export class GitHubPoller {
  private token: string;
  private readonly fetcher: typeof fetch;
  private readonly pollSec: number;
  private readonly statePath: string;
  private readonly startedAtMs: number;
  private readonly onAlert: (alert: GithubAlert) => void;
  private readonly threads = new Map<string, string>();
  private readonly alerts = new Set<string>();
  private etag = '';
  private initialized = false;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextDelaySec: number;
  private lastSuccessMs: number | null = null;
  private pollStatus: 'disabled' | 'starting' | 'ok' | 'error';
  private error = '';

  constructor(options: GitHubPollerOptions) {
    this.token = options.token?.trim() ?? '';
    this.pollSec = Math.max(30, Math.min(3600, Math.trunc(options.pollSec ?? 60)));
    this.nextDelaySec = this.pollSec;
    this.statePath = join(options.dataDir, 'github-state.json');
    this.startedAtMs = options.startedAtMs ?? Date.now();
    this.onAlert = options.onAlert;
    this.fetcher = options.fetcher ?? fetch;
    this.pollStatus = this.token ? 'starting' : 'disabled';
  }

  start(): void {
    if (!this.token || this.running) return;
    this.running = true;
    void this.pollAndSchedule();
  }

  setToken(token: string): void {
    this.stop();
    this.token = token.trim();
    this.etag = '';
    this.error = '';
    this.lastSuccessMs = null;
    this.pollStatus = this.token ? 'starting' : 'disabled';
    this.start();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  status() {
    return {
      enabled: Boolean(this.token),
      status: this.pollStatus,
      lastSuccessMs: this.lastSuccessMs,
      error: this.error || null
    };
  }

  async pollOnce(): Promise<void> {
    if (!this.token) {
      this.pollStatus = 'disabled';
      return;
    }
    try {
      await this.loadState();
      const headers: Record<string, string> = {};
      if (this.etag) headers['If-None-Match'] = this.etag;
      const inbox = await this.requestNotifications(headers);
      if (inbox.notModified) {
        this.markSuccess();
        return;
      }
      const notifications = Array.isArray(inbox.data) ? inbox.data as Notification[] : [];
      this.etag = inbox.etag ?? '';
      const fresh: GithubAlert[] = [];
      for (const notification of notifications) {
        const id = typeof notification.id === 'string' ? notification.id : '';
        const updatedAt = typeof notification.updated_at === 'string' ? notification.updated_at : '';
        if (!id || !updatedAt || this.threads.get(id) === updatedAt) continue;
        const alert = Date.parse(updatedAt) > this.startedAtMs ? this.classify(notification, id) : null;
        this.threads.set(id, updatedAt);
        if (alert && !this.alerts.has(alert.id)) {
          this.alerts.add(alert.id);
          fresh.push(alert);
        }
      }
      if (fresh.length) {
        fresh.sort((a, b) => this.priority(b.kind) - this.priority(a.kind));
        this.onAlert(fresh[0]);
      }
      this.trimState();
      await this.saveState();
      this.markSuccess();
      const intervalHeader = Number(inbox.headers?.['x-poll-interval']);
      this.nextDelaySec = Number.isFinite(intervalHeader) && intervalHeader > 0
        ? Math.max(this.pollSec, intervalHeader)
        : this.pollSec;
    } catch (error) {
      this.pollStatus = 'error';
      this.error = this.describeFailure(error);
    }
  }

  private async pollAndSchedule(): Promise<void> {
    await this.pollOnce();
    if (this.running) {
      this.timer = setTimeout(() => void this.pollAndSchedule(), this.nextDelaySec * 1000);
      this.timer.unref?.();
    }
  }

  private markSuccess(): void {
    this.pollStatus = 'ok';
    this.lastSuccessMs = Date.now();
    this.error = '';
  }

  private describeFailure(error: unknown): string {
    if (!(error instanceof GitHubRequestError)) {
      return 'GitHub inbox check failed; check the PAT, network connectivity, and dashboard storage';
    }
    const code = error.statusCode ? ` (HTTP ${error.statusCode})` : '';
    if (error.statusCode === 401) return `GitHub notifications request${code}: authentication failed; replace the PAT`;
    if (error.statusCode === 403) return `GitHub notifications request${code}: access denied or rate limited; check the notifications scope and account access`;
    if (error.statusCode) return `GitHub notifications request${code} failed`;
    return 'GitHub notifications request failed; check network connectivity';
  }

  private async requestNotifications(extraHeaders: Record<string, string> = {}): Promise<any> {
    const response = await this.fetcher(`${API_ROOT}${NOTIFICATIONS_PATH}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        ...extraHeaders
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    });
    if (response.status === 304) return { notModified: true, headers: {} };
    if (!response.ok) throw new GitHubRequestError(response.status);
    const data = await response.json();
    return { data, etag: response.headers.get('etag') ?? '', headers: Object.fromEntries(response.headers.entries()) };
  }

  private classify(notification: Notification, id: string): GithubAlert | null {
    const repository = notification.repository?.full_name;
    const subject = notification.subject;
    if (!repository || !subject) return null;
    const repositoryUrl = `https://github.com/${this.repoPath(repository)}`;
    if (notification.reason === 'agent_session_finished') {
      return this.alert(id, 'agentSessionFinished', 'Copilot done', repositoryUrl, repository, notification.repository);
    }
    if (notification.reason === 'approval_requested') {
      if (subject.type !== 'PullRequest') {
        return this.alert(id, 'reviewRequested', subject.title || 'Approval requested',
          repositoryUrl, repository, notification.repository);
      }
    }
    if (subject.type === 'PullRequest' &&
        ['assign', 'review_requested', 'approval_requested'].includes(notification.reason ?? '')) {
      const pullUrl = this.apiPath(subject.url);
      if (!pullUrl) return null;
      const match = pullUrl.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)(?:\?.*)?$/);
      if (!match) return null;
      let pullRepository: string;
      try {
        pullRepository = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
      } catch {
        return null;
      }
      if (pullRepository.toLowerCase() !== repository.toLowerCase()) return null;
      const [owner, name] = pullRepository.split('/');
      const kind = notification.reason === 'assign' ? 'prAssigned' : 'reviewRequested';
      const htmlUrl = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pull/${match[3]}`;
      return this.alert(id, kind, subject.title, htmlUrl, repository, notification.repository);
    }
    if (notification.reason === 'security_alert') {
      const alertNumber = this.apiPath(subject.url)?.match(/\/dependabot\/alerts\/(\d+)$/)?.[1];
      const url = `${repositoryUrl}/security/dependabot${alertNumber ? `/${alertNumber}` : ''}`;
      return this.alert(id, 'securityAlert', subject.title || 'Security alert', url, repository, notification.repository);
    }
    if (notification.reason === 'ci_activity') {
      return this.alert(id, 'workflowFailure', subject.title || 'Workflow failed',
        `${repositoryUrl}/actions`, repository, notification.repository);
    }
    return this.alert(id, 'githubNotification', subject.title || `${subject.type || 'GitHub'} notification`,
      repositoryUrl, repository, notification.repository);
  }

  private alert(
    id: string,
    kind: string,
    title: unknown,
    url: unknown,
    repository: string,
    repositoryMetadata?: Notification['repository']
  ): GithubAlert {
    const owner = repositoryMetadata?.owner?.login;
    return {
      id,
      kind,
      title: typeof title === 'string' ? title.slice(0, 120) : 'GitHub notification',
      url: this.githubUrl(url),
      repository: repository.slice(0, 64),
      owner: typeof owner === 'string' ? owner.slice(0, 40) : undefined,
      organization: repositoryMetadata?.owner?.type === 'Organization' && typeof owner === 'string'
        ? owner.slice(0, 40)
        : undefined,
      repositoryName: typeof repositoryMetadata?.name === 'string'
        ? repositoryMetadata.name.slice(0, 40)
        : repository.slice(repository.lastIndexOf('/') + 1, 64)
    };
  }

  private apiPath(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      return url.hostname === 'api.github.com' && url.protocol === 'https:' ? `${url.pathname}${url.search}` : null;
    } catch {
      return null;
    }
  }

  private githubUrl(value: unknown): string {
    if (typeof value !== 'string') return '';
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password ? url.href : '';
    } catch {
      return '';
    }
  }

  private repoPath(repository: string): string {
    return repository.split('/').map(encodeURIComponent).join('/');
  }

  private priority(kind: string): number {
    return kind === 'securityAlert' ? 4 : kind === 'workflowFailure' || kind === 'workflowUpdate' ? 3 :
      kind === 'prAssigned' || kind === 'reviewRequested' ? 2 : kind === 'agentSessionFinished' ? 1 : 0;
  }

  private async loadState(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8')) as StoredState;
      for (const [id, updated] of Object.entries(state.threads ?? {})) this.threads.set(id, updated);
      for (const id of state.alerts ?? []) this.alerts.add(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private trimState(): void {
    while (this.threads.size > MAX_THREADS) this.threads.delete(this.threads.keys().next().value!);
    while (this.alerts.size > MAX_ALERTS) this.alerts.delete(this.alerts.values().next().value!);
  }

  private async saveState(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const state: StoredState = { threads: Object.fromEntries(this.threads), alerts: [...this.alerts] };
    const temporary = `${this.statePath}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, this.statePath);
  }
}
