import assert from 'node:assert/strict';
import test from 'node:test';
import { OrbEngine } from '../../dashboard/orb-engine.js';
import { actionableAttention, permissionTarget } from '../../dashboard/permission.js';

const attention = { id: '0123456789abcdef', kind: 'shell' as const, pending: 1,
  actionable: true, command: 'printf "hello"\nnpm test', preview: 'printf hello', reason: 'Run tests' };
const owner = { source: 'cli', event: 'observerState', observerVersion: 1, sessionId: 'permission-session',
  instanceId: '11111111-1111-1111-1111-111111111111', startedAt: 1000,
  sequence: 1, state: 'needsInput', attention };
const replacement = '22222222-2222-2222-2222-222222222222';

test('permission decisions replay until attention changes and do not extend their 30 second lifetime', () => {
  const orb = new OrbEngine({});
  assert.equal(orb.handleObserver(owner, 1000), null);
  assert.equal(orb.queuePermissionDecision(owner.sessionId, attention.id, 'approve', 1001), true);
  assert.equal(orb.queuePermissionDecision(owner.sessionId, attention.id, 'deny', 1002), false);
  const expected = { attentionId: attention.id, decision: 'approve' };
  for (const sequence of [2, 3]) {
    const update = { ...owner, sequence };
    assert.equal(orb.handleObserver(update, 2000 + sequence), null);
    assert.deepEqual(orb.pendingPermissionDecision(update, 2000 + sequence), expected);
  }
  for (let sequence = 4; sequence <= 30; sequence++) {
    const update = { ...owner, sequence };
    assert.equal(orb.handleObserver(update, sequence * 1000), null);
    assert.deepEqual(orb.pendingPermissionDecision(update, sequence * 1000), expected);
  }
  assert.equal(orb.queuePermissionDecision(owner.sessionId, attention.id, 'approve', 30_999), true);
  assert.deepEqual(orb.pendingPermissionDecision({ ...owner, sequence: 30 }, 31_000), expected);
  assert.equal(orb.pendingPermissionDecision({ ...owner, sequence: 30 }, 31_001), undefined);
});

test('decisions never cross owner instances, sessions, old sequences or observer ends', () => {
  const orb = new OrbEngine({});
  assert.equal(orb.handleObserver(owner, 1000), null);
  assert.equal(orb.queuePermissionDecision(owner.sessionId, attention.id, 'deny', 1001), true);
  for (const update of [
    { ...owner, instanceId: replacement }, { ...owner, startedAt: 2000 },
    { ...owner, sessionId: 'other' }, { ...owner, sequence: 2 }
  ]) assert.equal(orb.pendingPermissionDecision(update, 1002), undefined);
  const next = { ...owner, instanceId: replacement, startedAt: 2000 };
  assert.equal(orb.handleObserver(next, 2000), null);
  assert.equal(orb.pendingPermissionDecision(next, 2001), undefined);
  assert.equal(orb.queuePermissionDecision(owner.sessionId, attention.id, 'approve', 2002), true);
  assert.equal(orb.handleObserver({ ...next, event: 'observerEnd', state: undefined, attention: undefined, sequence: 2 }, 2003), null);
  assert.equal(orb.queuePermissionDecision(owner.sessionId, attention.id, 'deny', 2004), false);
  assert.equal(orb.pendingPermissionDecision(next, 2004), undefined);
});

test('replaced, changed, removed and unactionable attentions invalidate queued decisions', () => {
  for (const patch of [
    { attention: { ...attention, id: 'fedcba9876543210' } },
    { attention: { ...attention, command: 'npm test\nrm -rf ./build' } },
    { attention: { ...attention, reason: 'Changed reason' } },
    { attention: { ...attention, pending: 2 } },
    { attention: { ...attention, actionable: false } },
    { attention: undefined }, { state: 'thinking', attention: undefined }
  ]) {
    const orb = new OrbEngine({});
    assert.equal(orb.handleObserver(owner, 1000), null);
    assert.equal(orb.queuePermissionDecision(owner.sessionId, attention.id, 'approve', 1001), true);
    const next = { ...owner, ...patch, sequence: 2 };
    assert.equal(orb.handleObserver(next, 1002), null);
    assert.equal(orb.pendingPermissionDecision(next, 1003), undefined);
  }
});

