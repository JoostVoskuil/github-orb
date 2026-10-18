import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDashboardServer } from '../../dashboard/serve.js';
import { copilotOrbConfigPath, saveOrbEndpoint } from '../../observer/config-store.js';
import { GitHubPoller } from '../../dashboard/github-poller.js';
import type { OrbConnectionConfig } from '../../observer/config-store.js';
import type { UsbAssetName, UsbAssetUploadProgress, UsbProvisionRequest, UsbSetupService } from '../../dashboard/usb-setup.js';

async function withServer(
  run: (base: string) => Promise<void>,
  usbSetup: UsbSetupService | false = false,
  assetDir?: string,
  orbConfig?: () => Promise<OrbConnectionConfig>,
  firmwareDir?: string
) {
  const server = createDashboardServer({ token: 'test-token', githubPoller: false, usbSetup, assetDir, orbConfig, firmwareDir });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not bind');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function api(base: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', 'Bearer test-token');
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${base}${path}`, { ...init, headers });
  return { response, body: await response.json() };
}

test('dashboard exposes an authenticated ESP32-compatible state API', async () => {
  await withServer(async (base) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).dashboard, true);

    assert.equal((await fetch(`${base}/state`)).status, 401);
    assert.equal((await fetch(`${base}/messages`)).status, 401);
    const event = await api(base, '/event', {
      method: 'POST', body: JSON.stringify({ source: 'vscode', sessionId: 'demo', event: 'UserPromptSubmit' })
    });
    assert.equal(event.response.status, 202);
    assert.equal(event.body.accepted, true);

    const state = await api(base, '/state');
    assert.equal(state.body.type, 'state');
    assert.equal(state.body.mood, 'thinking');
    assert.equal(state.body.sessions[0].sessionId, 'demo');

    const debug = await api(base, '/messages');
    const eventFields = Object.fromEntries(debug.body.messages[0].fields.map((field: { field: string; value: string }) =>
      [field.field, field.value]));
    assert.equal(eventFields.event, 'UserPromptSubmit');
    assert.equal(eventFields.source, 'vscode');
    assert.equal(eventFields.sessionId, 'demo');
    assert.equal('sessionId' in debug.body.messages[0], false);

    const settings = await api(base, '/settings', {
      method: 'PUT', body: JSON.stringify({ volume: 2, brightness: 0.01 })
    });
    assert.equal(settings.body.volume, 1);
    assert.equal(settings.body.brightness, 0.05);
    assert.equal((await api(base, '/settings')).body.volume, 1);

    assert.equal((await api(base, '/github/status')).body.status, 'disabled');
    assert.equal((await fetch(`${base}/github/acknowledge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'a' })
    })).status, 401);
    const invalidAck = await api(base, '/github/acknowledge', { method: 'POST', body: JSON.stringify({ id: '' }) });
    assert.equal(invalidAck.response.status, 400);
    assert.equal(invalidAck.body.error, 'invalid_alert_id');
    const staleAck = await api(base, '/github/acknowledge', { method: 'POST', body: JSON.stringify({ id: 'missing' }) });
    assert.equal(staleAck.response.status, 409);
    assert.equal(staleAck.body.error, 'alert_changed');
    const ota = await api(base, '/ota', { method: 'POST' });
    assert.equal(ota.response.status, 403);
    assert.equal(ota.body.error, 'forbidden');
  });
});

test('dashboard streams a local firmware upload to the configured Orb OTA endpoint', async () => {
  const firmware = Buffer.from([0xe9, 1, 2, 3, 4]);
  let received = Buffer.alloc(0);
  let receivedAuthorization = '';
  const orb = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received = Buffer.concat(chunks);
      receivedAuthorization = request.headers.authorization ?? '';
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, restarting: true }));
    });
  });
  await new Promise<void>((resolve) => orb.listen(0, '127.0.0.1', resolve));
  const address = orb.address();
  if (!address || typeof address === 'string') throw new Error('Orb test server did not bind');

  try {
    await withServer(async (base) => {
      const headers = {
        Origin: base,
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/octet-stream'
      };
      const response = await fetch(`${base}/ota`, { method: 'POST', headers, body: firmware });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, restarting: true });
      assert.deepEqual(received, firmware);
      assert.equal(receivedAuthorization, 'Bearer orb-secret');

      const invalid = await fetch(`${base}/ota`, {
        method: 'POST',
        headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'text/plain' },
        body: 'not firmware'
      });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error, 'invalid_firmware_size');
    }, false, undefined, async () => ({
      host: '127.0.0.1',
      port: address.port,
      token: 'orb-secret'
    }));
  } finally {
    await new Promise<void>((resolve, reject) => orb.close((error) => error ? reject(error) : resolve()));
  }
});

