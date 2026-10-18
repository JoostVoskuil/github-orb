import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { OrbEngine } from '../../dashboard/orb-engine.js';
import { validObserverMessage, type ObserverMessage } from '../../observer/observer-protocol.js';
import { createDashboardServer } from '../../dashboard/serve.js';

const catalog = JSON.parse(await readFile(new URL('../../../protocol/emotions.json', import.meta.url), 'utf8'));
const instanceId = '11111111-1111-1111-1111-111111111111';
function message(sequence: number, input: Partial<ObserverMessage> = {}): ObserverMessage {
  return { source: 'cli', event: 'observerState', observerVersion: 1, sessionId: 'one', instanceId,
    startedAt: 1000, sequence, state: 'tool', tool: 'bash', project: 'test', ...input };
}

test('explicit tool state never becomes needsInput and remains until explicitly ended', () => {
  const e = new OrbEngine(catalog);
  assert.equal(e.handleObserver(message(1), 0), null);
  assert.equal(e.state(9000).mood, 'tool');
  e.handleObserver(message(1, { sessionId: 'two', tool: 'npm' }), 10000);
  const before = e.state(10000);
  const after = e.state(55001);
  assert.equal(after.sessionCount, 2);
  assert.equal(after.tool, before.tool);
  assert.equal(after.presentationId, before.presentationId);
  assert.equal(e.handleEvent({ source: 'cli', sessionId: 'one', event: 'Stop' }, 20001), false);
  assert.equal(e.handleObserver(message(2, { event: 'observerEnd' }), 65001), null);
  assert.equal(e.state(65001).sessionCount, 1);
});

test('observer activity changes the thinking label without changing the thinking mood', () => {
  const e = new OrbEngine(catalog);
  assert.equal(e.handleObserver(message(1, { state: 'thinking', tool: null, activity: 'evaluating' }), 0), null);
  const evaluating = e.state(0);
  assert.equal(evaluating.mood, 'thinking');
  assert.equal(evaluating.task, 'Evaluating');
  assert.equal(evaluating.sessions[0].activity, 'Evaluating');
  assert.equal(evaluating.clip, 'thinking');

  assert.equal(e.handleObserver(message(2, { state: 'thinking', tool: null, activity: 'analysing' }), 1), null);
  const analysing = e.state(1);
  assert.equal(analysing.mood, 'thinking');
  assert.equal(analysing.task, 'Analysing');
  assert.equal(analysing.sessions[0].activity, 'Analysing');
  assert.equal(analysing.clip, 'thinking');
  assert.ok(analysing.presentationId > evaluating.presentationId);

  assert.equal(e.handleObserver(message(3, { state: 'thinking', tool: null, activity: 'thinking' }), 2), null);
  const thinking = e.state(2);
  assert.equal(thinking.mood, 'thinking');
  assert.equal(thinking.task, 'Working');
  assert.equal(thinking.sessions[0].activity, 'Working');
  assert.equal(thinking.clip, 'thinking');
  assert.ok(thinking.presentationId > analysing.presentationId);
});

test('observer exposes selected agent usage without resetting the busy presentation', () => {
  const e = new OrbEngine(catalog);
  assert.equal(e.handleObserver(message(1, {
    state: 'thinking', tool: null, activity: 'thinking',
    agent: 'Code reviewer', model: 'Claude Sonnet', inputTokens: 120, outputTokens: 34
  }), 0), null);
  const initial = e.state(0);
  assert.equal(initial.agent, 'Code reviewer');
  assert.equal(initial.model, 'Claude Sonnet');
  assert.equal(initial.inputTokens, 120);
  assert.equal(initial.outputTokens, 34);
  assert.equal(initial.hasTokenUsage, true);

  assert.equal(e.handleObserver(message(2, {
    state: 'thinking', tool: null, activity: 'thinking',
    inputTokens: 150, outputTokens: 41
  }), 100), null);
  const updated = e.state(100);
  assert.equal(updated.inputTokens, 150);
  assert.equal(updated.outputTokens, 41);
  assert.equal(updated.presentationId, initial.presentationId);
});

test('observer takeover does not retain prior instance telemetry', () => {
  const e = new OrbEngine(catalog);
  e.handleObserver(message(1, {
    state: 'thinking', tool: null, activity: 'thinking',
    agent: 'Code reviewer', model: 'GPT-5.4', inputTokens: 120, outputTokens: 34
  }), 0);
  e.handleObserver(message(1, {
    instanceId: '22222222-2222-2222-2222-222222222222', startedAt: 2000,
    state: 'thinking', tool: null, activity: 'thinking'
  }), 1);
  const state = e.state(1);
  assert.equal(state.agent, 'Copilot');
  assert.equal(state.model, null);
  assert.equal(state.hasTokenUsage, false);
  assert.equal(state.inputTokens, 0);
  assert.equal(state.outputTokens, 0);
});