test('stale, legacy, read-only and display-only requests cannot queue decisions', () => {
  const orb = new OrbEngine({});
  assert.equal(orb.queuePermissionDecision('missing', attention.id, 'approve', 1000), false);
  for (const a of [undefined, { ...attention, actionable: false },
    { id: attention.id, kind: 'shell', pending: 1 },
    ...['question', 'plan', 'limits'].map(kind => ({ id: attention.id, kind, pending: 1 }))]) {
    const engine = new OrbEngine({});
    assert.equal(engine.handleObserver({ ...owner, attention: a }, 1000), null);
    assert.equal(engine.queuePermissionDecision(owner.sessionId, attention.id, 'deny', 1001), false);
  }
  assert.equal(orb.handleObserver(owner, 1000), null);
  assert.equal(orb.queuePermissionDecision(owner.sessionId, 'fedcba9876543210', 'approve', 1001), false);
  assert.equal(orb.queuePermissionDecision('other', attention.id, 'approve', 1001), false);
  orb.reset();
  assert.equal(orb.pendingPermissionDecision(owner, 1002), undefined);
});

test('decision storage follows the 16-session bound and eviction removes old decisions', () => {
  const orb = new OrbEngine({});
  for (let i = 0; i < 32; i++) {
    const update = { ...owner, sessionId: `session-${i}` };
    assert.equal(orb.handleObserver(update, 1000 + i), null);
    assert.equal(orb.queuePermissionDecision(update.sessionId, attention.id, 'deny', 1000 + i), true);
  }
  assert.equal(orb.pendingPermissionDecision({ ...owner, sessionId: 'session-0' }, 1100), undefined);
  assert.deepEqual(orb.pendingPermissionDecision({ ...owner, sessionId: 'session-31' }, 1100),
    { attentionId: attention.id, decision: 'deny' });
  assert.equal(orb.state(1100).sessionCount, 16);
});

test('stale permission heartbeat refuses new decisions and snapshot controls recover without changing session state', () => {
  const orb = new OrbEngine({});
  assert.equal(orb.handleObserver(owner, 1000), null);
  const fresh = orb.state(1000);
  assert.deepEqual(orb.state(11_000).sessions[0].attention, attention);
  const stale = orb.state(11_001);
  assert.deepEqual(stale.sessions[0], { ...fresh.sessions[0], attention: { ...attention, actionable: false } });
  assert.equal(stale.sessionCount, 1);
  assert.equal(stale.presentationId, fresh.presentationId);
  for (const decision of ['approve', 'deny'] as const) {
    assert.equal(orb.queuePermissionDecision(owner.sessionId, attention.id, decision, 11_001), false);
  }
  assert.notEqual(permissionTarget(stale.sessions[0]), permissionTarget(fresh.sessions[0]));
  const heartbeat = { ...owner, sequence: 2 };
  assert.equal(orb.handleObserver(heartbeat, 12_000), null);
  assert.deepEqual(orb.state(12_000).sessions[0], fresh.sessions[0]);
  assert.equal(orb.state(12_000).presentationId, fresh.presentationId);
  assert.equal(orb.pendingPermissionDecision(heartbeat, 12_000), undefined);
  assert.equal(orb.queuePermissionDecision(owner.sessionId, attention.id, 'deny', 12_001), true);
  assert.deepEqual(orb.pendingPermissionDecision(heartbeat, 12_001), { attentionId: attention.id, decision: 'deny' });
  assert.equal(owner.attention.actionable, true, 'snapshot must not mutate observer input');
});

