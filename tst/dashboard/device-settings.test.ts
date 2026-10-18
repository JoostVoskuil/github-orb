import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createDashboardServer } from '../../dashboard/serve.js';
import { parseDeviceSettingsUpdate, type DeviceSettingsUpdate } from '../../dashboard/device-settings.js';

const settings = {
  sound: true,
  volume: 0.35,
  brightness: 0.65,
  quietHours: { enabled: true, start: '23:00', end: '07:30' },
  timezone: 'CET-1CEST,M3.5.0,M10.5.0/3',
  githubPollSec: 90,
  githubConfigured: true
};

test('physical settings validation accepts complete settings, preserves omitted PATs, and rejects invalid values', () => {
  const { githubConfigured, ...update } = settings;
  assert.deepEqual(parseDeviceSettingsUpdate(update), update);
  assert.deepEqual(parseDeviceSettingsUpdate({ ...update, githubPat: '' }), { ...update, githubPat: '' });
  assert.deepEqual(parseDeviceSettingsUpdate({ ...update, githubPat: 'test-pat', token: 'never-forward' }), {
    ...update, githubPat: 'test-pat'
  });
  for (const invalid of [
    {}, null, { ...update, sound: 'true' }, { ...update, volume: 2 }, { ...update, volume: NaN },
    { ...update, brightness: 0 }, { ...update, quietHours: { enabled: true, start: '25:00', end: '07:00' } },
    { ...update, quietHours: { enabled: true } }, { ...update, timezone: ' ' },
    { ...update, timezone: 'UTC0\n' }, { ...update, githubPollSec: 29 }, { ...update, githubPollSec: 3601 },
    { ...update, githubPollSec: 60.5 }, { ...update, githubPat: null }, { ...update, githubPat: 'x'.repeat(513) },
    { ...update, githubPat: 'test pat' }
  ]) assert.equal(parseDeviceSettingsUpdate(invalid), null);
});

test('physical settings proxy authenticates, persists to the Orb, preserves secrets, and reports failures', async () => {
  let saved = structuredClone(settings);
  let savedPat = 'existing-test-pat';
  let dashboardDestination = false;
  let upstreamStatus = 200;
  let malformed = false;
  const writes: DeviceSettingsUpdate[] = [];
  const orb = http.createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer device-test-token');
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/health') {
      response.end(JSON.stringify({ status: 'ok', dashboard: dashboardDestination }));
      return;
    }
    assert.equal(request.url, '/settings');
    if (upstreamStatus !== 200) {
      response.writeHead(upstreamStatus);
      response.end(JSON.stringify({ error: 'upstream-error-must-not-leak', githubPat: savedPat }));
      return;
    }
    if (request.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const update: DeviceSettingsUpdate = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      writes.push(update);
      if (update.githubPat !== undefined) savedPat = update.githubPat;
      saved = { ...update, githubConfigured: !!savedPat };
    }
    response.end(malformed ? '{}' : JSON.stringify({ ...saved, githubPat: savedPat, token: 'never-return' }));
  });

  await new Promise<void>((resolve) => orb.listen(0, '127.0.0.1', resolve));
  const address = orb.address();
  if (!address || typeof address === 'string') throw new Error('Orb did not bind');
  const dashboard = createDashboardServer({
    githubPoller: false,
    usbSetup: false,
    orbConfig: async () => ({ host: '127.0.0.1', port: address.port, token: 'device-test-token' })
  });
  await new Promise<void>((resolve) => dashboard.listen(0, '127.0.0.1', resolve));
  const dashboardAddress = dashboard.address();
  if (!dashboardAddress || typeof dashboardAddress === 'string') throw new Error('Dashboard did not bind');
  const base = `http://127.0.0.1:${dashboardAddress.port}`;
  const headers = { Origin: base, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
  const request = (body?: unknown) => fetch(`${base}/setup/settings`, {
    method: body ? 'PUT' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {})
  });
  try {
    assert.equal((await fetch(`${base}/setup/settings`)).status, 403);
    assert.equal((await fetch(`${base}/setup/settings`, {
      method: 'PUT', headers: { ...headers, Origin: 'https://example.com' }, body: JSON.stringify(settings)
    })).status, 403);
    const loaded = await request();
    assert.equal(loaded.status, 200);
    assert.deepEqual(await loaded.json(), settings);

    const { githubConfigured, ...update } = settings;
    const changed = { ...update, brightness: 0.8, githubPat: 'replacement-test-pat', token: 'do-not-forward' };
    const updated = await request(changed);
    assert.equal(updated.status, 200);
    assert.deepEqual(await updated.json(), { ...update, brightness: 0.8, githubConfigured: true });
    assert.equal(savedPat, 'replacement-test-pat');
    assert.equal('token' in writes[0], false);
    assert.equal(JSON.stringify(await (await request()).json()).includes('replacement-test-pat'), false);

    assert.equal((await request(update)).status, 200);
    assert.equal(savedPat, 'replacement-test-pat', 'blank UI PAT must be omitted to preserve the saved value');
    assert.equal('githubPat' in writes.at(-1)!, false);
    const removed = await request({ ...update, githubPat: '' });
    assert.equal((await removed.json()).githubConfigured, false);
    assert.equal(savedPat, '');

    assert.equal((await request({ ...update, githubPollSec: 0 })).status, 400);
    assert.equal(writes.length, 3);
    const invalidJson = await fetch(`${base}/setup/settings`, { method: 'PUT', headers, body: '{' });
    assert.equal(invalidJson.status, 400);
    assert.deepEqual(await invalidJson.json(), { error: 'invalid_json' });

    upstreamStatus = 401;
    const denied = await request(update);
    assert.equal(denied.status, 502);
    assert.deepEqual(await denied.json(), { error: 'orb_unauthorized' });
    upstreamStatus = 500;
    assert.deepEqual(await (await request(update)).json(), { error: 'orb_settings_rejected' });
    upstreamStatus = 200;
    malformed = true;
    assert.deepEqual(await (await request()).json(), { error: 'invalid_orb_response' });
    malformed = false;
    dashboardDestination = true;
    const self = await request(update);
    assert.equal(self.status, 409);
    assert.deepEqual(await self.json(), { error: 'destination_is_dashboard' });
    assert.equal(writes.length, 3, 'dashboard destinations must be rejected before writing');
  } finally {
    await new Promise<void>((resolve) => dashboard.close(() => resolve()));
    await new Promise<void>((resolve) => orb.close(() => resolve()));
  }
});

