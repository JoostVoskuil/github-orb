import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../../dashboard/serve.js';
import type { ObserverMessage } from '../../observer/observer-protocol.js';

export async function eventually<T>(read: () => T | Promise<T>, done: (value: T) => boolean,
  label: string, timeout = 5000): Promise<T> {
  const deadline = performance.now() + timeout;
  let last: T | undefined;
  while (performance.now() < deadline) {
    last = await read();
    if (done(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

export async function permissionFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orb-permissions-'));
  const token = 'local-permission-test';
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const dashboard = createDashboardServer({ token, githubPoller: false, usbSetup: false, dataDir: root });
  const listen = async (server: http.Server) => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return address.port;
  };
  const dashboardPort = await listen(dashboard);
  const base = `http://127.0.0.1:${dashboardPort}`;
  const messages: Array<{ message: ObserverMessage; at: number }> = [];
  const replies: Array<{ status: number; body: Record<string, unknown> }> = [];
  // The relay records the real wire contract; hooks are used only by adversarial tests.
  const hooks: {
    beforeReply?: (message: ObserverMessage) => void | Promise<void>;
    reply?: (message: ObserverMessage, body: Record<string, unknown>) => Record<string, unknown>;
  } = {};
  const relay = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      const message = JSON.parse(body) as ObserverMessage;
      messages.push({ message, at: performance.now() });
      const upstream = await fetch(`${base}/event`, { method: 'POST', headers, body });
      const accepted = await upstream.json() as Record<string, unknown>;
      await hooks.beforeReply?.(message);
      const response = hooks.reply?.(message, accepted) ?? accepted;
      replies.push({ status: upstream.status, body: response });
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch {
      res.writeHead(500);
      res.end('{}');
    }
  });
  const relayPort = await listen(relay);
  const configPath = join(root, 'orb.json');
  await writeFile(configPath, JSON.stringify({ host: '127.0.0.1', port: relayPort, token }), { mode: 0o600 });
  const previous = new Map(['ORB_CONFIG', 'ORB_HOST', 'ORB_PORT', 'ORB_TOKEN'].map(key => [key, process.env[key]]));
  for (const key of previous.keys()) delete process.env[key];
  process.env.ORB_CONFIG = configPath;
  return {
    root, configPath, headers, base, hooks, messages, replies,
    endpoint: { host: '127.0.0.1', port: relayPort, token },
    state: () => fetch(`${base}/state`, { headers }).then(res => res.json()),
    async post(path: string, value: unknown) {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(value) });
      return { status: response.status, body: await response.json() };
    },
    async close() {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await Promise.all([relay, dashboard].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
      await rm(root, { recursive: true, force: true });
    }
  };
}