test('queued decisions expire on stale heartbeat and cannot replay after recovery', () => {
  for (const inspectSnapshot of [false, true]) {
    const orb = new OrbEngine({});
    assert.equal(orb.handleObserver(owner, 1000), null);
    assert.equal(orb.queuePermissionDecision(owner.sessionId, attention.id, 'approve', 1001), true);
    assert.deepEqual(orb.pendingPermissionDecision(owner, 11_000), { attentionId: attention.id, decision: 'approve' });
    if (inspectSnapshot) assert.equal(orb.state(11_001).sessions[0].attention?.actionable, false);
    assert.equal(orb.pendingPermissionDecision(owner, 11_001), undefined);
    assert.equal(orb.queuePermissionDecision(owner.sessionId, attention.id, 'approve', 11_001), false);
    const heartbeat = { ...owner, sequence: 2 };
    assert.equal(orb.handleObserver(heartbeat, 12_000), null);
    assert.equal(orb.pendingPermissionDecision(heartbeat, 12_000), undefined);
    assert.equal(orb.queuePermissionDecision(owner.sessionId, attention.id, 'deny', 12_001), true);
  }
  const orb = new OrbEngine({});
  assert.equal(orb.handleObserver(owner, 1000), null);
  assert.equal(orb.queuePermissionDecision(owner.sessionId, attention.id, 'approve', 1001), true);
  const heartbeat = { ...owner, sequence: 2 };
  assert.equal(orb.handleObserver(heartbeat, 11_001), null);
  assert.equal(orb.pendingPermissionDecision(heartbeat, 11_001), undefined, 'recovery itself must prune stale choices');
});

test('freshness is per observer and leaves fresh remote permissions and non-heartbeating states intact', () => {
  const orb = new OrbEngine({});
  assert.equal(orb.handleObserver(owner, 1000), null);
  const remote = { ...owner, sessionId: 'physical-target', attention: { ...attention, kind: 'mcp' as const,
    command: JSON.stringify({ toolName: 'lookup', arguments: { query: 'full request' } }) } };
  assert.equal(orb.handleObserver(remote, 10_000), null);
  const freshRemote = orb.state(10_000).sessions.find(session => session.sessionId === remote.sessionId)!;
  const snapshot = orb.state(11_001);
  assert.equal(snapshot.sessions.find(session => session.sessionId === owner.sessionId)?.attention?.actionable, false);
  const remoteSnapshot = snapshot.sessions.find(session => session.sessionId === remote.sessionId)!;
  assert.deepEqual(remoteSnapshot, freshRemote);
  assert.equal(permissionTarget(remoteSnapshot), permissionTarget(freshRemote));
  assert.equal(orb.queuePermissionDecision(remote.sessionId, attention.id, 'approve', 11_001), true);
  assert.deepEqual(orb.pendingPermissionDecision(remote, 11_001), { attentionId: attention.id, decision: 'approve' });

  for (const patch of [
    { state: 'thinking', attention: undefined }, { state: 'tool', tool: 'bash', attention: undefined },
    { attention: { ...attention, actionable: false } },
    { attention: { id: attention.id, kind: 'question', pending: 1 } },
    { attention: undefined }
  ]) {
    const engine = new OrbEngine({});
    assert.equal(engine.handleObserver({ ...owner, ...patch }, 1000), null);
    const before = engine.state(1000);
    const after = engine.state(1_000_000);
    assert.deepEqual(after.sessions, before.sessions);
    assert.equal(after.sessionCount, 1);
    assert.equal(after.presentationId, before.presentationId);
  }
});

test('actionability depends on the observer permission, not full-command availability', () => {
  for (const kind of ['shell', 'write', 'read', 'url', 'mcp', 'memory', 'custom-tool', 'other'] as const) {
    const request = { ...attention, kind, command: undefined };
    assert.equal(actionableAttention(request), true);
  }
  assert.equal(actionableAttention({ ...attention, command: '', pending: 0 }), false);
  assert.equal(actionableAttention({ id: attention.id, kind: 'plan', pending: 1, actionable: true }), false);
  assert.notEqual(permissionTarget({ ...owner, observerInstanceId: 'a' }), permissionTarget({ ...owner, observerInstanceId: 'b' }));
});