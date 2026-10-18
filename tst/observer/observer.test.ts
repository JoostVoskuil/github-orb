import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ObserverReducer, metadataLabel } from '../../observer/observer-reducer.js';
import { ObserverSender, httpDelivery, httpFanoutDelivery } from '../../observer/observer-sender.js';
import { validObserverMessage, type ObserverMessage } from '../../observer/observer-protocol.js';
import { createDashboardServer } from '../../dashboard/serve.js';
import { observeSession, type ObserverSession } from '../../observer/observer.js';

test('observer keeps overlapping tools, children and attention requests independent', () => {
  const reducer = new ObserverReducer({ now: () => 1000 });
  const send = (type: string, data = {}, agentId?: string) => reducer.accept({ type, data, agentId });
  assert.equal(reducer.current(), null);
  assert.equal(send('session.start'), null);
  assert.deepEqual(send('user.message'), { state: 'thinking', tool: null, activity: 'thinking', busySince: 1000 });
  assert.deepEqual(send('assistant.intent', { intent: 'Evaluating a private change request' }),
    { state: 'thinking', tool: null, activity: 'evaluating', busySince: 1000 });
  assert.deepEqual(send('assistant.intent', { intent: 'Thinking through a private plan' }),
    { state: 'thinking', tool: null, activity: 'thinking', busySince: 1000 });
  send('subagent.started', { toolCallId: 'child' }, 'child-agent');
  send('tool.execution_start', { toolCallId: 'a', toolName: 'bash' });
  send('tool.execution_start', { toolCallId: 'b', toolName: 'test' }, 'child-agent');
  send('permission.requested', { requestId: 'approval' });
  send('elicitation.requested', { requestId: 'form' }, 'child-agent');
  assert.equal(send('tool.execution_complete', { toolCallId: 'a', success: false })?.state, 'needsInput');
  assert.equal(send('permission.completed', { requestId: 'approval' })?.state, 'needsInput');
  assert.equal(send('elicitation.completed', { requestId: 'form' })?.state, 'tool');
  assert.equal(send('tool.execution_complete', { toolCallId: 'b' }, 'child-agent')?.state, 'thinking');
  assert.equal(send('assistant.turn_end')?.state, 'thinking');
  assert.equal(send('assistant.idle')?.state, 'thinking');
  assert.equal(send('subagent.failed', { toolCallId: 'child' }, 'child-agent')?.state, 'thinking');
  assert.equal(send('session.idle')?.state, 'done');
});

test('assistant turn and loop idle do not complete the session', () => {
  const reducer = new ObserverReducer();
  reducer.accept({ type: 'user.message' });
  assert.equal(reducer.accept({ type: 'assistant.turn_end' })?.state, 'thinking');
  assert.equal(reducer.accept({ type: 'assistant.idle', data: { aborted: false } })?.state, 'thinking');
  assert.equal(reducer.accept({ type: 'session.idle', data: { aborted: false } })?.state, 'done');
});

test('only session errors set error; cancelled and initial sessions never report done', () => {
  const r = new ObserverReducer();
  assert.equal(r.accept({ type: 'session.idle' })?.state, 'idle');
  r.accept({ type: 'user.message' });
  assert.equal(r.accept({ type: 'session.error', agentId: 'child' })?.state, 'thinking');
  assert.equal(r.accept({ type: 'session.error' })?.state, 'error');
  assert.equal(r.accept({ type: 'session.idle' })?.state, 'error');
  r.accept({ type: 'user.message' });
  r.accept({ type: 'abort' });
  assert.equal(r.accept({ type: 'session.idle' })?.state, 'idle');
  r.accept({ type: 'user.message' });
  assert.equal(r.accept({ type: 'session.idle', data: { aborted: true } })?.state, 'idle');
});