test('session name takes precedence over project label and follows title changes', () => {
  const e = new OrbEngine(catalog);
  assert.equal(e.handleObserver(message(1, { state: 'thinking', tool: null, sessionName: 'Initial session title' }), 0), null);
  assert.equal(e.state(0).sessions[0].name, 'Initial session title');

  assert.equal(e.handleObserver(message(2, {
    state: 'thinking', tool: null, project: 'renamed-project', sessionName: 'Updated session title'
  }), 1), null);
  assert.equal(e.state(1).sessions[0].name, 'Updated session title');
});

test('same-state updates preserve holds, news and presentation identity', () => {
  const e = new OrbEngine(catalog);
  e.handleObserver(message(1, { state: 'done' }), 0);
  const initial = e.state(0);
  e.handleObserver(message(2, { state: 'done' }), 9000);
  assert.equal(e.state(9000).presentationId, initial.presentationId);
  assert.equal(e.state(10001).mood, 'done');
  e.handleObserver(message(3, { state: 'done' }), 11000);
  assert.equal(e.state(11000).mood, 'done');
  e.setAlert({ id: 'news', kind: 'workflowFailure', title: 'test', url: 'https://github.com/o/r', repository: 'o/r' });
  const news = e.state(11001);
  e.handleObserver(message(4, { state: 'done' }), 12000);
  e.handleObserver(message(5, { state: 'done', project: 'renamed' }), 13000);
  assert.equal(e.state(13000).mascot, 'mona');
  assert.equal(e.state(13000).presentationId, news.presentationId);
  e.handleObserver(message(6, { state: 'thinking' }), 14000);
  assert.equal(e.state(14000).mascot, 'mona');
  assert.equal(e.state(14000).presentationId, news.presentationId);
  assert.equal(e.acknowledgeAlert('news'), true);
  assert.equal(e.state(14000).mascot, 'copilot');
});

test('owner epochs and sequence numbers reject stale writes and allow takeover', () => {
  const e = new OrbEngine(catalog);
  e.handleObserver(message(2), 1);
  assert.equal(e.handleObserver(message(1), 2), 'observer_conflict');
  assert.equal(e.handleObserver(message(2), 3), 'observer_conflict');
  const next = { instanceId: '22222222-2222-2222-2222-222222222222', startedAt: 2000 };
  assert.equal(e.handleObserver(message(1, { ...next, state: 'thinking' }), 4), null);
  assert.equal(e.state(4).sessionCount, 1);
  assert.equal(e.handleObserver(message(3), 5), 'observer_conflict');
  assert.equal(e.handleObserver(message(2, { ...next, event: 'observerEnd' }), 6), null);
  assert.equal(e.state(6).sessionCount, 0);
  assert.equal(e.handleObserver(message(3, { ...next }), 7), 'observer_conflict');
});

test('observer protocol rejects invalid versions, labels, IDs, moods and numeric bounds', () => {
  for (const invalid of [
    { observerVersion: 2 }, { source: 'vscode' }, { state: 'disconnected' }, { state: null },
    { sessionId: 'x'.repeat(96) }, { sessionId: 'x/y' }, { instanceId: 'bad' },
    { sequence: 0 }, { sequence: 0x100000000 }, { sequence: 1.5 }, { startedAt: -1 },
    { startedAt: Number.MAX_SAFE_INTEGER + 1 }, { project: 'é'.repeat(21) },
    { tool: 'x'.repeat(64) }, { project: 'bad\nlabel' }, { project: null },
    { activity: 'private intent text' }, { state: 'tool', activity: 'evaluating' },
    { sessionName: 'x'.repeat(41) }, { sessionName: 'bad\nname' },
    { agent: 'x'.repeat(25) }, { model: 'x'.repeat(33) },
    { inputTokens: -1, outputTokens: 0 }, { inputTokens: 1 },
    { inputTokens: 0x100000000, outputTokens: 0 }
  ]) {
    const payload = { ...message(1), ...invalid };
    assert.equal(validObserverMessage(payload), false, JSON.stringify(invalid));
    assert.equal(new OrbEngine(catalog).handleObserver(payload, 0), 'invalid_observer_event');
  }
  const removedEvent = { ...message(1), event: 'observerPing' };
  assert.equal(validObserverMessage(removedEvent), false);
  assert.equal(new OrbEngine(catalog).handleObserver(removedEvent, 0), 'invalid_observer_event');
});