test('physical audio test is local-only, authenticated, does not mutate settings, and reports device errors', async () => {
  let audioStatus = 202;
  let audioResult: unknown = { scheduled: true };
  let dashboardDestination = false;
  let tests = 0;
  const orb = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer audio-test-token');
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/health') {
      response.end(JSON.stringify({ status: 'ok', dashboard: dashboardDestination }));
    } else if (request.url === '/settings') {
      assert.equal(request.method, 'GET');
      response.end(JSON.stringify(settings));
    } else {
      assert.equal(request.url, '/audio/test');
      assert.equal(request.method, 'POST');
      tests++;
      response.writeHead(audioStatus);
      response.end(JSON.stringify(audioResult));
    }
  });
  await new Promise<void>(resolve => orb.listen(0, '127.0.0.1', resolve));
  const address = orb.address();
  if (!address || typeof address === 'string') throw new Error('Orb did not bind');
  const dashboard = createDashboardServer({
    githubPoller: false, usbSetup: false,
    orbConfig: async () => ({ host: '127.0.0.1', port: address.port, token: 'audio-test-token' })
  });
  await new Promise<void>(resolve => dashboard.listen(0, '127.0.0.1', resolve));
  const dashboardAddress = dashboard.address();
  if (!dashboardAddress || typeof dashboardAddress === 'string') throw new Error('Dashboard did not bind');
  const base = `http://127.0.0.1:${dashboardAddress.port}`;
  const headers = { Origin: base, 'Sec-Fetch-Site': 'same-origin' };
  const request = () => fetch(`${base}/setup/audio/test`, { method: 'POST', headers });
  try {
    assert.equal((await fetch(`${base}/setup/audio/test`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${base}/setup/audio/test`, { headers })).status, 405);
    assert.equal(tests, 0);
    const scheduled = await request();
    assert.equal(scheduled.status, 202);
    assert.deepEqual(await scheduled.json(), { scheduled: true });
    for (const error of ['sound_muted', 'quiet_hours_active', 'sound_assets_unavailable', 'audio_busy']) {
      audioStatus = 409;
      audioResult = { error };
      const rejected = await request();
      assert.equal(rejected.status, 409);
      assert.deepEqual(await rejected.json(), { error });
    }
    audioStatus = 404;
    assert.deepEqual(await (await request()).json(), { error: 'audio_test_unsupported' });
    audioStatus = 401;
    assert.deepEqual(await (await request()).json(), { error: 'orb_unauthorized' });
    audioStatus = 202;
    audioResult = { ok: true };
    assert.deepEqual(await (await request()).json(), { error: 'invalid_orb_response' });
    audioResult = { scheduled: true };
    dashboardDestination = true;
    const previous = tests;
    assert.deepEqual(await (await request()).json(), { error: 'destination_is_dashboard' });
    assert.equal(tests, previous);
  } finally {
    await new Promise<void>(resolve => dashboard.close(() => resolve()));
    await new Promise<void>(resolve => orb.close(() => resolve()));
  }
});
