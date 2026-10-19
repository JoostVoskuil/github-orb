import assert from 'node:assert/strict';
import test from 'node:test';
import { ObserverReducer, type LifecycleEvent } from '../../observer/observer-reducer.js';
import { observeSession, type ObserverSession } from '../../observer/observer.js';
import { httpFanoutDelivery } from '../../observer/observer-sender.js';
import {
  validAttention, validObserverMessage, validPermissionCommand, validPermissionDecision,
  type ObserverMessage
} from '../../observer/observer-protocol.js';
import { eventually, permissionFixture } from './permission-fixture.js';

const command = `printf '%s\\n' 'first line with spaces'\n\tprintf '%s\\n' 'second line'\r\nprintf '%s\\n' 'last line'`;
const shell = { kind: 'shell', intention: 'Run harmless regression probe', fullCommandText: command };
type Item = { requestId: string; request: unknown };
type Resolution = { requestId: string; result: { kind: 'approve-once' | 'reject' } };

function fakeSession(items: Item[] = [{ requestId: 'private-sdk-request', request: shell }]) {
  let callback: (event: LifecycleEvent) => void = () => assert.fail('observer has not subscribed');
  let unsubscribed = 0;
  let polls = 0;
  const calls: Resolution[] = [];
  const warnings: string[] = [];
  const pending = { items };
  const permissions = {
    async pendingRequests() { polls++; return { items: [...pending.items] }; },
    async handlePendingPermissionRequest(params: Resolution) {
      calls.push(params);
      pending.items = pending.items.filter(item => item.requestId !== params.requestId);
      return { success: true };
    }
  };
  const session: ObserverSession = {
    sessionId: 'permission-session',
    on(handler) { callback = handler; return () => { unsubscribed++; }; },
    async log(message) { warnings.push(message); },
    rpc: { permissions }
  };
  // Any callback takeover, even an assignment, is a regression.
  for (const name of ['onPermissionRequest', 'onUserInputRequest', 'registerPermissionHandler', 'registerUserInputHandler']) {
    Object.defineProperty(session, name, {
      get() { assert.fail(`observer accessed ${name}`); },
      set() { assert.fail(`observer replaced ${name}`); }
    });
  }
  return { session, permissions, pending, calls, warnings, emit: (event: LifecycleEvent) => callback(event),
    polls: () => polls, unsubscribed: () => unsubscribed };
}

for (const decision of ['approve', 'deny'] as const) {
  test(`observeSession resolves dashboard ${decision} via the pending SDK RPC exactly once`, async () => {
    const f = await permissionFixture();
    const sdk = fakeSession();
    const stop = await observeSession(sdk.session);
    try {
      const state = await eventually(f.state, value => !!value.sessions[0]?.attention, 'actionable permission');
      const attention = state.sessions[0].attention;
      assert.equal(attention.actionable, true);
      assert.equal(attention.command, command, 'review must contain every line, not the shortened preview');
      assert.equal(attention.preview, "printf '%s\\n' 'first line with spaces'");
      assert.match(attention.id, /^[0-9a-f]{16}$/);
      assert.notEqual(attention.id, 'private-sdk-request');
      const body = { sessionId: sdk.session.sessionId, attentionId: attention.id, decision };
      assert.equal((await f.post('/permission-decision', { ...body, attentionId: '0000000000000000' })).status, 409);
      assert.equal((await f.post('/permission-decision', { ...body, sessionId: 'another-session' })).status, 409);
      assert.deepEqual(await f.post('/permission-decision', body), { status: 202, body: { accepted: true } });
      assert.equal((await f.post('/permission-decision', body)).status, 202, 'identical queued decisions are idempotent');
      assert.equal((await f.post('/permission-decision', { ...body, decision: decision === 'approve' ? 'deny' : 'approve' })).status,
        409, 'conflicting queued decisions must not replace the first choice');
      await eventually(() => sdk.calls, calls => calls.length === 1, 'SDK resolution through one-second heartbeat');
      await eventually(f.state, value => !value.sessions[0]?.attention, 'resolved attention removed');
      assert.deepEqual(sdk.calls, [{ requestId: 'private-sdk-request',
        result: { kind: decision === 'approve' ? 'approve-once' : 'reject' } }]);
      const heartbeats = f.messages.filter(({ message }) => message.attention?.id === attention.id);
      assert.ok(heartbeats.length >= 2, 'unchanged actionable state must poll the reverse channel');
      assert.ok(heartbeats[1].at - heartbeats[0].at >= 700);
      assert.ok(heartbeats[1].at - heartbeats[0].at < 2200, 'heartbeat should run each second');
      assert.ok(f.replies.some(reply => reply.status === 202 &&
        JSON.stringify(reply.body.permissionDecision) === JSON.stringify({ attentionId: attention.id, decision })));
      assert.equal((await f.post('/permission-decision', body)).status, 409, 'completed decision cannot be replayed');
      // Replayed host history cannot resurrect an already settled permission.
      sdk.pending.items = [{ requestId: 'private-sdk-request', request: shell }];
      sdk.emit({ type: 'permission.requested', data: { requestId: 'private-sdk-request', promptRequest: shell } });
      assert.equal(sdk.calls.length, 1);
      assert.equal(f.messages.every(({ message }) => validObserverMessage(message)), true);
      assert.equal(JSON.stringify([state, f.messages, f.replies]).includes('private-sdk-request'), false);
      assert.deepEqual(sdk.warnings, []);
    } finally {
      await stop();
      await stop();
      assert.equal(sdk.unsubscribed(), 1);
      await f.close();
    }
  });
}