test('duplicate and reordered events do not resurrect completed tools or requests', () => {
  const r = new ObserverReducer();
  r.accept({ type: 'user.message', id: 'prompt' });
  r.accept({ type: 'tool.execution_complete', data: { toolCallId: 'tool' } });
  assert.equal(r.accept({ type: 'tool.execution_start', data: { toolCallId: 'tool', toolName: 'bash' } })?.state, 'thinking');
  r.accept({ type: 'user_input.completed', data: { requestId: 'q' } });
  assert.equal(r.accept({ type: 'user_input.requested', data: { requestId: 'q' } })?.state, 'thinking');
  r.accept({ type: 'user_input.requested', data: { requestId: 'real' } });
  assert.equal(r.accept({ type: 'session.idle' })?.state, 'needsInput');
  r.accept({ type: 'user_input.completed', data: { requestId: 'real' } });
  assert.equal(r.accept({ type: 'session.idle' })?.state, 'done');
  assert.equal(r.accept({ type: 'user.message', id: 'prompt' })?.state, 'done');
});

test('nested agent completion clears only its own outstanding attention and tools', () => {
  const r = new ObserverReducer();
  r.accept({ type: 'subagent.started', agentId: 'a', data: { toolCallId: 'spawn-a' } });
  r.accept({ type: 'subagent.started', agentId: 'b', data: { toolCallId: 'spawn-b' } });
  r.accept({ type: 'user_input.requested', agentId: 'a', data: { requestId: 'qa' } });
  r.accept({ type: 'user_input.requested', agentId: 'b', data: { requestId: 'qb' } });
  assert.equal(r.accept({ type: 'subagent.completed', agentId: 'a', data: { toolCallId: 'spawn-a', cancelled: true } })?.state, 'needsInput');
  assert.equal(r.accept({ type: 'subagent.completed', agentId: 'b', data: { toolCallId: 'spawn-b' } })?.state, 'thinking');
});

test('metadata labels fit UTF-8 firmware buffers', () => {
  assert.equal(metadataLabel('a\nb', 40), 'a b');
  assert.ok(Buffer.byteLength(metadataLabel('é'.repeat(40), 39)) <= 39);
});

test('assistant intent emits only allowlisted activity labels', () => {
  const reducer = new ObserverReducer({ now: () => 5 });
  for (const [intent, activity] of [
    ['Evaluating sensitive repository details', 'evaluating'],
    ['I am evaluating sensitive repository details', 'evaluating'],
    ['Analysing sensitive repository details', 'analysing'],
    ['Analyzing sensitive repository details', 'analysing'],
    ['I am analyzing sensitive repository details', 'analysing'],
    ['Thinking about a private task', 'thinking']
  ] as const) {
    const status = reducer.accept({ type: 'assistant.intent', data: { intent } });
    assert.deepEqual(status, { state: 'thinking', tool: null, activity, busySince: 5 });
    assert.equal(JSON.stringify(status).includes('sensitive'), false);
  }
});

test('observer aggregates safe agent, model and token metadata across subagents', () => {
  const reducer = new ObserverReducer();
  reducer.accept({ type: 'user.message' });
  reducer.accept({ type: 'session.model_change', data: { newModel: 'GPT-5.4' } });
  const root = reducer.accept({
    type: 'assistant.usage',
    data: { model: 'gpt-5.4', inputTokens: 120, outputTokens: 14 }
  });
  assert.equal(root?.model, 'gpt-5.4');
  assert.equal(root?.inputTokens, 120);
  assert.equal(root?.outputTokens, 14);

  reducer.accept({
    type: 'subagent.started', agentId: 'reviewer',
    data: { toolCallId: 'child-call', agentDisplayName: 'Code reviewer', model: 'claude-sonnet-4.5' }
  });
  const child = reducer.accept({
    type: 'assistant.usage', agentId: 'reviewer',
    data: { modelDisplayName: 'Claude Sonnet', inputTokens: 30, outputTokens: 8 }
  });
  assert.equal(child?.agent, undefined);
  assert.equal(child?.subagent, 'Code reviewer');
  assert.equal(child?.model, 'gpt-5.4');
  assert.equal(child?.inputTokens, 150);
  assert.equal(child?.outputTokens, 22);
  assert.equal(JSON.stringify(child).includes('private'), false);

  const resumed = reducer.accept({
    type: 'subagent.completed', agentId: 'reviewer', data: { toolCallId: 'child-call' }
  });
  assert.equal(resumed?.subagent, undefined);
  assert.equal(resumed?.model, 'gpt-5.4');
  assert.equal(resumed?.inputTokens, 150);
  assert.equal(resumed?.outputTokens, 22);
});