test('dashboard selects and serves the newest firmware binary from its firmware directory', async () => {
  const firmwareDir = await mkdtemp(join(tmpdir(), 'orb-firmware-'));
  const oldFirmware = Buffer.from([0xe9, 1]);
  const latestFirmware = Buffer.from([0xe9, 2, 3]);
  await writeFile(join(firmwareDir, 'older.bin'), oldFirmware);
  await writeFile(join(firmwareDir, 'newest.bin'), latestFirmware);
  await utimes(join(firmwareDir, 'older.bin'), 1_700_000_000, 1_700_000_000);
  await utimes(join(firmwareDir, 'newest.bin'), 1_800_000_000, 1_800_000_000);
  try {
    await withServer(async (base) => {
      const headers = { Origin: base, 'Sec-Fetch-Site': 'same-origin' };
      const metadata = await fetch(`${base}/firmware/latest`, { method: 'HEAD', headers });
      assert.equal(metadata.status, 200);
      assert.equal(metadata.headers.get('X-Firmware-Name'), 'newest.bin');
      assert.equal(metadata.headers.get('Content-Length'), String(latestFirmware.length));

      const download = await fetch(`${base}/firmware/latest`, { headers });
      assert.equal(download.status, 200);
      assert.equal(download.headers.get('X-Firmware-Name'), 'newest.bin');
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), latestFirmware);
    }, false, undefined, undefined, firmwareDir);
  } finally {
    await rm(firmwareDir, { recursive: true, force: true });
  }
});

test('debug messages show payload values while excluding unknown secret fields', async () => {
  await withServer(async (base) => {
    const privateTitle = 'do not log this session title';
    const payload = {
      source: 'cli', event: 'observerState', observerVersion: 1,
      sessionId: 'debug-1234567890', instanceId: '11111111-1111-1111-1111-111111111111',
      startedAt: 1000, sequence: 1, state: 'thinking', activity: 'analysing',
      agent: 'Code reviewer', model: 'GPT-5.4', inputTokens: 320, outputTokens: 42,
      tool: null, sessionName: privateTitle, apiKey: 'synthetic-secret'
    };
    const posted = await api(base, '/event', { method: 'POST', body: JSON.stringify(payload) });
    assert.equal(posted.response.status, 202);

    const response = await api(base, '/messages');
    const message = response.body.messages[0];
    assert.equal(message.accepted, true);
    const fields = Object.fromEntries(message.fields.map((field: { field: string; value: string }) =>
      [field.field, field.value]));
    assert.equal(fields.event, 'observerState');
    assert.equal(fields.source, 'cli');
    assert.equal(fields.state, 'thinking');
    assert.equal(fields.activity, 'analysing');
    assert.equal(fields.agent, 'Code reviewer');
    assert.equal(fields.model, 'GPT-5.4');
    assert.equal(fields.inputTokens, '320');
    assert.equal(fields.outputTokens, '42');
    assert.equal(fields.sessionId, payload.sessionId);
    assert.equal(fields.sessionName, privateTitle);
    assert.equal('sessionName' in message, false);
    assert.equal('apiKey' in fields, false);
    assert.equal(response.body.messages.length, 1);
    assert.equal(JSON.stringify(message).includes(privateTitle), true);
    assert.equal(JSON.stringify(message).includes('synthetic-secret'), false);
  });
});

test('unknown observer events are rejected without changing state or appearing in debug messages', async () => {
  await withServer(async (base) => {
    const unsupported = await api(base, '/event', {
      method: 'POST', body: JSON.stringify({ source: 'cli', event: 'observerUnsupported' })
    });
    assert.equal(unsupported.response.status, 400);
    assert.equal(unsupported.body.error, 'invalid_observer_event');

    const state = await api(base, '/state');
    assert.equal(state.body.mood, 'idle');
    assert.equal(state.body.sessionCount, 0);
    assert.equal((await api(base, '/messages')).body.messages.length, 0);
  });
});

test('event route validates payloads and reports malformed and oversized bodies', async () => {
  await withServer(async (base) => {
    const invalid = await api(base, '/event', { method: 'POST', body: '{' });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.body.error, 'invalid_json');

    const oversized = await api(base, '/event', { method: 'POST', body: JSON.stringify({ event: 'x'.repeat(5000) }) });
    assert.equal(oversized.response.status, 413);
    assert.equal(oversized.body.error, 'payload_too_large');

    const rejected = await api(base, '/event', { method: 'POST', body: JSON.stringify({ source: 'other', event: 'Stop' }) });
    assert.equal(rejected.response.status, 202);
    assert.equal(rejected.body.accepted, false);
  });
});