test('replayed approval for a settled nonce cannot resolve the next pending request', async () => {
  const f = await permissionFixture();
  const sdk = fakeSession([{ requestId: 'sdk-first', request: shell }, { requestId: 'sdk-next', request: shell }]);
  const stop = await observeSession(sdk.session);
  try {
    const state = await eventually(f.state, value => !!value.sessions[0]?.attention, 'first request');
    const firstId = state.sessions[0].attention.id;
    let replayed = 0;
    f.hooks.reply = (message, body) => {
      if (message.attention && message.attention.id !== firstId) {
        replayed++;
        return { accepted: true, permissionDecision: { attentionId: firstId, decision: 'approve' } };
      }
      return body;
    };
    assert.equal((await f.post('/permission-decision', {
      sessionId: sdk.session.sessionId, attentionId: firstId, decision: 'approve'
    })).status, 202);
    await eventually(() => replayed, value => value >= 2, 'old decision replayed on next card and heartbeat');
    const next = (await f.state()).sessions[0].attention;
    assert.notEqual(next.id, firstId);
    assert.deepEqual(sdk.calls, [{ requestId: 'sdk-first', result: { kind: 'approve-once' } }]);
    assert.equal((await f.post('/permission-decision', {
      sessionId: sdk.session.sessionId, attentionId: firstId, decision: 'approve'
    })).status, 409);
    f.hooks.reply = undefined;
    assert.equal((await f.post('/permission-decision', {
      sessionId: sdk.session.sessionId, attentionId: next.id, decision: 'deny'
    })).status, 202);
    await eventually(() => sdk.calls.length, value => value === 2, 'new nonce resolves only its own request');
    assert.deepEqual(sdk.calls[1], { requestId: 'sdk-next', result: { kind: 'reject' } });
  } finally { await stop(); await f.close(); }
});

test('actionable permission cards require both SDK pending and resolver capabilities', async t => {
  for (const capability of ['neither', 'pending-only', 'resolver-only'] as const) {
    await t.test(capability, async () => {
      const f = await permissionFixture();
      const sdk = fakeSession();
      sdk.session.rpc!.permissions = capability === 'neither' ? {} : capability === 'pending-only'
        ? { pendingRequests: sdk.permissions.pendingRequests }
        : { handlePendingPermissionRequest: sdk.permissions.handlePendingPermissionRequest };
      const stop = await observeSession(sdk.session);
      try {
        sdk.emit({ type: 'permission.requested', data: { requestId: 'private-sdk-request', promptRequest: shell } });
        const state = await eventually(f.state, value => !!value.sessions[0]?.attention, 'read-only attention');
        const attention = state.sessions[0].attention;
        assert.equal(attention.actionable, undefined);
        assert.equal(attention.command, undefined);
        assert.equal((await f.post('/permission-decision', {
          sessionId: sdk.session.sessionId, attentionId: attention.id, decision: 'approve'
        })).status, 409);
        assert.deepEqual(sdk.calls, []);
      } finally { await stop(); await f.close(); }
    });
  }
});

