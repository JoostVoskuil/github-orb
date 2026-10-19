import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createDashboardServer } from '../../dashboard/serve.js';
import { eventually, permissionFixture } from './permission-fixture.js';

// Opt-in: uses an existing SDK installation, never installs or contacts a model service.
test('actual SDK loads the observer and forwards tool lifecycle to the dashboard', {
  skip: !process.env.ORB_SDK_ASSETS, timeout: 60_000
}, async () => {
  const assets = process.env.ORB_SDK_ASSETS!;
  const { CopilotClient, RuntimeConnection } = await import(pathToFileURL(join(assets, 'copilot-sdk/index.js')).href);
  const root = await mkdtemp(join(tmpdir(), 'orb-sdk-test-'));
  const dashboard = createDashboardServer({ token: 'sdk-test', githubPoller: false, usbSetup: false });
  let calls = 0;
  const model = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const step = calls++;
    const tool = step < 2;
    const delta = tool
      ? { role: 'assistant', tool_calls: [{ index: 0, id: `probe-call-${step}`, type: 'function',
        function: step === 0 ? { name: 'orb_probe', arguments: '{}' }
          : { name: 'ask_user', arguments: JSON.stringify({ question: 'Synthetic test input', choices: ['OK'], allowFreeform: false }) } }] }
      : { role: 'assistant', content: 'OK' };
    if (!request.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `probe-${calls}`, object: 'chat.completion',
        choices: [{ index: 0, message: delta, finish_reason: tool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const choice of [
      { index: 0, delta, finish_reason: null },
      { index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }
    ]) res.write(`data: ${JSON.stringify({ id: `probe-${calls}`, object: 'chat.completion.chunk', choices: [choice] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await Promise.all([dashboard, model].map(server => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))));
  function port(server: http.Server): number {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return address.port;
  }
  const snapshot = () => fetch(`http://127.0.0.1:${port(dashboard)}/state`, {
    headers: { Authorization: 'Bearer sdk-test' }
  }).then(res => res.json());
  const extensionDirectory = join(root, '.github/extensions/github-orb');
  await mkdir(extensionDirectory, { recursive: true });
  const config = join(root, 'orb.json');
  await writeFile(config, JSON.stringify({ host: '127.0.0.1', port: port(dashboard), token: 'sdk-test' }), { mode: 0o600 });
  await writeFile(join(extensionDirectory, 'extension.mjs'), `
import { joinSession } from '@github/copilot-sdk/extension';
import { observeSession } from ${JSON.stringify(new URL('../../observer/observer.js', import.meta.url).href)};
process.env.ORB_CONFIG = ${JSON.stringify(config)};
await observeSession(await joinSession());
`);
  const client = new CopilotClient({
    mode: 'empty', baseDirectory: join(root, 'home'), useLoggedInUser: false, logLevel: 'error',
    connection: RuntimeConnection.forStdio({ path: join(assets, 'prebuilds/darwin-arm64/copilot-runtime') }),
    extensionLaunchProvider: {
      resolve: async (request: { modulePath: string }) => ({
        launch: { executable: process.execPath, args: [join(assets, 'preloads/extension_bootstrap.mjs')],
          env: { EXTENSION_PATH: request.modulePath } }
      })
    }
  });
  const observed: string[] = [];
  let longToolVerified = false;
  let longToolState: { mood: string; sessionCount: number; sessionName?: string } | undefined;
  let inputVerified = false;
  try {
    const session = await client.createSession({
      workingDirectory: root, model: 'gpt-4.1',
      provider: { type: 'openai', baseUrl: `http://127.0.0.1:${port(model)}/v1`, apiKey: 'local-test' },
      availableTools: ['orb_probe', 'ask_user'], disabledMcpServers: ['github-mcp-server'],
      enableConfigDiscovery: true, requestExtensions: true, extensionSdkPath: join(assets, 'copilot-sdk'),
      onPermissionRequest: () => ({ kind: 'approve-once' }),
      onUserInputRequest: async () => {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline && (await snapshot()).mood !== 'needsInput') {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.equal((await snapshot()).mood, 'needsInput');
        inputVerified = true;
        return { answer: 'OK', wasFreeform: false };
      },
      tools: [{
        name: 'orb_probe', description: 'Synthetic local observer test.', parameters: { type: 'object', properties: {} },
        handler: async () => {
          await new Promise(resolve => setTimeout(resolve, 9000));
          const state = await snapshot();
          longToolState = {
            mood: state.mood,
            sessionCount: state.sessionCount,
            sessionName: state.sessions[0]?.name
          };
          longToolVerified = true;
          return 'OK';
        }
      }]
    });
    session.on((event: { type: string }) => observed.push(event.type));
    const deadline = Date.now() + 10000;
    let running = false;
    while (Date.now() < deadline) {
      const list = await session.rpc.extensions.list();
      if (list.extensions.some((e: { status: string }) => e.status === 'running')) { running = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(running, true, 'observer extension must actually join');
    await session.sendAndWait({ prompt: 'Run the synthetic probe.' }, 30000);
    const until = Date.now() + 2000;
    while (Date.now() < until && (await snapshot()).mood !== 'done') {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(longToolVerified, true, JSON.stringify(longToolState));
    assert.equal(longToolState?.mood, 'tool');
    assert.equal(longToolState?.sessionCount, 1);
    assert.equal(longToolState?.sessionName, 'Run the synthetic probe.');
    assert.equal(inputVerified, true);
    assert.ok(observed.includes('tool.execution_start'));
    assert.ok(observed.includes('tool.execution_complete'));
    assert.ok(observed.includes('session.idle'), `Observed lifecycle events: ${observed.join(', ')}`);
    assert.ok(observed.includes('user_input.requested'));
    assert.ok(observed.includes('user_input.completed'));
    assert.equal((await snapshot()).mood, 'done');
  } finally {
    await client.stop();
    await Promise.all([dashboard, model].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await rm(root, { recursive: true, force: true });
  }
});

// Unlike the smoke test, the creator never answers these permission requests.
// Only the joined extension may resolve them through the pending-permission RPC.
for (const decision of ['approve', 'deny'] as const) {
  test(`actual joined SDK observer applies dashboard ${decision} to a pending permission`, {
    skip: !process.env.ORB_SDK_ASSETS, timeout: 60_000
  }, async t => {
    const assets = process.env.ORB_SDK_ASSETS!;
    const { CopilotClient, RuntimeConnection } = await import(pathToFileURL(join(assets, 'copilot-sdk/index.js')).href);
    const f = await permissionFixture();
    let modelCalls = 0;
    let toolCalls = 0;
    let creatorPermissionCalls = 0;
    const model = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const first = modelCalls++ === 0;
      const delta = first
        ? { role: 'assistant', tool_calls: [{ index: 0, id: 'local-gate-call', type: 'function',
          function: { name: 'bash', arguments: '{}' } }] }
        : { role: 'assistant', content: 'Local permission probe finished.' };
      const finish = first ? 'tool_calls' : 'stop';
      if (!request.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: `gate-${modelCalls}`, object: 'chat.completion',
          choices: [{ index: 0, message: delta, finish_reason: finish }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const choice of [{ index: 0, delta, finish_reason: null },
        { index: 0, delta: {}, finish_reason: finish }]) {
        res.write(`data: ${JSON.stringify({ id: `gate-${modelCalls}`, object: 'chat.completion.chunk', choices: [choice] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
    const address = model.address();
    assert.ok(address && typeof address !== 'string');
    const tracePath = join(f.root, 'joined-permission-rpc.jsonl');
    const extensionDirectory = join(f.root, '.github/extensions/github-orb');
    await mkdir(extensionDirectory, { recursive: true });
    await writeFile(join(extensionDirectory, 'extension.mjs'), `
import { appendFile } from 'node:fs/promises';
import { joinSession } from '@github/copilot-sdk/extension';
import { observeSession } from ${JSON.stringify(new URL('../../observer/observer.js', import.meta.url).href)};
process.env.ORB_CONFIG = ${JSON.stringify(f.configPath)};
for (const key of ['ORB_HOST', 'ORB_PORT', 'ORB_TOKEN']) delete process.env[key];
const session = await joinSession();
const trace = value => appendFile(${JSON.stringify(tracePath)}, JSON.stringify(value) + '\\n');
const permissions = session.rpc.permissions;
await trace({ joined: true, pending: typeof permissions.pendingRequests, resolver: typeof permissions.handlePendingPermissionRequest });
const resolve = permissions.handlePendingPermissionRequest.bind(permissions);
permissions.handlePendingPermissionRequest = async params => {
  try {
    const result = await resolve(params);
    await trace({ params, result });
    return result;
  } catch (error) {
    await trace({ params, error: String(error) });
    throw error;
  }
};
await observeSession(session);
`);
    const client = new CopilotClient({
      mode: 'empty', baseDirectory: join(f.root, 'home'), useLoggedInUser: false, logLevel: 'error',
      connection: RuntimeConnection.forStdio({ path: join(assets, 'prebuilds/darwin-arm64/copilot-runtime') }),
      extensionLaunchProvider: {
        resolve: async (request: { modulePath: string }) => ({
          launch: { executable: process.execPath, args: [join(assets, 'preloads/extension_bootstrap.mjs')],
            env: { EXTENSION_PATH: request.modulePath } }
        })
      }
    });
    const trace = async () => {
      try { return (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    };
    const events: Array<{ type: string; data?: unknown }> = [];
    let turn: Promise<unknown> | undefined;
    try {
      const session = await client.createSession({
        workingDirectory: f.root, model: 'gpt-4.1',
        provider: { type: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'local-test' },
        availableTools: ['bash'], disabledMcpServers: ['github-mcp-server'],
        enableConfigDiscovery: true, requestExtensions: true, extensionSdkPath: join(assets, 'copilot-sdk'),
        // This SDK advertises requestPermission only when a callback is present.
        // Unregister it before sending: it must never provide the decision.
        onPermissionRequest: () => { creatorPermissionCalls++; assert.fail('creator must not resolve permission'); },
        tools: [{
          // Overriding bash forces the runtime's custom-tool permission path.
          // No actual shell command is executed, even on approval.
          name: 'bash', description: 'Harmless in-process permission gate.',
          overridesBuiltInTool: true, skipPermission: false,
          parameters: { type: 'object', properties: {} },
          handler: async () => { toolCalls++; return 'Local gate executed.'; }
        }]
      });
      session.registerPermissionHandler(undefined);
      session.on((event: { type: string; data?: unknown }) => events.push({ type: event.type,
        ...(['permission.requested', 'permission.completed', 'tool.execution_complete', 'session.error'].includes(event.type)
          ? { data: event.data } : {}) }));
      await eventually(trace, rows => rows.some(row => row.joined), 'real extension joins', 10000);
      assert.deepEqual((await trace())[0], { joined: true, pending: 'function', resolver: 'function' });
      // Attach a rejection handler immediately so a failed assertion cannot leak an unhandled turn.
      turn = session.sendAndWait({ prompt: 'Call the local bash permission gate once.' }, 25000);
      void turn.catch(() => {});
      let pending: { items: Array<{ requestId: string; request: { kind: string } }> };
      try {
        pending = await eventually(() => session.rpc.permissions.pendingRequests(),
          value => value.items.length > 0, 'actual SDK pending permission', 12000);
      } catch (error) {
        t.diagnostic(JSON.stringify({ modelCalls, toolCalls, events, trace: await trace(), state: await f.state() }));
        throw error;
      }
      assert.equal(toolCalls, 0, 'tool must not execute before a dashboard decision');
      assert.equal(pending.items.length, 1);
      assert.equal(pending.items[0].request.kind, 'custom-tool');
      const state = await eventually(f.state, value => value.sessions.some((s: { attention?: { actionable?: boolean } }) =>
        s.attention?.actionable === true), 'actionable joined-extension card', 5000);
      const view = state.sessions.find((s: { sessionId: string }) => s.sessionId === session.sessionId);
      assert.ok(view?.attention?.actionable);
      assert.equal(view.attention.kind, 'custom-tool');
      assert.equal(view.attention.preview, 'bash');
      assert.equal(typeof view.attention.command, 'string');
      assert.ok(Buffer.byteLength(view.attention.command) <= 1024);
      assert.deepEqual(JSON.parse(view.attention.command), pending.items[0].request,
        'the real SDK card must review every structured permission field');
      assert.equal(view.attention.command, JSON.stringify(JSON.parse(view.attention.command), null, 2),
        'the full request must be pretty printed');
      assert.equal(JSON.stringify([state, f.messages]).includes(pending.items[0].requestId), false);
      const body = { sessionId: session.sessionId, attentionId: view.attention.id, decision };
      assert.deepEqual(await f.post('/permission-decision', body), { status: 202, body: { accepted: true } });
      const rows = await eventually(trace, values => values.some(row => row.result), 'joined resolver returns a real result');
      const resolutions = rows.filter(row => row.params);
      assert.deepEqual(resolutions, [{ params: {
        requestId: pending.items[0].requestId, result: { kind: decision === 'approve' ? 'approve-once' : 'reject' }
      }, result: { success: true } }]);
      await turn;
      await eventually(() => session.rpc.permissions.pendingRequests(), value => value.items.length === 0, 'SDK pending request cleared');
      await eventually(f.state, value => !value.sessions.find((s: { sessionId: string }) => s.sessionId === session.sessionId)?.attention,
        'resolved dashboard card');
      assert.equal(toolCalls, decision === 'approve' ? 1 : 0, 'deny must not invoke the tool');
      assert.equal((await f.post('/permission-decision', body)).status, 409, 'no replay after resolution');
      assert.equal((await trace()).filter(row => row.params).length, 1);
      assert.equal(creatorPermissionCalls, 0, 'creator permission callback must never run');
      t.diagnostic(`joined handlePendingPermissionRequest ${decision}: success=true; tool executions=${toolCalls}; model calls=${modelCalls}`);
    } finally {
      await client.stop();
      await turn?.catch(() => {});
      await new Promise<void>(resolve => model.close(() => resolve()));
      await f.close();
    }
  });
}