test('sender bounds concurrent work, converges to newest state, and handles ownership loss', async () => {
  const sent: ObserverMessage[] = [];
  let release: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const warnings: string[] = [];
  const sender = new ObserverSender('s1', 'project', async message => {
    sent.push(message);
    if (sent.length === 1) await blocked;
    return null;
  }, message => warnings.push(message));
  sender.update({ state: 'thinking', tool: null });
  for (let i = 0; i < 100; i++) sender.update({ state: 'tool', tool: `tool-${i}` });
  release!();
  await sender.flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].tool, 'tool-99');
  assert.equal(sent.every(validObserverMessage), true);
  await sender.close();
  assert.equal(sent.at(-1)?.event, 'observerEnd');
  const replaced = new ObserverSender('s2', 'project', async () => 'observer_conflict', message => warnings.push(message));
  replaced.update({ state: 'thinking', tool: null });
  await replaced.flush();
  assert.equal(warnings.length, 1);
});

test('sender transmits activity transitions within the thinking state', async () => {
  const sent: ObserverMessage[] = [];
  const sender = new ObserverSender('session', 'project', async message => {
    sent.push(message);
    return null;
  }, assert.fail);
  sender.update({ state: 'thinking', tool: null, activity: 'evaluating' });
  await sender.flush();
  sender.update({ state: 'thinking', tool: null, activity: 'thinking' });
  await sender.flush();
  assert.deepEqual(sent.map(message => message.activity), ['evaluating', 'thinking']);
  await sender.close();
});

test('sender transmits token and model updates without a mood transition', async () => {
  const sent: ObserverMessage[] = [];
  const sender = new ObserverSender('session', 'project', async message => {
    sent.push(message);
    return null;
  }, assert.fail);
  sender.update({ state: 'thinking', tool: null, model: 'GPT-5.4', inputTokens: 20, outputTokens: 5 });
  await sender.flush();
  sender.update({ state: 'thinking', tool: null, model: 'GPT-5.4', inputTokens: 35, outputTokens: 8 });
  await sender.flush();
  assert.deepEqual(sent.map(message => [message.model, message.inputTokens, message.outputTokens]), [
    ['GPT-5.4', 20, 5], ['GPT-5.4', 35, 8]
  ]);
  assert.equal(sent.every(validObserverMessage), true);
  await sender.close();
});

test('delivery failures are bounded and reported, never success-shaped', async () => {
  let attempts = 0;
  const warnings: string[] = [];
  const sender = new ObserverSender('s', 'project', async () => {
    attempts++;
    throw new Error('private-network-detail');
  }, warning => warnings.push(warning));
  sender.update({ state: 'thinking', tool: null });
  await sender.flush();
  assert.equal(attempts, 3);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes('private-network-detail'), false);
});