test('opt-in reducer preserves full commands, byte boundaries and opaque exact-request nonces', () => {
  let nonce = 0;
  const reducer = new ObserverReducer({ permissionDecisions: true, nonce: () => (++nonce).toString(16).padStart(16, '0') });
  reducer.syncPermissions([{ requestId: 'sdk-a', request: shell }, { requestId: 'sdk-b', request: shell }]);
  const first = reducer.current()!.attention!;
  assert.equal(first.actionable, true);
  assert.equal(first.command, command);
  assert.equal(reducer.permissionRequestId(first.id), 'sdk-a');
  assert.equal(reducer.permissionRequestId('sdk-a'), undefined);
  assert.equal(reducer.matchesPermission(first.id, shell), true);
  assert.equal(reducer.matchesPermission(first.id, { ...shell, fullCommandText: `${command}\nchanged` }), false);
  assert.equal(reducer.matchesPermission(first.id, { ...shell, intention: 'changed intention' }), false);
  reducer.accept({ type: 'permission.completed', data: { requestId: 'sdk-a' } });
  const second = reducer.current()!.attention!;
  assert.notEqual(first.id, second.id);
  assert.equal(reducer.permissionRequestId(first.id), undefined);
  assert.equal(reducer.permissionRequestId(second.id), 'sdk-b');
  for (const fullCommandText of ['x'.repeat(1024), 'é'.repeat(512), command]) {
    const r = new ObserverReducer({ permissionDecisions: true });
    const attention = r.syncPermissions([{ requestId: 'boundary', request: { ...shell, fullCommandText } }])!.attention!;
    assert.equal(attention.actionable, true);
    assert.equal(attention.command, fullCommandText);
    assert.equal(validAttention(attention), true);
  }
});

test('unsupported, oversized and control-character shell requests remain read-only', async t => {
  const requests = [
    { kind: 'extension-env-access', names: ['PRIVATE_TOKEN'] },
    { ...shell, fullCommandText: 'x'.repeat(1025) },
    { ...shell, fullCommandText: 'é'.repeat(513) },
    ...['', ' \t\r\n', 'printf ok\u0000hidden', 'printf ok\u001b[2J', 'printf ok\u007f', 'printf ok\u0085']
      .map(fullCommandText => ({ ...shell, fullCommandText }))
  ];
  for (const [index, request] of requests.entries()) {
    await t.test(`unsafe request ${index}`, async () => {
      const f = await permissionFixture();
      const sdk = fakeSession([{ requestId: 'unsafe', request }]);
      const stop = await observeSession(sdk.session);
      try {
        const state = await eventually(f.state, value => !!value.sessions[0]?.attention, 'read-only unsafe request');
        const attention = state.sessions[0].attention;
        assert.equal(attention.actionable, undefined);
        assert.equal(attention.command, undefined);
        assert.equal((await f.post('/permission-decision', {
          sessionId: sdk.session.sessionId, attentionId: attention.id, decision: 'approve'
        })).status, 409);
        assert.deepEqual(sdk.calls, []);
      } finally { await stop(); await f.close(); }
    });
  }
});

test('non-permission attention stays display-only even with permission decisions enabled', async t => {
  for (const type of ['user_input.requested', 'elicitation.requested', 'exit_plan_mode.requested', 'session_limits_exhausted.requested']) {
    await t.test(type, async () => {
      const f = await permissionFixture();
      const sdk = fakeSession([]);
      const stop = await observeSession(sdk.session);
      try {
        sdk.emit({ type, data: { requestId: 'question', question: 'PRIVATE QUESTION', promptRequest: shell } });
        const state = await eventually(f.state, value => !!value.sessions[0]?.attention, 'display-only request');
        const attention = state.sessions[0].attention;
        assert.equal(attention.actionable, undefined);
        assert.equal(attention.command, undefined);
        assert.equal(JSON.stringify(state).includes('PRIVATE QUESTION'), false);
        assert.equal((await f.post('/permission-decision', {
          sessionId: sdk.session.sessionId, attentionId: attention.id, decision: 'deny'
        })).status, 409);
        assert.deepEqual(sdk.calls, []);
      } finally { await stop(); await f.close(); }
    });
  }
});