test('same-origin browser requests can use the UI without exposing the API token', async () => {
  await withServer(async (base) => {
    const url = new URL(base);
    const response = await fetch(`${base}/state`, {
      headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin' }
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).mood, 'idle');
    assert.equal(url.hostname, '127.0.0.1');
  });
});

test('dashboard UI can save a private GitHub token and switch the observer to the local dashboard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orb-dashboard-local-'));
  const oldEnv = {
    copilotHome: process.env.COPILOT_HOME,
    publishedPort: process.env.ORB_DASHBOARD_PUBLISHED_PORT,
    githubPat: process.env.ORB_GITHUB_PAT
  };
  process.env.COPILOT_HOME = join(directory, 'copilot');
  process.env.ORB_DASHBOARD_PUBLISHED_PORT = '17421';
  delete process.env.ORB_GITHUB_PAT;

  const poller = new GitHubPoller({
    dataDir: join(directory, 'data'),
    onAlert: () => {},
    fetcher: async () => new Response('[]', { status: 200 })
  });
  const server = createDashboardServer({
    token: 'test-token',
    dataDir: join(directory, 'data'),
    githubPoller: poller,
    usbSetup: false
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not bind');

  try {
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { Origin: base, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
    const save = await fetch(`${base}/github/token`, {
      method: 'PUT', headers, body: JSON.stringify({ token: 'ghp-dashboard-test-token' })
    });
    const saveBody = await save.json();
    assert.equal(save.status, 200);
    assert.equal(saveBody.source, 'saved');
    assert.equal(JSON.stringify(saveBody).includes('ghp-dashboard-test-token'), false);
    const githubPath = join(directory, 'data', 'github-token.json');
    assert.equal(JSON.parse(await readFile(githubPath, 'utf8')).token, 'ghp-dashboard-test-token');
    assert.equal((await stat(githubPath)).mode & 0o777, 0o600);

    await saveOrbEndpoint({
      id: 'orb', host: '192.0.2.55', port: 7420, token: 'physical-test-token'
    }, copilotOrbConfigPath());
    const install = await fetch(`${base}/setup/install-dashboard-observer`, {
      method: 'POST', headers, body: '{}'
    });
    const installBody = await install.json();
    assert.equal(install.status, 200);
    assert.equal(installBody.host, '127.0.0.1');
    assert.equal(installBody.port, 17421);
    assert.match(installBody.extensionPath, /\/extensions\/github-orb\/extension\.mjs$/);
    const orbConfig = JSON.parse(await readFile(copilotOrbConfigPath(), 'utf8'));
    assert.deepEqual({ host: orbConfig.host, port: orbConfig.port, token: orbConfig.token },
      { host: '127.0.0.1', port: 17421, token: 'test-token' });
    assert.deepEqual(orbConfig.endpoints, [
      { id: 'orb', host: '192.0.2.55', port: 7420, token: 'physical-test-token' },
      { id: 'dashboard', host: '127.0.0.1', port: 17421, token: 'test-token' }
    ]);

    const clear = await fetch(`${base}/github/token`, {
      method: 'PUT', headers, body: JSON.stringify({ token: '' })
    });
    assert.equal(clear.status, 200);
    assert.equal((await clear.json()).source, 'none');
    await assert.rejects(readFile(githubPath), { code: 'ENOENT' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
    if (oldEnv.copilotHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = oldEnv.copilotHome;
    if (oldEnv.publishedPort === undefined) delete process.env.ORB_DASHBOARD_PUBLISHED_PORT;
    else process.env.ORB_DASHBOARD_PUBLISHED_PORT = oldEnv.publishedPort;
    if (oldEnv.githubPat === undefined) delete process.env.ORB_GITHUB_PAT;
    else process.env.ORB_GITHUB_PAT = oldEnv.githubPat;
  }
});

test('dashboard provisions a selected USB Orb and uploads published assets only for a same-origin local UI', async () => {
  let received: UsbProvisionRequest | undefined;
  const uploaded: Array<{ portId: string; name: UsbAssetName; size: number; bytes: Buffer }> = [];
  let uploadProgressState: UsbAssetUploadProgress | null = null;
  const usbSetup: UsbSetupService = {
    async listPorts() {
      return [{ id: 'orb-1', path: '/dev/orb-1', label: 'GitHub Orb', serialNumber: 'abc', vendorId: '303A', productId: '1001' }];
    },
    async provision(request) {
      received = request;
      return { host: '192.168.1.69', port: 7420, configSaved: true };
    },
    async installObserver(portId) {
      assert.equal(portId, 'orb-1');
      return {
        host: '192.168.1.69',
        port: 7420,
        configPath: '/home/test/.copilot/orb/config.json',
        extensionPath: '/home/test/.copilot/extensions/github-orb/extension.mjs'
      };
    },
    async uploadAsset(portId, name, size, source) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of source) chunks.push(chunk);
      uploaded.push({ portId, name, size, bytes: Buffer.concat(chunks) });
    },
    async uploadFirmware() { throw new Error('unexpected_firmware_upload'); },
    getAssetUploadProgress() {
      return uploadProgressState;
    },
    async restart(portId) {
      assert.equal(portId, 'orb-1');
    }
  };
  const assetDir = await mkdtemp(join(tmpdir(), 'orb-dashboard-assets-'));
  const animationBytes = Buffer.from([0x4f, 0x52, 0x42, 0x41, 1, 2, 3]);
  const soundBytes = Buffer.from('{"version":1,"sounds":{}}');
  await writeFile(join(assetDir, 'animations.orb'), animationBytes);
  await writeFile(join(assetDir, 'sounds.json'), soundBytes);
  try {
    await withServer(async (base) => {
    const headers = { Origin: base, 'Sec-Fetch-Site': 'same-origin' };
    const malformed = await fetch(`${base}/setup/provision`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ portId: 7 })
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error, 'invalid_request');

    const ports = await fetch(`${base}/setup/ports`, { headers });
    assert.equal(ports.status, 200);
    assert.equal((await ports.json()).ports[0].id, 'orb-1');
    const uploadProgress = await fetch(`${base}/setup/assets/progress`, { headers });
    assert.equal(uploadProgress.status, 200);
    assert.deepEqual(await uploadProgress.json(), { progress: null });
    uploadProgressState = { name: 'animations.orb', size: 1024, sent: 512, phase: 'transferring' };
    const activeUploadProgress = await fetch(`${base}/setup/assets/progress`, { headers });
    assert.deepEqual(await activeUploadProgress.json(), { progress: uploadProgressState });

    const forbidden = await fetch(`${base}/setup/ports`, { headers: { Authorization: 'Bearer test-token' } });
    assert.equal(forbidden.status, 403);

    for (const [name, bytes] of [['animations.orb', animationBytes], ['sounds.json', soundBytes]] as const) {
      const asset = await fetch(`${base}/setup/assets?portId=orb-1&name=${name}`, {
        method: 'POST',
        headers
      });
      assert.equal(asset.status, 200);
      assert.deepEqual(await asset.json(), { uploaded: name, size: bytes.length });
      assert.deepEqual(uploaded.at(-1), { portId: 'orb-1', name, size: bytes.length, bytes });
    }

    const invalidAsset = await fetch(`${base}/setup/assets?portId=orb-1&name=firmware.bin`, {
      method: 'POST', headers
    });
    assert.equal(invalidAsset.status, 400);
    assert.equal((await invalidAsset.json()).error, 'invalid_asset');

    const restart = await fetch(`${base}/setup/restart`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ portId: 'orb-1' })
    });
    assert.equal(restart.status, 200);
    assert.deepEqual(await restart.json(), { restarting: true });

    const forbiddenUpload = await fetch(`${base}/setup/assets?portId=orb-1&name=animations.orb`, {
      method: 'POST'
    });
    assert.equal(forbiddenUpload.status, 403);

    const provision = await fetch(`${base}/setup/provision`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ portId: 'orb-1', wifiSsid: 'Test WiFi', wifiPassword: 'not-a-real-password' })
    });
    assert.equal(provision.status, 200);
    const result = await provision.json();
    assert.deepEqual(result, { host: '192.168.1.69', port: 7420, configSaved: true });
    assert.equal('token' in result, false);
    assert.deepEqual(received, { portId: 'orb-1', wifiSsid: 'Test WiFi', wifiPassword: 'not-a-real-password' });

    const installObserver = await fetch(`${base}/setup/install-observer`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ portId: 'orb-1' })
    });
    assert.equal(installObserver.status, 200);
    const installResult = await installObserver.json();
    assert.equal('token' in installResult, false);
    assert.match(installResult.configPath, /\/\.copilot\/orb\/config\.json$/);
    assert.match(installResult.extensionPath, /\/\.copilot\/extensions\/github-orb\/extension\.mjs$/);
    }, usbSetup, assetDir);
  } finally {
    await rm(assetDir, { recursive: true, force: true });
  }
});
