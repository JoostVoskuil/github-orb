import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createDashboardServer } from '../../dashboard/serve.js';

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