test('observer revalidates the host request immediately before applying a queued decision', async t => {
  for (const change of ['removed', 'command', 'kind', 'reason', 'ended'] as const) {
    await t.test(change, async () => {
      const f = await permissionFixture();
      const sdk = fakeSession();
      const stop = await observeSession(sdk.session);
      try {
        const state = await eventually(f.state, value => !!value.sessions[0]?.attention, 'initial request');
        f.hooks.beforeReply = message => {
          if (!message.attention) return;
          if (change === 'ended') sdk.emit({ type: 'session.shutdown' });
          else sdk.pending.items = change === 'removed' ? [] : [{ requestId: 'private-sdk-request',
            request: change === 'command' ? { ...shell, fullCommandText: `${command}\nprintf changed` }
              : change === 'kind' ? { kind: 'read', path: '/tmp/changed' } : { ...shell, intention: 'Changed' } }];
        };
        await f.post('/permission-decision', {
          sessionId: sdk.session.sessionId, attentionId: state.sessions[0].attention.id, decision: 'approve'
        });
        await eventually(() => f.replies, replies => replies.some(reply => !!reply.body.permissionDecision), 'queued decision delivered');
        // A subsequent poll proves the async decision handler has returned, without a blind delay.
        const polls = sdk.polls();
        if (change !== 'ended') await eventually(sdk.polls, value => value > polls, 'post-decision host poll');
        assert.deepEqual(sdk.calls, []);
      } finally { await stop(); await f.close(); }
    });
  }
});

test('resolver exceptions and success:false never claim approval or leak SDK diagnostics', async t => {
  for (const failure of ['throw', 'false', 'pending-throws'] as const) {
    await t.test(failure, async () => {
      const f = await permissionFixture();
      const sdk = fakeSession();
      sdk.permissions.handlePendingPermissionRequest = async params => {
        sdk.calls.push(params);
        if (failure === 'throw') throw new Error('PRIVATE SDK DETAIL');
        sdk.pending.items = [];
        return { success: false };
      };
      const stop = await observeSession(sdk.session);
      try {
        const state = await eventually(f.state, value => !!value.sessions[0]?.attention, 'request');
        if (failure === 'pending-throws') f.hooks.beforeReply = () => {
          sdk.permissions.pendingRequests = async () => { throw new Error('PRIVATE SDK DETAIL'); };
        };
        const body = { sessionId: sdk.session.sessionId, attentionId: state.sessions[0].attention.id, decision: 'approve' };
        assert.equal((await f.post('/permission-decision', body)).status, 202);
        if (failure === 'false') {
          await eventually(f.state, value => !value.sessions[0]?.attention, 'host-resolved stale card removed');
          assert.equal(sdk.calls.length, 1);
        } else {
          await eventually(() => sdk.warnings, warnings => warnings.length > 0, 'safe failure warning');
          assert.equal((await f.state()).sessions[0].attention.id, body.attentionId);
          assert.equal(sdk.calls.length, failure === 'throw' ? 1 : 0);
        }
        assert.equal(JSON.stringify([sdk.warnings, await f.state(), f.messages]).includes('PRIVATE SDK DETAIL'), false);
        assert.equal(f.messages.some(({ message }) => message.state === 'done'), false);
      } finally { await stop(); await f.close(); }
    });
  }
});

test('reverse channel ignores malformed, mismatched, unaccepted and non-actionable decisions', async () => {
  const f = await permissionFixture();
  const decisions: unknown[] = [];
  const deliver = httpFanoutDelivery([f.endpoint], async value => { decisions.push(value); });
  const base: ObserverMessage = {
    source: 'cli', observerVersion: 1, event: 'observerState', sessionId: 'reverse',
    instanceId: '11111111-1111-1111-1111-111111111111', startedAt: 1, sequence: 0,
    state: 'needsInput', tool: null,
    attention: { id: 'aaaaaaaaaaaaaaaa', kind: 'shell', command, actionable: true, pending: 1 }
  };
  try {
    for (const invalid of [null, [], {}, { attentionId: base.attention!.id, decision: 'approve-for-session' },
      { attentionId: 'bbbbbbbbbbbbbbbb', decision: 'approve' },
      { attentionId: base.attention!.id, decision: 'approve', requestId: 'private-sdk-id' }]) {
      f.hooks.reply = () => ({ accepted: true, permissionDecision: invalid });
      await deliver({ ...base, sequence: ++base.sequence });
    }
    const decision = { attentionId: base.attention!.id, decision: 'approve' };
    f.hooks.reply = () => ({ accepted: false, permissionDecision: decision });
    await deliver({ ...base, sequence: ++base.sequence });
    f.hooks.reply = () => ({ accepted: true, permissionDecision: decision });
    await deliver({ ...base, sequence: ++base.sequence, attention: { ...base.attention!, actionable: false } });
    await deliver({ ...base, sequence: ++base.sequence, event: 'observerEnd', attention: undefined });
    assert.deepEqual(decisions, []);
  } finally { await f.close(); }
});