test('HTTP observer route returns explicit validation, missing and conflict errors', async () => {
  const server = createDashboardServer({ token: 'test', githubPoller: false, usbSetup: false });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const post = (payload: unknown) => fetch(`http://127.0.0.1:${addr.port}/event`, {
    method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  try {
    assert.equal((await post({ ...message(1), event: 'observerPing' })).status, 400);
    assert.equal((await post(message(1))).status, 202);
    assert.equal((await post(message(1))).status, 409);
    assert.equal((await post({ ...message(2), observerVersion: 2 })).status, 400);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

const MIN = 60_000;

test('finished and closed sessions stay done for exactly two minutes, then sleep', () => {
  const e = new OrbEngine(catalog);
  e.handleObserver(message(1, { state: 'thinking', tool: null, sessionName: 'Work' }), 0);
  e.handleObserver(message(2, { state: 'done', tool: null }), 1000);
  let view = e.state(1000).sessions[0];
  assert.deepEqual([view.state, view.ended, view.finished, view.closed], ['done', true, true, false]);
  view = e.state(2 * MIN + 999).sessions[0];
  assert.deepEqual([view.state, view.endedAgoSec], ['idle', 119]);
  assert.equal(e.state(2 * MIN + 999).mood, 'done');
  assert.equal(e.state(2 * MIN + 1000).sessions.length, 0);
  assert.equal(e.state(2 * MIN + 1000).mood, 'idle');
  assert.equal(e.state(2 * MIN + 1000).sessionCount, 1, 'but still live');

  const closed = new OrbEngine(catalog);
  closed.handleObserver(message(1, { state: 'tool' }), 0);
  closed.handleObserver(message(2, { event: 'observerEnd' }), 1000);
  view = closed.state(2000).sessions[0];
  assert.deepEqual([view.closed, view.endedAgoSec, closed.state(2000).sessionCount, closed.state(2000).mood], [true, 1, 0, 'done']);
  assert.equal(closed.state(1000 + 2 * MIN).sessions.length, 0);
});

test('observer sessions remain active without updates until explicitly ended', () => {
  const e = new OrbEngine(catalog);
  e.handleObserver(message(1, { state: 'thinking', tool: null }), 0);
  const active = e.state(15 * MIN);
  assert.deepEqual([active.sessions.length, active.sessions[0].closed, active.sessionCount], [1, false, 1]);
  assert.equal(e.handleObserver(message(2, { event: 'observerEnd' }), 15 * MIN + 1), null);
  const ended = e.state(15 * MIN + 1);
  assert.deepEqual([ended.sessions[0].closed, ended.sessionCount], [true, 0]);
});

test('at most three sessions are displayed with sticky slots; urgent sessions displace ended ones', () => {
  const e = new OrbEngine(catalog);
  const send = (id: string, seq: number, state: string, now: number, extra: Partial<ObserverMessage> = {}) =>
    e.handleObserver(message(seq, { sessionId: id, state: state as ObserverMessage['state'], tool: null, ...extra }), now);
  send('a', 1, 'thinking', 0);
  send('b', 1, 'thinking', 1);
  send('c', 1, 'done', 2);
  send('d', 1, 'idle', 3);
  let state = e.state(10);
  assert.deepEqual(state.sessions.map(s => s.sessionId), ['a', 'b', 'c']);
  assert.equal(state.hiddenSessions, 1);
  send('b', 2, 'tool', 20, { tool: 'bash' });
  state = e.state(20);
  assert.deepEqual(state.sessions.map(s => s.sessionId), ['a', 'b', 'c'], 'state changes do not reorder arcs');
  assert.equal(state.primary, 1);
  send('d', 2, 'needsInput', 30);
  state = e.state(30);
  assert.deepEqual(state.sessions.map(s => s.sessionId), ['a', 'b', 'd']);
  assert.equal(state.primary, 2);
  assert.equal(state.mood, 'needsInput');
});

test('session views carry per-session agent, model, tokens, context and working time', () => {
  const e = new OrbEngine(catalog);
  e.handleObserver(message(1, { sessionId: 'a', state: 'thinking', tool: null, agent: 'Planner', subagent: 'explore',
    model: 'GPT-5.4', inputTokens: 100, outputTokens: 7, contextPercent: 42, busyForMs: 61_000 }), 1_000_000);
  e.handleObserver(message(1, { sessionId: 'b', state: 'tool', tool: 'bash', model: 'Claude' }), 1_000_000);
  const [a, b] = e.state(1_010_000).sessions;
  assert.deepEqual([a.agent, a.subagent, a.model, a.inputTokens, a.outputTokens, a.contextPercent, a.busySec],
    ['Planner', 'explore', 'GPT-5.4', 100, 7, 42, 71]);
  assert.deepEqual([b.agent, b.model, b.inputTokens], [undefined, 'Claude', undefined]);
});

test('observer protocol validates attention privacy rules', () => {
  const attention = { id: '0123456789abcdef', kind: 'shell', pending: 1 };
  assert.equal(validObserverMessage(message(1, { state: 'needsInput', tool: null, attention } as never)), true);
  for (const invalid of [
    { state: 'thinking', attention },
    { state: 'needsInput', attention: { ...attention, id: 'SDK-REQUEST' } },
    { state: 'needsInput', attention: { ...attention, kind: 'secret' } },
    { state: 'needsInput', attention: { ...attention, kind: 'question', reason: 'PRIVATE QUESTION' } },
    { state: 'needsInput', attention: { ...attention, reason: 'x'.repeat(81) } },
    { state: 'needsInput', attention: { ...attention, preview: 'x'.repeat(61) } },
    { state: 'needsInput', attention: { ...attention, pending: 0 } },
    { state: 'needsInput', attention: { ...attention, extra: 'x' } },
    { contextPercent: 101 }, { busyForMs: -1 }, { subagent: 'x'.repeat(25) }
  ]) {
    assert.equal(validObserverMessage({ ...message(1), tool: null, ...invalid }), false, JSON.stringify(invalid));
  }
});
