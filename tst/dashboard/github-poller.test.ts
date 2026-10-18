import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitHubPoller } from '../../dashboard/github-poller.js';

const notification = {
  id: 'thread-1',
  updated_at: '2026-10-14T12:00:00Z',
  reason: 'assign',
  subject: { title: 'A pull request', type: 'PullRequest', url: 'https://api.github.com/repos/acme/orb/pulls/42' },
  repository: { full_name: 'acme/orb', name: 'orb', owner: { login: 'acme', type: 'Organization' } }
};

const defaultStartedAtMs = Date.parse('2026-10-14T11:59:00Z');

function createPoller(options: ConstructorParameters<typeof GitHubPoller>[0]) {
  return new GitHubPoller({ startedAtMs: defaultStartedAtMs, ...options });
}

function fetcher(calls: string[], item: unknown = notification) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const payload = typeof item === 'function' ? item() : item;
    if (url.includes('/notifications?')) return Response.json(Array.isArray(payload) ? payload : [payload], { headers: { etag: '"inbox-1"' } });
    throw new Error(`Unexpected GitHub request: ${url}`);
  };
}

test('poller maps assigned pull request notifications using only the notifications endpoint', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'orb-github-'));
  const calls: string[] = [];
  const alerts: unknown[] = [];
  try {
    const first = createPoller({ token: 'test-pat', dataDir, onAlert: (alert) => alerts.push(alert), fetcher: fetcher(calls) });
    await first.pollOnce();
    assert.deepEqual(alerts, [{
      id: 'thread-1', kind: 'prAssigned', title: 'A pull request',
      url: 'https://github.com/acme/orb/pull/42', repository: 'acme/orb',
      owner: 'acme', organization: 'acme', repositoryName: 'orb'
    }]);
    assert.equal(first.status().status, 'ok');
    assert.equal(calls.length, 1);
    assert.equal(calls.some((url) => url.includes('/pulls/')), false);

    const persisted = JSON.parse(await readFile(join(dataDir, 'github-state.json'), 'utf8'));
    assert.equal(persisted.threads['thread-1'], notification.updated_at);
    assert.deepEqual(persisted.alerts, ['thread-1']);

    const second = createPoller({ token: 'test-pat', dataDir, onAlert: () => assert.fail('duplicate alert emitted'), fetcher: fetcher(calls) });
    await second.pollOnce();
    assert.equal(calls.length, 2);
    assert.equal(alerts.length, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('poller ignores old unread threads until their timestamp advances after startup', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'orb-github-'));
  const calls: string[] = [];
  const alerts: unknown[] = [];
  const startedAtMs = Date.parse('2026-10-14T12:00:00Z');
  const stale = {
    ...notification,
    id: 'stale-thread',
    updated_at: '2026-10-14T11:59:59Z',
    reason: 'mention',
    subject: { title: 'An issue', type: 'Issue', url: 'https://api.github.com/repos/acme/orb/issues/8' }
  };
  const onBoundary = { ...stale, id: 'boundary-thread', updated_at: '2026-10-14T12:00:00Z' };
  let inbox: unknown = [stale, onBoundary];

  try {
    const poller = createPoller({
      token: 'test-pat',
      dataDir,
      startedAtMs,
      onAlert: (alert) => alerts.push(alert),
      fetcher: fetcher(calls, () => inbox)
    });

    await poller.pollOnce();
    assert.deepEqual(alerts, []);
    let persisted = JSON.parse(await readFile(join(dataDir, 'github-state.json'), 'utf8'));
    assert.equal(persisted.threads['stale-thread'], stale.updated_at);
    assert.equal(persisted.threads['boundary-thread'], onBoundary.updated_at);

    inbox = [{ ...stale, updated_at: '2026-10-14T12:00:01Z' }, onBoundary];
    await poller.pollOnce();
    assert.deepEqual(alerts, [{
      id: 'stale-thread',
      kind: 'githubNotification',
      title: 'An issue',
      url: 'https://github.com/acme/orb',
      repository: 'acme/orb',
      owner: 'acme',
      organization: 'acme',
      repositoryName: 'orb'
    }]);
    persisted = JSON.parse(await readFile(join(dataDir, 'github-state.json'), 'utf8'));
    assert.equal(persisted.threads['stale-thread'], '2026-10-14T12:00:01Z');
    assert.deepEqual(calls.map((url) => new URL(url).pathname), ['/notifications', '/notifications']);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('poller maps review-request notifications from the inbox alone', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'orb-github-'));
  const calls: string[] = [];
  const alerts: unknown[] = [];
  const reviewNotification = {
    ...notification,
    reason: 'review_requested',
    subject: { ...notification.subject, url: 'https://api.github.com/repos/acme/orb/pulls/7' }
  };
  try {
    const poller = createPoller({ token: 'test-pat', dataDir, onAlert: (alert) => alerts.push(alert),
      fetcher: fetcher(calls, reviewNotification) });
    await poller.pollOnce();
    assert.deepEqual(alerts, [{
      id: 'thread-1', kind: 'reviewRequested', title: 'A pull request',
      url: 'https://github.com/acme/orb/pull/7', repository: 'acme/orb',
      owner: 'acme', organization: 'acme', repositoryName: 'orb'
    }]);
    assert.deepEqual(calls.map((url) => new URL(url).pathname), ['/notifications']);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('poller maps approval_requested notifications to Mona PR attention', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'orb-github-'));
  const alerts: unknown[] = [];
  const approvalNotification = {
    ...notification,
    reason: 'approval_requested',
    subject: { title: 'Deployment approval', type: 'WorkflowRun', url: 'https://api.github.com/repos/acme/orb/actions/runs/8' }
  };
  try {
    const poller = createPoller({ token: 'test-pat', dataDir, onAlert: (alert) => alerts.push(alert),
      fetcher: fetcher([], approvalNotification) });
    await poller.pollOnce();
    assert.deepEqual(alerts, [{
      id: 'thread-1', kind: 'reviewRequested', title: 'Deployment approval',
      url: 'https://github.com/acme/orb', repository: 'acme/orb',
      owner: 'acme', organization: 'acme', repositoryName: 'orb'
    }]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('poller labels a personal repository owner without calling it an organization', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'orb-github-'));
  const alerts: unknown[] = [];
  const personalNotification = {
    ...notification,
    repository: { full_name: 'octocat/hello', name: 'hello', owner: { login: 'octocat', type: 'User' } },
    subject: { ...notification.subject, url: 'https://api.github.com/repos/octocat/hello/pulls/3' }
  };
  try {
    const poller = createPoller({ token: 'test-pat', dataDir, onAlert: (alert) => alerts.push(alert),
      fetcher: fetcher([], personalNotification) });
    await poller.pollOnce();
    assert.deepEqual(alerts, [{
      id: 'thread-1', kind: 'prAssigned', title: 'A pull request',
      url: 'https://github.com/octocat/hello/pull/3', repository: 'octocat/hello',
      owner: 'octocat', organization: undefined, repositoryName: 'hello'
    }]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('missing PAT disables polling without making a network request', async () => {
  const poller = createPoller({ token: '', dataDir: tmpdir(), onAlert: () => assert.fail('should not emit'), fetcher: async () => assert.fail('should not fetch') });
  await poller.pollOnce();
  assert.deepEqual(poller.status(), { enabled: false, status: 'disabled', lastSuccessMs: null, error: null });
});

test('security notifications use inbox data only and do not request Dependabot details', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'orb-github-'));
  const calls: string[] = [];
  const alerts: unknown[] = [];
  const securityNotification = {
    ...notification,
    reason: 'security_alert',
    subject: {
      title: 'Dependabot alert',
      type: 'RepositoryVulnerabilityAlert',
      url: 'https://api.github.com/repos/acme/orb/dependabot/alerts/17'
    }
  };
  const poller = createPoller({
    token: 'test-pat',
    dataDir,
    onAlert: (alert) => alerts.push(alert),
    fetcher: fetcher(calls, securityNotification)
  });
  try {
    await poller.pollOnce();
    assert.deepEqual(alerts, [{
      id: 'thread-1',
      kind: 'securityAlert',
      title: 'Dependabot alert',
      url: 'https://github.com/acme/orb/security/dependabot/17',
      repository: 'acme/orb',
      owner: 'acme',
      organization: 'acme',
      repositoryName: 'orb'
    }]);
    assert.equal(poller.status().status, 'ok');
    assert.deepEqual(calls.map((url) => new URL(url).pathname), ['/notifications']);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('ci_activity and other inbox notifications are mapped from the inbox alone', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'orb-github-'));
  const calls: string[] = [];
  const alerts: unknown[] = [];
  const workflowNotification = {
    ...notification,
    reason: 'ci_activity',
    subject: {
      title: 'CI status changed',
      type: 'CheckSuite',
      url: 'https://api.github.com/repos/acme/orb/check-suites/1'
    }
  };
  try {
    const poller = createPoller({ token: 'test-pat', dataDir, onAlert: (alert) => alerts.push(alert),
      fetcher: fetcher(calls, workflowNotification) });
    await poller.pollOnce();
    assert.deepEqual(alerts, [{
      id: 'thread-1',
      kind: 'workflowFailure',
      title: 'CI status changed',
      url: 'https://github.com/acme/orb/actions',
      repository: 'acme/orb',
      owner: 'acme',
      organization: 'acme',
      repositoryName: 'orb'
    }]);
    assert.deepEqual(calls.map((url) => new URL(url).pathname), ['/notifications']);

    const genericDir = await mkdtemp(join(tmpdir(), 'orb-github-'));
    const genericCalls: string[] = [];
    const genericAlerts: unknown[] = [];
    try {
      const generic = createPoller({
        token: 'test-pat',
        dataDir: genericDir,
        onAlert: (alert) => genericAlerts.push(alert),
        fetcher: fetcher(genericCalls, {
          ...notification,
          reason: 'mention',
          subject: { title: 'Please review this issue', type: 'Issue', url: 'https://api.github.com/repos/acme/orb/issues/8' }
        })
      });
      await generic.pollOnce();
      assert.deepEqual(genericAlerts, [{
        id: 'thread-1',
        kind: 'githubNotification',
        title: 'Please review this issue',
        url: 'https://github.com/acme/orb',
        repository: 'acme/orb',
        owner: 'acme',
        organization: 'acme',
        repositoryName: 'orb'
      }]);
      assert.deepEqual(genericCalls.map((url) => new URL(url).pathname), ['/notifications']);
    } finally {
      await rm(genericDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('agent session completion is reported as a Copilot completion signal', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'orb-github-'));
  const alerts: unknown[] = [];
  try {
    const poller = createPoller({
      token: 'test-pat',
      dataDir,
      onAlert: (alert) => alerts.push(alert),
      fetcher: fetcher([], { ...notification, reason: 'agent_session_finished' })
    });
    await poller.pollOnce();
    assert.deepEqual(alerts, [{
      id: 'thread-1', kind: 'agentSessionFinished', title: 'Copilot done',
      url: 'https://github.com/acme/orb', repository: 'acme/orb',
      owner: 'acme', organization: 'acme', repositoryName: 'orb'
    }]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
