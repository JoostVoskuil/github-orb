import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createDashboardServer } from '../../dashboard/serve.js';
import { DEMO_ALERT, DEMO_STEPS } from '../../dashboard/demo-sequence.js';
import { validObserverMessage } from '../../observer/observer-protocol.js';
import type { UsbSetupService } from '../../dashboard/usb-setup.js';

interface Received {
  method: string;
  path: string;
  authorization: string;
  body: Record<string, unknown> | null;
}

async function withOrbAndDashboard(
  health: Record<string, unknown>,
  run: (base: string, received: Received[]) => Promise<void>,
  savedConnection = true
) {
  const received: Received[] = [];
  const orb = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const path = request.url ?? '';
      received.push({
        method: request.method ?? '', path, authorization: request.headers.authorization ?? '',
        body: text ? JSON.parse(text) : null
      });
      const reply = path === '/health' ? health
        : path === '/state' ? { sessions: [{ sessionId: 'someone-else' }], alert: { id: 'old-alert' } }
        : path === '/github/simulate' ? { id: 'demo-1' }
        : { accepted: true };
      response.writeHead(path === '/github/simulate' ? 202 : 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => orb.listen(0, '127.0.0.1', resolve));
  const orbAddress = orb.address();
  if (!orbAddress || typeof orbAddress === 'string') throw new Error('Orb did not bind');
  const server = createDashboardServer({
    token: 'test-token', githubPoller: false, demoTimeScale: 0.001,
    usbSetup: savedConnection ? false : {
      readOrbConnection: async () => ({ host: '127.0.0.1', port: orbAddress.port, token: 'orb-secret' })
    } as unknown as UsbSetupService,
    orbConfig: async () => {
      if (!savedConnection) throw new Error('no_observer_destinations');
      return { host: '127.0.0.1', port: orbAddress.port, token: 'orb-secret' };
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Dashboard did not bind');
  try {
    await run(`http://127.0.0.1:${address.port}`, received);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => orb.close(() => resolve()));
  }
}

function local(base: string, method = 'GET') {
  return fetch(`${base}/setup/demo`, { method, headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin' } });
}

test('dashboard demo plays sleeping, session, question, done, then a Mona security alert on the Orb', async () => {
  await withOrbAndDashboard({ status: 'ok', alertSimulation: true }, async (base, received) => {
    assert.equal((await fetch(`${base}/setup/demo`, { method: 'POST' })).status, 403);

    const start = await local(base, 'POST');
    assert.equal(start.status, 202);
    const started = await start.json();
    assert.equal(started.running, true);
    assert.equal(started.otherSessions, 1);
    assert.deepEqual(started.steps, DEMO_STEPS.map((step) => step.label));
    assert.ok(started.durationMs >= 35_000 && started.durationMs <= 45_000);
    assert.equal((await local(base, 'POST')).status, 409);

    let status = started;
    for (let attempt = 0; attempt < 100 && !status.finished; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await (await local(base)).json();
    }
    assert.equal(status.finished, true);
    assert.equal(status.error, null);

    assert.ok(received.every((request) => request.authorization === 'Bearer orb-secret'));
    assert.deepEqual(received.slice(0, 3).map((request) => `${request.method} ${request.path}`),
      ['GET /health', 'GET /state', 'POST /github/acknowledge']);
    assert.deepEqual(received[2].body, { id: 'old-alert' });

    const events = received.filter((request) => request.path === '/event').map((request) => request.body!);
    assert.ok(events.every((event) => validObserverMessage(event)), JSON.stringify(events));
    assert.deepEqual(events.map((event) => event.state ?? event.event),
      ['thinking', 'tool', 'needsInput', 'thinking', 'tool', 'done', 'observerEnd']);
    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal((events[2].attention as unknown as Record<string, unknown>).kind, 'question');
    assert.equal(events[0].sessionName, 'Session one');
    assert.ok(events.every((event) => !('activity' in event)), 'demo uses only Working and Executing');

    const alertIndex = received.findIndex((request) => request.path === '/github/simulate');
    assert.ok(received.findIndex((request) => request.body?.state === 'done') < alertIndex);
    assert.ok(alertIndex < received.findIndex((request) => request.body?.event === 'observerEnd'));
    assert.deepEqual(received[alertIndex].body, DEMO_ALERT);

    const stopped = await (await local(base, 'DELETE')).json();
    assert.equal(stopped.running, false);
    assert.equal(stopped.finished, false);
    assert.deepEqual(received.at(-1)?.body, { id: 'demo-1' });
  });
});

test('dashboard demo refuses firmware that cannot show a demo Mona alert', async () => {
  await withOrbAndDashboard({ status: 'ok' }, async (base, received) => {
    const response = await local(base, 'POST');
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'mona_simulation_unsupported');
    assert.deepEqual(received.map((request) => request.path), ['/health']);
  });
});

test('dashboard demo reaches a USB-attached Orb when no observer destination is saved', async () => {
  await withOrbAndDashboard({ status: 'ok', alertSimulation: true }, async (base, received) => {
    const response = await local(base, 'POST');
    assert.equal(response.status, 202);
    assert.equal((await response.json()).running, true);
    assert.equal(received[0].authorization, 'Bearer orb-secret');
    await local(base, 'DELETE');
  }, false);
});
