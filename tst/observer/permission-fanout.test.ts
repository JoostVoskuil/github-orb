import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { httpFanoutDelivery } from '../../observer/observer-sender.js';
import type { ObserverMessage, PermissionDecision } from '../../observer/observer-protocol.js';

const message: ObserverMessage = {
  source: 'cli', observerVersion: 1, event: 'observerState', sessionId: 'fanout-permission',
  instanceId: '11111111-1111-1111-1111-111111111111', startedAt: 1, sequence: 1,
  state: 'needsInput', tool: null,
  attention: { id: 'aaaaaaaaaaaaaaaa', kind: 'shell', command: 'printf probe', actionable: true, pending: 1 }
};

test('fanout waits for every destination before resolving matching or conflicting decisions', async t => {
  for (const first of ['approve', 'deny'] as const) {
    for (const second of ['approve', 'deny', undefined] as const) {
      await t.test(`${first} then ${second ?? 'no decision'}`, async t => {
        const calls: PermissionDecision[] = [];
        const requests: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let arrived!: () => void;
        const waiting = new Promise<void>(resolve => { arrived = resolve; });
        const reply = (decision: typeof second) => new Response(JSON.stringify({ accepted: true,
          ...(decision ? { permissionDecision: { attentionId: message.attention!.id, decision } } : {})
        }), { status: 202, headers: { 'Content-Type': 'application/json' } });
        t.mock.method(globalThis, 'fetch', async (url: string) => {
          requests.push(url);
          if (url.includes(':7421/')) {
            arrived();
            await gate;
            return reply(second);
          }
          return reply(first);
        });
        const deliver = httpFanoutDelivery([7420, 7421].map(port => ({ host: '127.0.0.1', port, token: 'local-test' })),
          async decision => { calls.push(decision); });
        let completed = false;
        const delivery = deliver(message).then(result => { completed = true; return result; });
        try {
          await waiting;
          // Drain the fast endpoint's microtasks while the other reply is deliberately held.
          await setImmediate();
          assert.equal(requests.length, 2);
          assert.equal(completed, false);
          assert.deepEqual(calls, [], 'a fast decision must not win before every endpoint replies');
          release();
          const result = await delivery;
          if (second && first !== second) {
            assert.deepEqual(result, { decisionConflict: true });
            assert.deepEqual(calls, [], 'conflicting choices must never invoke the resolver');
          } else {
            assert.deepEqual(result, {});
            assert.deepEqual(calls, [{ attentionId: message.attention!.id, decision: first }],
              'matching decisions must invoke the resolver exactly once');
          }
        } finally {
          release();
          await delivery;
          t.mock.restoreAll();
        }
      });
    }
  }
});

test('conflicting request remains computer-only after one queued decision expires', async t => {
  const calls: PermissionDecision[] = [];
  let conflicting = true;
  t.mock.method(globalThis, 'fetch', async (url: string) => new Response(JSON.stringify({ accepted: true,
    ...(!url.includes(':7421/') || conflicting ? { permissionDecision: {
      attentionId: message.attention!.id, decision: url.includes(':7421/') ? 'deny' : 'approve'
    } } : {})
  }), { status: 202, headers: { 'Content-Type': 'application/json' } }));
  const deliver = httpFanoutDelivery([7420, 7421].map(port => ({ host: '127.0.0.1', port, token: 'test' })),
    async decision => { calls.push(decision); });
  assert.deepEqual(await deliver(message), { decisionConflict: true });
  conflicting = false;
  assert.deepEqual(await deliver({ ...message, sequence: 2 }), { decisionConflict: true });
  assert.deepEqual(calls, []);
  t.mock.restoreAll();
});