test('observer fans out without letting an unavailable endpoint stall live destinations', async () => {
  const received: Array<{ authorization: string; message: ObserverMessage }> = [];
  const createEndpoint = (token: string) => http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        authorization: request.headers.authorization ?? '',
        message: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      });
      response.writeHead(202, { 'Content-Type': 'application/json' });
      response.end('{"accepted":true}');
    });
  });
  const first = createEndpoint('first-token');
  const second = createEndpoint('second-token');
  const offline = createEndpoint('offline-token');
  const listen = (server: http.Server) => new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as import('node:net').AddressInfo).port));
  });
  const firstPort = await listen(first);
  const secondPort = await listen(second);
  const offlinePort = await listen(offline);
  await new Promise<void>((resolve) => offline.close(() => resolve()));

  const warnings: string[] = [];
  const sender = new ObserverSender('fanout-session', 'orb-test', httpFanoutDelivery([
    { host: '127.0.0.1', port: firstPort, token: 'first-token' },
    { host: '127.0.0.1', port: offlinePort, token: 'offline-token' },
    { host: '127.0.0.1', port: secondPort, token: 'second-token' }
  ]), warning => warnings.push(warning));
  try {
    const startedAt = Date.now();
    sender.update({ state: 'thinking', tool: null });
    await sender.flush();
    assert.ok(Date.now() - startedAt < 700, 'an offline endpoint must not delay healthy destinations');
    assert.deepEqual(received.map(({ authorization }) => authorization).sort(), [
      'Bearer first-token', 'Bearer second-token'
    ]);
    assert.equal(received.every(({ message }) => message.event === 'observerState'), true);
    assert.equal(received.every(({ message }) => message.sessionId === 'fanout-session'), true);
    assert.equal(warnings.length, 1);
  } finally {
    await sender.close();
    await Promise.all([first, second].map(server =>
      new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    ));
  }
});