test('decision protocol rejects extra fields and shell review rejects unsafe or truncated commands', () => {
  assert.equal(validPermissionCommand(command), true);
  assert.equal(validPermissionCommand('é'.repeat(513)), false);
  assert.equal(validPermissionCommand('echo\u001b[31m'), false);
  assert.equal(validPermissionDecision({ attentionId: 'aaaaaaaaaaaaaaaa', decision: 'deny' }), true);
  for (const value of [null, [], { attentionId: 'sdk-id', decision: 'approve' },
    { attentionId: 'aaaaaaaaaaaaaaaa', decision: 'approve-once' },
    { attentionId: 'aaaaaaaaaaaaaaaa', decision: 'approve', result: { kind: 'approve-once' } }]) {
    assert.equal(validPermissionDecision(value), false);
  }
  const attention = { id: 'aaaaaaaaaaaaaaaa', kind: 'shell', pending: 1, actionable: true, command };
  assert.equal(validAttention(attention), true);
  for (const changed of [{ command: undefined }, { command: 'x'.repeat(1025) }, { command: '\u0000' }, { kind: 'question' }]) {
    assert.equal(validAttention({ ...attention, ...changed }), false);
  }
});

test('dashboard queues only the exact request for 30 seconds without extending TTL on retries', async t => {
  const f = await permissionFixture();
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let sequence = 0;
  const message = (attention = { id: 'aaaaaaaaaaaaaaaa', kind: 'shell', pending: 1, actionable: true, command },
    instanceId = '11111111-1111-1111-1111-111111111111', startedAt = 1) => ({
    source: 'cli', observerVersion: 1, event: 'observerState', sessionId: 'ttl-session',
    instanceId, startedAt, sequence: ++sequence, state: 'needsInput', tool: null, attention
  });
  const body = { sessionId: 'ttl-session', attentionId: 'aaaaaaaaaaaaaaaa', decision: 'approve' };
  try {
    assert.equal((await f.post('/event', message())).status, 202);
    assert.equal((await f.post('/permission-decision', body)).status, 202);
    assert.equal((await f.post('/permission-decision', { ...body, decision: 'deny' })).status, 409);
    for (let i = 0; i < 3; i++) {
      now += 9_000;
      assert.ok((await f.post('/event', message())).body.permissionDecision);
    }
    now += 2_999;
    assert.equal((await f.post('/permission-decision', body)).status, 202);
    assert.deepEqual((await f.post('/event', message())).body.permissionDecision,
      { attentionId: body.attentionId, decision: body.decision });
    now++;
    assert.equal((await f.post('/event', message())).body.permissionDecision, undefined);
    for (const mutation of ['command', 'nonce', 'owner', 'end'] as const) {
      const initial = { ...message(), sessionId: `ttl-${mutation}` };
      assert.equal((await f.post('/event', initial)).status, 202);
      assert.equal((await f.post('/permission-decision', { ...body, sessionId: initial.sessionId })).status, 202);
      const changed = { ...initial, sequence: ++sequence };
      if (mutation === 'command') changed.attention = { ...changed.attention, command: `${command}\nchanged` };
      if (mutation === 'nonce') changed.attention = { ...changed.attention, id: 'bbbbbbbbbbbbbbbb' };
      if (mutation === 'owner') {
        changed.instanceId = '22222222-2222-2222-2222-222222222222';
        changed.startedAt++;
      }
      if (mutation === 'end') changed.event = 'observerEnd';
      const reply = await f.post('/event', mutation === 'end' ? { ...changed, attention: undefined } : changed);
      assert.equal(reply.status, 202, mutation);
      assert.equal(reply.body.permissionDecision, undefined, mutation);
    }
  } finally { t.mock.restoreAll(); await f.close(); }
});