import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDashboardServer } from '../../dashboard/serve.js';

test('observer configuration shows saved destinations, reachability and installation without exposing secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orb-observer-status-'));
  const configPath = join(directory, 'orb/config.json');
  const orb = http.createServer((req, res) => {
    assert.equal(req.url, '/state');
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== 'Bearer test-orb-secret') {
      res.writeHead(401);
      res.end('{"error":"unauthorized"}');
    } else {
      res.end('{"type":"state","sessions":[],"sessionCount":2,"token":"never-return-upstream"}');
    }
  });
  await new Promise<void>(resolve => orb.listen(0, '127.0.0.1', resolve));
  const port = (orb.address() as import('node:net').AddressInfo).port;
  const dashboard = createDashboardServer({ githubPoller: false, usbSetup: false, observerConfigPath: configPath });
  await new Promise<void>(resolve => dashboard.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(dashboard.address() as import('node:net').AddressInfo).port}`;
  const headers = { Origin: base };
  try {
    assert.equal((await fetch(`${base}/setup/observer`)).status, 403);
    assert.equal((await fetch(`${base}/setup/observer`, { headers: { Origin: 'https://example.com' } })).status, 403);
    assert.equal((await fetch(`${base}/setup/observer`, { headers, method: 'POST' })).status, 405);
    const missing = await (await fetch(`${base}/setup/observer`, { headers })).json();
    assert.equal(missing.error, 'config_not_found');
    assert.equal(missing.installed, false);
    await mkdir(join(directory, 'orb'));
    await mkdir(join(directory, 'extensions/github-orb'), { recursive: true });
    await writeFile(join(directory, 'extensions/github-orb/extension.mjs'),
      `process.env.ORB_CONFIG ??= ${JSON.stringify(configPath)}; await observeSession();`);
    await writeFile(configPath, JSON.stringify({ endpoints: [
      { id: 'orb', host: '127.0.0.1', port, token: 'test-orb-secret' },
      { id: 'dashboard', host: '127.0.0.1', port, token: 'wrong-secret' }
    ] }));
    const response = await fetch(`${base}/setup/observer`, { headers });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.installed, true);
    assert.equal(body.error, null);
    assert.deepEqual(body.destinations, [
      { id: 'orb', kind: 'orb', host: '127.0.0.1', port, status: 'reachable', activeSessions: 2 },
      { id: 'dashboard', kind: 'dashboard', host: '127.0.0.1', port, status: 'unauthorized', activeSessions: null }
    ]);
    assert.equal(/secret|never-return-upstream|Bearer/.test(JSON.stringify(body)), false);
    const remove = (destination: unknown, origin = base) => fetch(`${base}/setup/observer`, {
      method: 'DELETE', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(destination)
    });
    const target = { id: 'orb', host: '127.0.0.1', port };
    assert.equal((await remove(target, 'https://example.com')).status, 403);
    assert.equal((await remove({})).status, 400);
    assert.equal((await remove({ ...target, host: 'wrong.local' })).status, 404);
    assert.equal((await remove(target)).status, 200);
    const remaining = await (await fetch(`${base}/setup/observer`, { headers })).json();
    assert.equal(remaining.destinations.length, 1);
    assert.equal(remaining.destinations[0].id, 'dashboard');
    assert.equal((await remove({ ...target, id: 'dashboard' })).status, 200);
    const empty = await (await fetch(`${base}/setup/observer`, { headers })).json();
    assert.equal(empty.error, null);
    assert.deepEqual(empty.destinations, []);
    await writeFile(configPath, '{invalid');
    assert.equal((await (await fetch(`${base}/setup/observer`, { headers })).json()).error, 'invalid_orb_config');
    await writeFile(configPath, JSON.stringify({ host: '127.0.0.1', port, token: 'test-orb-secret' }));
    assert.equal((await (await fetch(`${base}/setup/observer`, { headers })).json()).destinations.length, 1);
    await new Promise<void>(resolve => orb.close(() => resolve()));
    const offline = await (await fetch(`${base}/setup/observer`, { headers })).json();
    assert.equal(offline.destinations[0].status, 'unreachable');
  } finally {
    await new Promise<void>(resolve => dashboard.close(() => resolve()));
    if (orb.listening) await new Promise<void>(resolve => orb.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