test('observer sender drives the real dashboard API with metadata only', async () => {
  const server = createDashboardServer({ token: 'observer-test', githubPoller: false, usbSetup: false });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config = { host: '127.0.0.1', port: address.port, token: 'observer-test' };
  const sender = new ObserverSender('real-session', 'orb-test', httpDelivery(config), assert.fail);
  try {
    const r = new ObserverReducer();
    const intentState = r.accept({
      type: 'assistant.intent',
      data: { intent: 'Evaluating PRIVATE PLAN' }
    });
    assert.ok(intentState);
    sender.update(intentState);
    await sender.flush();
    const intentSnapshot = await fetch(`http://127.0.0.1:${address.port}/state`, {
      headers: { Authorization: `Bearer ${config.token}` }
    }).then(response => response.json());
    assert.equal(intentSnapshot.mood, 'thinking');
    assert.equal(intentSnapshot.task, 'Evaluating');
    assert.equal(JSON.stringify(intentSnapshot).includes('PRIVATE'), false);

    for (const event of [
      { type: 'user.message', data: { content: 'PRIVATE PROMPT' } },
      { type: 'tool.execution_start', data: { toolCallId: 't', toolName: 'bash', arguments: 'PRIVATE COMMAND' } },
      { type: 'user_input.requested', data: { requestId: 'q', question: 'PRIVATE QUESTION' } }
    ]) {
      const state = r.accept(event);
      assert.ok(state);
      sender.update(state);
      await sender.flush();
    }
    const snapshot = await fetch(`http://127.0.0.1:${address.port}/state`, {
      headers: { Authorization: `Bearer ${config.token}` }
    }).then(response => response.json());
    assert.equal(snapshot.mood, 'needsInput');
    assert.equal(snapshot.sessionCount, 1);
    assert.equal(JSON.stringify(snapshot).includes('PRIVATE'), false);
    await sender.close();
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('observer registration does not install permission or input decision handlers', async () => {
  let callback: Parameters<ObserverSession['on']>[0];
  const logs: string[] = [];
  const session: ObserverSession = {
    sessionId: 'session',
    on(handler) { callback = handler; return () => {}; },
    async log(message) { logs.push(message); }
  };
  const old = process.env.ORB_CONFIG;
  process.env.ORB_CONFIG = '/nonexistent/orb-observer-test/config.json';
  try {
    const stop = await observeSession(session);
    assert.ok(callback!);
    await stop();
    assert.equal(logs.length, 1);
  } finally {
    if (old === undefined) delete process.env.ORB_CONFIG;
    else process.env.ORB_CONFIG = old;
  }
});

test('observer forwards only bounded session titles from SDK metadata and title events', async () => {
  const token = 'observer-title-test';
  const server = createDashboardServer({ token, githubPoller: false, usbSetup: false });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const directory = await mkdtemp(join(tmpdir(), 'orb-session-title-'));
  const configPath = join(directory, 'orb.json');
  await writeFile(configPath, JSON.stringify({
    host: '127.0.0.1', port: address.port, token
  }), { mode: 0o600 });
  const previousConfig = process.env.ORB_CONFIG;
  process.env.ORB_CONFIG = configPath;
  let callback: Parameters<ObserverSession['on']>[0];
  const session: ObserverSession = {
    sessionId: 'title-session',
    on(handler) { callback = handler; return () => {}; },
    async log() {},
    rpc: { metadata: { async snapshot() {
      callback!({ type: 'session.title_changed', data: { title: 'SDK session title' } });
      return { workingDirectory: '/workspace/project-folder', initialName: 'Initial session title' };
    } } }
  };
  let stop: (() => Promise<void>) | undefined;
  try {
    stop = await observeSession(session);
    const headers = new Headers();
    headers.set('Authorization', ['Bearer', token].join(' '));
    const readState = () => fetch(`http://127.0.0.1:${address.port}/state`, { headers })
      .then(response => response.json());
    const waitForName = async (name: string) => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const state = await readState();
        if (state.sessions?.[0]?.name === name) return state;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail(`Timed out waiting for session name: ${name}`);
    };
    callback!({ type: 'user.message' });
    assert.equal((await waitForName('SDK session title')).sessions[0].name, 'SDK session title');
    callback!({ type: 'session.title_changed', data: { title: 'Updated session title' } });
    assert.equal((await waitForName('Updated session title')).sessions[0].name, 'Updated session title');
  } finally {
    await stop?.();
    if (previousConfig === undefined) delete process.env.ORB_CONFIG;
    else process.env.ORB_CONFIG = previousConfig;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('custom agent, running subagent, context usage and busy time are tracked separately', () => {
  let now = 1000;
  const r = new ObserverReducer({ now: () => now });
  r.accept({ type: 'subagent.selected', data: { agentName: 'plan', agentDisplayName: 'Planner', tools: null } });
  r.accept({ type: 'user.message' });
  r.accept({ type: 'session.usage_info', data: { tokenLimit: 200_000, currentTokens: 86_000, messagesLength: 4 } });
  now = 5000;
  const child = r.accept({ type: 'subagent.started', agentId: 'c1', data: { toolCallId: 'spawn', agentDisplayName: 'Explore' } });
  assert.equal(child?.agent, 'Planner');
  assert.equal(child?.subagent, 'Explore');
  assert.equal(child?.contextPercent, 43);
  assert.equal(child?.busySince, 1000);
  r.accept({ type: 'subagent.completed', agentId: 'c1', data: { toolCallId: 'spawn' } });
  const done = r.accept({ type: 'session.idle' });
  assert.equal(done?.state, 'done');
  assert.equal(done?.busySince, undefined);
  assert.equal(done?.subagent, undefined);
  assert.equal(r.accept({ type: 'subagent.deselected', data: {} })?.agent, undefined);
});

test('permission attention carries only a bounded kind, intention and preview', () => {
  const r = new ObserverReducer({ nonce: () => '0123456789abcdef' });
  r.accept({ type: 'user.message' });
  const shell = r.accept({ type: 'permission.requested', data: {
    requestId: 'sdk-request-1',
    permissionRequest: { kind: 'shell', fullCommandText: 'ignored' },
    promptRequest: {
      kind: 'commands', intention: `Run the unit tests ${'x'.repeat(200)}`,
      fullCommandText: `npm test -- --grep login ${'y'.repeat(100)}\nexport SECRET_TOKEN=abc`
    }
  } });
  assert.equal(shell?.state, 'needsInput');
  assert.equal(shell?.attention?.id, '0123456789abcdef');
  assert.equal(shell?.attention?.kind, 'shell');
  assert.ok(Buffer.byteLength(shell!.attention!.reason!) <= 80);
  assert.ok(Buffer.byteLength(shell!.attention!.preview!) <= 60);
  assert.ok(shell!.attention!.preview!.startsWith('npm test -- --grep login'));
  assert.equal(JSON.stringify(shell).includes('SECRET'), false);
  assert.equal(JSON.stringify(shell).includes('sdk-request-1'), false);
  assert.ok(validObserverMessage({
    source: 'cli', event: 'observerState', observerVersion: 1, sessionId: 's', instanceId: '11111111-1111-1111-1111-111111111111',
    startedAt: 1, sequence: 1, ...shell, busySince: undefined
  }));

  const cases: Array<[Record<string, unknown>, string, string | undefined]> = [
    [{ kind: 'write', fileName: '/Users/me/private/project/src/login.ts', intention: 'Fix test' }, 'write', 'login.ts'],
    [{ kind: 'read', path: 'C:\\Users\\me\\notes.txt', intention: 'Read' }, 'read', 'notes.txt'],
    [{ kind: 'url', url: 'https://user:pw@example.com/private?q=1', intention: 'Docs' }, 'url', 'example.com'],
    [{ kind: 'mcp', serverName: 'github', toolName: 'create_issue', toolTitle: 'Create issue', args: { secret: 1 } }, 'mcp', 'github/Create issue'],
    [{ kind: 'extension-env-access', names: ['GITHUB_TOKEN'] }, 'other', undefined]
  ];
  for (const [request, kind, preview] of cases) {
    const reducer = new ObserverReducer();
    const state = reducer.accept({ type: 'permission.requested', data: { requestId: 'r', permissionRequest: request } });
    assert.equal(state?.attention?.kind, kind);
    assert.equal(state?.attention?.preview, preview);
    assert.equal(JSON.stringify(state).includes('pw'), false);
    assert.equal(JSON.stringify(state).includes('secret'), false);
  }
});

test('questions, plan reviews and limits are display-only and carry no host text', () => {
  const r = new ObserverReducer();
  r.accept({ type: 'user.message' });
  const question = r.accept({ type: 'user_input.requested', data: { requestId: 'q', question: 'PRIVATE QUESTION', choices: ['a'] } });
  assert.deepEqual([question?.attention?.kind, question?.attention?.reason], ['question', undefined]);
  const plan = r.accept({ type: 'exit_plan_mode.requested', data: { requestId: 'p', summary: 'PRIVATE PLAN', planContent: 'x' } });
  assert.equal(plan?.attention?.kind, 'question');
  assert.equal(plan?.attention?.pending, 2);
  r.accept({ type: 'user_input.completed', data: { requestId: 'q' } });
  assert.equal(r.current()?.attention?.kind, 'plan');
  r.accept({ type: 'exit_plan_mode.completed', data: { requestId: 'p' } });
  assert.equal(r.accept({ type: 'session_limits_exhausted.requested', data: { requestId: 'l' } })?.attention?.kind, 'limits');
  assert.equal(r.accept({ type: 'session_limits_exhausted.completed', data: { requestId: 'l' } })?.state, 'thinking');
  assert.equal(JSON.stringify(plan).includes('PRIVATE'), false);
});

test('sender sends relative busy time', async () => {
  const sent: ObserverMessage[] = [];
  const sender = new ObserverSender('session', 'project', async message => {
    sent.push(message);
    return null;
  }, assert.fail);
  const attention = { id: 'aaaaaaaaaaaaaaaa', kind: 'shell' as const, pending: 1 };
  sender.update({ state: 'needsInput', tool: null, busySince: Date.now() - 5000, attention });
  await sender.flush();
  assert.ok(sent[0].busyForMs! >= 5000 && sent[0].busyForMs! < 6000);
  assert.equal(validObserverMessage(sent[0]), true);
  await sender.close();
});

async function withDashboard(token: string, run: (port: number, configPath: string) => Promise<void>) {
  const server = createDashboardServer({ token, githubPoller: false, usbSetup: false });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const directory = await mkdtemp(join(tmpdir(), 'orb-observer-'));
  const configPath = join(directory, 'orb.json');
  await writeFile(configPath, JSON.stringify({ host: '127.0.0.1', port: address.port, token }), { mode: 0o600 });
  const previous = process.env.ORB_CONFIG;
  process.env.ORB_CONFIG = configPath;
  try {
    await run(address.port, configPath);
  } finally {
    if (previous === undefined) delete process.env.ORB_CONFIG;
    else process.env.ORB_CONFIG = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

test('a pending permission request appears on the Orb as a read-only attention card', async () => {
  const token = 'observer-attention-test';
  await withDashboard(token, async port => {
    let callback: Parameters<ObserverSession['on']>[0];
    const session: ObserverSession = {
      sessionId: 'attention-session',
      on(handler) { callback = handler; return () => {}; },
      async log() {},
      rpc: { permissions: { async pendingRequests() { return { items: [] }; } } }
    };
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const state = () => fetch(`http://127.0.0.1:${port}/state`, { headers }).then(response => response.json());
    const stop = await observeSession(session);
    try {
      callback!({ type: 'user.message' });
      callback!({ type: 'permission.requested', data: {
        requestId: 'sdk-permission-7',
        promptRequest: { kind: 'commands', intention: 'Run tests', fullCommandText: 'npm test' }
      } });
      const pending = await waitFor(state, value => value.sessions?.[0]?.attention !== undefined, 'attention');
      const view = pending.sessions[0];
      assert.equal(view.attention.kind, 'shell');
      assert.equal(view.attention.preview, 'npm test');
      assert.equal(JSON.stringify(pending).includes('sdk-permission-7'), false);
      callback!({ type: 'permission.completed', data: { requestId: 'sdk-permission-7' } });
      await waitFor(state, value => value.sessions?.[0]?.state === 'thinking', 'resolved attention');
    } finally {
      await stop();
    }
  });
});

test('pending prompts listed by the host before the observer started are shown on the Orb', async () => {
  const token = 'observer-optout-test';
  await withDashboard(token, async port => {
    let callback: Parameters<ObserverSession['on']>[0];
    const session: ObserverSession = {
      sessionId: 'optout-session',
      on(handler) { callback = handler; return () => {}; },
      async log() {},
      rpc: { permissions: {
        async pendingRequests() {
          return { items: [{ requestId: 'early', request: { kind: 'url', url: 'https://example.com/x', intention: 'Docs' } }] };
        }
      } }
    };
    const stop = await observeSession(session);
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const state = await waitFor(
        () => fetch(`http://127.0.0.1:${port}/state`, { headers }).then(response => response.json()),
        value => value.sessions?.[0]?.attention !== undefined, 'hydrated attention');
      assert.equal(state.sessions[0].attention.kind, 'url');
      callback!({ type: 'permission.completed', data: { requestId: 'early' } });
    } finally {
      await stop();
    }
  });
});

test('polled pending prompts are added and removed when the host no longer lists them', () => {
  let now = 0;
  const r = new ObserverReducer({ now: () => now });
  assert.equal(r.wantsPermissionPoll(), false);
  r.accept({ type: 'tool.execution_start', data: { toolCallId: 't', toolName: 'orb_gate' } });
  assert.equal(r.wantsPermissionPoll(), true);
  const pending = r.syncPermissions([{ requestId: 'p1', request: { kind: 'custom-tool', toolName: 'orb_gate', toolDescription: 'Gate' } }]);
  assert.deepEqual([pending?.state, pending?.attention?.kind, pending?.attention?.preview], ['needsInput', 'custom-tool', 'orb_gate']);
  now = 1000;
  assert.equal(r.syncPermissions([])?.state, 'needsInput', 'grace period');
  now = 2000;
  assert.equal(r.syncPermissions([])?.state, 'tool');
  r.accept({ type: 'permission.completed', data: { requestId: 'p2' } });
  assert.equal(r.syncPermissions([{ requestId: 'p2', request: { kind: 'shell' } }])?.state, 'tool', 'settled requests stay resolved');
});
