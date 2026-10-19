import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  Face, APPROVE_BUTTON, DENY_BUTTON, arcSlot, compactCount, duration, sessionStatus
} from '../../dashboard/face.js';

const emotions = JSON.parse(await readFile(new URL('../../../protocol/emotions.json', import.meta.url), 'utf8'));
const attention = { id: '0123456789abcdef', kind: 'shell', reason: 'Run tests', preview: 'npm test', pending: 1 };
const sessions = [
  { source: 'cli', sessionId: 'a', name: 'Review implementation', state: 'thinking', activity: 'Analysing', slot: 0,
    agent: 'Code reviewer', model: 'GPT-5.4', inputTokens: 12_345, outputTokens: 678, busySec: 75 },
  { source: 'cli', sessionId: 'b', name: 'Fix login test', state: 'needsInput', slot: 1, attention },
  { source: 'cli', sessionId: 'c', name: 'Update docs', state: 'thinking', slot: 2 }
];
function face() {
  const f = new Face(emotions);
  f.setState({ mood: 'needsInput', sessions, primary: 1 }, 0);
  return f;
}

test('completion moves selected avatar behind busy work and removes it at two minutes', () => {
  const f = face();
  f.tap(1, 240, 12);
  f.tap(2, 240, 12);
  assert.equal(f.overlay?.key, 'cli:a');
  f.setState({ mood: 'needsInput', primary: 1,
    sessions: [{ ...sessions[0], state: 'done' }, sessions[1], { ...sessions[2], state: 'idle', endedAgoSec: 121 }] }, 3);
  assert.deepEqual(f.state.sessions.map(session => session.sessionId), ['a', 'b']);
  assert.equal(f.state.sessions[0].backgroundOnly, true);
  assert.equal(f.selectedKey, 'cli:b');
  assert.equal(f.overlay, null);
  assert.equal(f.carousel.pose(0, 703).size, 112);
  f.tap(704, 240, 12);
  assert.equal(f.overlay?.key, 'cli:a');
  f.setState({ mood: 'needsInput', primary: 1,
    sessions: [{ ...sessions[0], state: 'done' }, sessions[1]] }, 705);
  assert.equal(f.overlay?.key, 'cli:a', 'background details survive subsequent state refreshes');
  assert.equal(f.selectedKey, 'cli:b');
  f.setState({ mood: 'needsInput', sessions: [
    { ...sessions[0], state: 'idle', finished: true, endedAgoSec: 120 }, sessions[1]
  ] }, 120_003);
  assert.deepEqual(f.state.sessions.map(session => session.sessionId), ['b']);
  assert.equal(f.carousel.pose(0, 120_003).size, 320);
  f.setState({ mood: 'done', sessions: sessions.map(session => ({ ...session, state: 'done' })) }, 4);
  assert.equal(f.state.sessions.length, 0);
  assert.equal(f.selectedKey, null);
  assert.equal(f.splitRing(), false);
  f.setState({ mood: 'thinking', sessions: [sessions[0]] }, 5);
  assert.equal(f.selectedKey, 'cli:a');
  assert.equal(f.state.sessions.length, 1);
});

test('resting draws one idle avatar without restoring expired session avatars', () => {
  const f = face();
  let avatars = 0;
  f.frames = { draw() { avatars++; return true; } };
  f.drawHead = () => { avatars++; };
  const ctx = new Proxy({ measureText: () => ({ width: 10 }), createLinearGradient: () => ({ addColorStop() {} }) },
    { get: (target, key) => target[key] ?? (() => {}) });
  for (const now of [10, 120_010, 240_010]) {
    f.setState({ mood: 'idle', sessions: [{ ...sessions[0], state: 'idle', endedAgoSec: now / 1000 }] }, now);
    f.draw(ctx, now);
  }
  assert.equal(avatars, 3);
  assert.equal(f.state.sessions.length, 0);
  assert.equal(f.selectedKey, null);
  assert.equal(f.splitRing(), false);
  assert.equal(f.state.clip, 'idle');
  f.setState({ mood: 'idle', sessions: [] }, 240_020);
  f.draw(ctx, 240_020);
  assert.equal(avatars, 4);
  f.frames = null;
  f.draw(ctx, 240_030);
  assert.equal(avatars, 5, 'resting retains the procedural fallback without frames');
});

test('completion draws Copilot when no session details are retained', () => {
  const clips: string[] = [];
  const f = new Face(emotions, null, {
    draw(_ctx: unknown, clip: string) { clips.push(clip); return true; }
  });
  f.setState({ mood: 'done', sessions: [] }, 0);
  const ctx = new Proxy({ measureText: () => ({ width: 10 }), createLinearGradient: () => ({ addColorStop() {} }) },
    { get: (target, key) => target[key] ?? (() => {}) });
  f.draw(ctx, 1);
  assert.deepEqual(clips, ['done']);
});
test('split ring hit-testing maps outer taps to the session arc, clockwise from 12 o\'clock', () => {
  assert.equal(arcSlot(240, 12, 3), 0);
  assert.equal(arcSlot(440, 360, 3), 1);
  assert.equal(arcSlot(40, 360, 3), 2);
  assert.equal(arcSlot(240, 240, 3), -1);
  assert.equal(arcSlot(240, 12, 1), 0);
  assert.equal(arcSlot(240, 470, 1), -1);
  assert.equal(arcSlot(40, 360, 2), -1);
  assert.equal(arcSlot(10, 10, 3), -1);
});

test('dots select the animation, a second tap opens information, centre opens selected details', () => {
  const f = face();
  f.tap(1, 240, 12);
  assert.equal(f.mood, 'thinking');
  assert.equal(f.state.clip, 'thinking');
  assert.equal(f.overlay, null);
  f.tap(2, 240, 12);
  assert.deepEqual([f.overlay?.mode, f.overlay?.key], ['session', 'cli:a']);
  f.tap(3, 10, 10);
  assert.equal(f.overlay, null);
  f.tap(4, 440, 360);
  assert.equal(f.mood, 'needsInput');
  assert.deepEqual([f.overlay?.mode, f.overlay?.key], ['approval', 'cli:b']);
  f.tap(6, 240, 120);
  assert.equal(f.overlay?.key, 'cli:c');
});

test('Mona first tap opens notification details and only a tap on the card requests acknowledgement', () => {
  const f = face();
  const alert = { id: 'news-1', kind: 'criticalSecurity', title: 'Critical vulnerability',
    repository: 'octocat/hello', owner: 'octocat', repositoryName: 'hello',
    url: 'https://github.com/octocat/hello/security/dependabot/1' };
  f.setState({ mascot: 'mona', mood: 'securityAlert', clip: 'mona-security', task: 'Security alert',
    ring: { color: '#f85149' }, alert, sessions }, 10);
  f.pointerDown(11, 240, 240);
  assert.equal(f.pointerUp(12), null);
  assert.deepEqual([f.overlay?.mode, f.overlay?.key], ['notification', 'news-1']);
  f.setState({ mascot: 'mona', mood: 'securityAlert', clip: 'mona-security', task: 'Security alert',
    ring: { color: '#f85149' }, alert, sessions: [{ ...sessions[0], state: 'tool' }] }, 13);
  assert.equal(f.overlay?.key, 'news-1');
  assert.equal(f.tap(14, 10, 10), null);
  assert.equal(f.overlay, null);
  f.tap(15, 240, 240);
  f.pointerDown(16, 240, 240);
  assert.equal(f.pointerUp(17), 'news-1');
  assert.equal(f.overlay?.mode, 'notification');
  f.setState({ mascot: 'mona', mood: 'workflowFailure', clip: 'mona-workflow', task: 'Workflow failed',
    alert: { ...alert, id: 'news-2', kind: 'workflowFailure' }, sessions }, 18);
  assert.equal(f.overlay, null);
  assert.equal(f.tap(19, 240, 240), null);
  assert.equal(f.overlay?.key, 'news-2');
  f.setState({ mascot: 'copilot', mood: 'tool', sessions: [sessions[0]], primary: 0 }, 20);
  assert.equal(f.overlay, null);
  f.tap(21, 240, 240);
  assert.equal(f.overlay?.mode, 'session');
});

test('ring selects every session directly while a details or approval card is open', () => {
  const f = face();
  f.tap(0, 240, 240);
  for (const [x, y, key, mode] of [
    [40, 360, 'cli:c', 'session'],
    [240, 12, 'cli:a', 'session'],
    [440, 360, 'cli:b', 'approval'],
    [240, 12, 'cli:a', 'session']
  ] as const) {
    f.pointerDown(10, x, y);
    f.pointerUp(20);
    assert.equal(f.selectedKey, key);
    if (mode !== 'approval') {
      assert.equal(f.overlay, null);
      f.tap(21, x, y);
    }
    assert.deepEqual([f.overlay?.key, f.overlay?.mode], [key, mode]);
  }
});

test('three displayed sessions do not add redundant top source dots', () => {
  const f = face();
  f.state.hiddenSessions = 3;
  const ctx = { fill() { assert.fail('Unexpected top dot'); }, fillText() { assert.fail('Unexpected badge'); } };
  f.drawTopBadge(ctx);
});

test('session dots chase blue while running, flash yellow for input, and fade empty slots', () => {
  const f = face();
  const colors: string[] = [];
  const questions: [string, number, number][] = [];
  const ctx = { fillStyle: '', beginPath() {}, arc() {}, save() {}, restore() {}, fillRect() {},
    fillText(text: string, x: number, y: number) { questions.push([text, x, y]); },
    fill() { colors.push(this.fillStyle); } };
  f.drawSessionArcs(ctx, 1);
  assert.equal(colors.length, 69);
  assert.deepEqual(colors.slice(0, 23), Array.from({ length: 23 }, (_, i) => i >= 10 && i < 15 ? '#2f81f7' : '#30363d'));
  assert.deepEqual(colors.slice(23, 46), Array(23).fill('#f0c020'));
  assert.deepEqual(colors.slice(46), Array.from({ length: 23 }, (_, i) => i >= 10 && i < 15 ? '#2f81f7' : '#30363d'));
  assert.equal(questions.length, 1);
  assert.equal(questions[0][0], '?');
  assert.ok(Math.abs(questions[0][1] - (240 + Math.sqrt(3) * 115)) < 0.01);
  assert.ok(Math.abs(questions[0][2] - 355) < 0.01);
  colors.length = 0;
  f.drawSessionArcs(ctx, 1.5);
  assert.deepEqual(colors.slice(0, 23), Array.from({ length: 23 }, (_, i) => i >= 15 && i < 20 ? '#2f81f7' : '#30363d'));
  assert.deepEqual(colors.slice(23, 46), Array(23).fill('#30363d'));
  f.state.sessions = [{ ...sessions[2], state: 'idle', stateSince: 1000 }];
  colors.length = 0;
  f.drawSessionArcs(ctx, 1);
  assert.deepEqual(colors.slice(0, 23), Array(23).fill('#3fb950'));
  assert.deepEqual(colors.slice(23), Array(46).fill('#30363d'));
  f.setState({ mood: 'idle', sessions: [] }, 2);
  colors.length = 0;
  f.drawRing(ctx, 1000);
  assert.equal(colors.length, 72);
  assert.deepEqual(new Set(colors), new Set(['#30363d']));
});

test('both working states chase and wrap within their own segment; closed sessions stay green', () => {
  const f = face();
  const colors: string[] = [];
  const ctx = { fillStyle: '', beginPath() {}, arc() {}, save() {}, restore() {},
    fill() { colors.push(this.fillStyle); } };
  for (const state of ['thinking', 'tool']) {
    f.state.sessions = [{ ...sessions[0], state }];
    for (const sec of [0, 0.1, 2.2, 2.3]) {
      colors.length = 0;
      f.drawSessionArcs(ctx, sec);
      const offset = Math.floor(sec * 10) % 23;
      assert.deepEqual(colors.slice(0, 23), Array.from({ length: 23 }, (_, i) =>
        (i - offset + 23) % 23 < 5 ? '#2f81f7' : '#30363d'));
      assert.deepEqual(colors.slice(23), Array(46).fill('#30363d'));
    }
  }
  f.state.sessions[0].closed = true;
  colors.length = 0;
  f.drawSessionArcs(ctx, 1);
  assert.deepEqual(colors.slice(0, 23), Array(23).fill('#3fb950'));
});

test('selection survives incoming priority changes, follows session updates, and clears on expiry', () => {
  const f = face();
  f.tap(1, 240, 12);
  assert.equal(f.setState({ mood: 'needsInput', primary: 1, sessions, presentationId: 99 }, 2), false);
  assert.equal(f.mood, 'thinking');
  assert.equal(f.enteredAt, 1);
  f.setState({ mood: 'needsInput', primary: 1, sessions: [{ ...sessions[0], state: 'tool', tool: 'bash' }, ...sessions.slice(1)] }, 3);
  assert.equal(f.mood, 'tool');
  assert.equal(f.state.tool, 'bash');
  f.setState({ mood: 'idle', sessions: [] }, 4);
  assert.equal(f.mood, 'idle');
  assert.equal(f.selectedKey, null);
});

test('only the selected session avatar is drawn, at the front', () => {
  const calls: [string, number][] = [];
  const f = new Face(emotions, null, {
    drawClip(_ctx, mood: string, _now: number, at: number) { calls.push([mood, at]); return true; }
  });
  f.setState({ mood: 'needsInput', sessions, primary: 1 }, 0);
  const ctx = { save() {}, restore() {}, translate() {}, scale() {}, measureText: () => ({ width: 40 }), fillText() {} };
  f.drawCarousel(ctx, 100);
  assert.deepEqual(calls, [['needsInput', 100]]);
  calls.length = 0;
  f.tap(200, 240, 12);
  f.drawCarousel(ctx, 1000);
  assert.deepEqual(calls, [['thinking', 1000]]);
});

test('GitHub completion still temporarily takes over the carousel without replacing its sessions', () => {
  const f = face();
  f.setState({ mascot: 'copilot', copilotNotification: true, mood: 'done', sessions, primary: 1 }, 10);
  assert.equal(f.mood, 'done');
  assert.equal(f.splitRing(), false);
  f.tap(11, 394, 258);
  assert.equal(f.overlay, null);
  f.setState({ mascot: 'copilot', copilotNotification: false, mood: 'needsInput', sessions, primary: 1 }, 10_010);
  assert.equal(f.mood, 'needsInput');
  assert.equal(f.splitRing(), true);
});

test('caption puts activity and small tool above Copilot, and title below', () => {
  const f = face();
  f.setState({ mood: 'tool', sessions: [{ ...sessions[0], state: 'tool', tool: 'bash' }] }, 0);
  const labels: [string, number, string][] = [];
  const ctx = { font: '', save() {}, restore() {}, measureText: () => ({ width: 100 }),
    fillText(text: string, _x: number, y: number) { labels.push([text, y, this.font]); } };
  f.drawCaption(ctx);
  assert.deepEqual(labels.map(([text, y]) => [text, y]), [['Executing', 64], ['bash', 90], ['Review implementation', 408]]);
  assert.match(labels[1][2], /14px/);
});

test('session ring stays visible while details are shown', () => {
  const f = face();
  f.tap(0, 240, 12);
  f.tap(1, 240, 12);
  const calls: string[] = [];
  f.drawSessionArcs = () => calls.push('ring');
  f.drawSessionCard = () => calls.push('card');
  const ctx = { save() {}, restore() {}, beginPath() {}, arc() {}, fill() {} };
  f.drawOverlay(ctx, 100);
  assert.deepEqual(calls, ['ring', 'card']);
});

test('approval cards are read-only and direct the user to the computer', () => {
  const f = face();
  const texts: string[] = [];
  const ctx = new Proxy({
    fillText(text: string) { texts.push(text); },
    measureText(text: string) { return { width: text.length * 8 }; }
  }, { get: (target, key) => target[key] ?? (() => {}) });
  f.drawApprovalCard(ctx, sessions[1]);
  assert.ok(texts.includes('Answer on computer'));
  assert.ok(!texts.some((text) => ['Allow', 'Deny'].includes(text)));
  assert.equal('onDecision' in f, false);
});

test('long holds do not act on approval cards and ring taps still navigate afterward', () => {
  const f = face();
  f.tap(0, 240, 240);
  f.pointerDown(10, 240, 240);
  f.pointerUp(5010);
  assert.deepEqual([f.overlay?.mode, f.overlay?.key], ['approval', 'cli:b']);
  f.pointerDown(5020, 240, 12);
  f.pointerUp(5030);
  assert.equal(f.selectedKey, 'cli:a');
  assert.equal(f.overlay, null);
});

test('status and value formatting stay short for the round display', () => {
  assert.equal(sessionStatus(sessions[0]), 'Analysing');
  assert.equal(sessionStatus(sessions[1]), 'Needs approval');
  assert.equal(sessionStatus({ ...sessions[2], state: 'idle', ended: true, finished: true, endedAgoSec: 130 }), 'Done 2m ago');
  assert.equal(sessionStatus({ state: 'needsInput', attention: { kind: 'plan' } }), 'Plan ready for review');
  assert.equal(sessionStatus({ state: 'idle', closed: true, endedAgoSec: 10 }), 'Closed just now');
  assert.equal(sessionStatus({ state: 'tool', tool: 'bash' }), 'Executing bash');
  assert.equal(compactCount(12_345), '12k');
  assert.equal(compactCount(1_234), '1.2k');
  assert.equal(compactCount(2_000_000), '2M');
  assert.equal(duration(75), '1m 15s');
});

function actionableFace() {
  const f = new Face(emotions);
  const session = { ...sessions[1], observerInstanceId: 'owner-1', observerStartedAt: 1000,
    attention: { ...attention, actionable: true, command: 'npm test\nprintf done' } };
  f.setState({ mood: 'needsInput', sessions: [session] }, 0);
  f.tap(1);
  return { f, session };
}

test('permission buttons win over overlapping ring geometry and deny is one-shot', () => {
  const { f } = actionableFace();
  assert.ok(arcSlot(DENY_BUTTON.x + DENY_BUTTON.w - 1, DENY_BUTTON.y + 39, 3) >= 0);
  f.pointerDown(10, DENY_BUTTON.x + 155, DENY_BUTTON.y + 39);
  const action = f.pointerUp(20);
  assert.equal(typeof action, 'object');
  assert.equal(action && typeof action === 'object' && action.action, 'deny');
  assert.equal(f.overlay?.key, 'cli:b');
  assert.equal(f.pendingDecisions.size, 1);
  assert.equal(f.tap(30, DENY_BUTTON.x + 20, DENY_BUTTON.y + 20), undefined);
});

test('approve queues directly; holds and drags never decide', () => {
  const { f } = actionableFace();
  const [x, y] = [APPROVE_BUTTON.x + 30, APPROVE_BUTTON.y + 20];
  f.pointerDown(10, x, y);
  assert.equal(f.pointerUp(810), null);
  f.pointerDown(900, x, y);
  assert.equal(f.pointerUp(910, x + 50, y), undefined);
  f.pointerDown(920, x, y);
  const action = f.pointerUp(930, x, y);
  assert.equal(action && typeof action === 'object' && action.action, 'approve');
  assert.equal(f.pendingDecisions.size, 1);
  const texts: string[] = [];
  const ctx = new Proxy({ fillText(text: string) { texts.push(text); }, measureText: () => ({ width: 100 }) },
    { get: (obj, key) => obj[key] ?? (() => {}) });
  f.drawApprovalCard(ctx, f.primarySession());
  assert.ok(texts.includes('Approve'));
  assert.ok(texts.includes('Deny'));
  assert.ok(texts.includes('Decision queued; waiting for observer'));
});

test('changed nonce, command, owner or closed session cancels in-flight presses and resets pending', () => {
  for (const change of [
    { observerInstanceId: 'owner-2' }, { observerStartedAt: 2000 }, { closed: true },
    { attention: { ...attention, actionable: true, command: 'different' } },
    { attention: { ...attention, actionable: true, command: 'npm test', id: 'fedcba9876543210' } }
  ]) {
    const { f, session } = actionableFace();
    f.tap(2, DENY_BUTTON.x + 20, DENY_BUTTON.y + 20);
    f.pointerDown(10, APPROVE_BUTTON.x + 20, APPROVE_BUTTON.y + 20);
    f.setState({ mood: 'needsInput', sessions: [{ ...session, ...change }] }, 11);
    assert.equal(f.overlay, null);
    assert.equal(f.pointerUp(20), undefined);
    assert.equal(f.pendingDecisions.size, 0);
  }
});

test('actionable preview-only requests approve directly; read-only and display-only cards never decide', () => {
  const previewOnly = new Face(emotions);
  previewOnly.setState({ mood: 'needsInput', sessions: [{ ...sessions[1], attention: {
    ...attention, actionable: true, command: undefined
  } }] }, 0);
  previewOnly.tap(1);
  const approved = previewOnly.tap(2, APPROVE_BUTTON.x + 20, APPROVE_BUTTON.y + 20);
  assert.equal(approved && typeof approved === 'object' && approved.action, 'approve');
  assert.equal(previewOnly.pendingDecisions.size, 1);

  for (const a of [{ ...attention }, { id: attention.id, kind: 'question', pending: 1, actionable: true }]) {
    const f = new Face(emotions);
    f.setState({ mood: 'needsInput', sessions: [{ ...sessions[1], attention: a }] }, 0);
    f.tap(1);
    assert.equal(f.tap(2, APPROVE_BUTTON.x + 20, APPROVE_BUTTON.y + 20), undefined);
    assert.equal(f.pendingDecisions.size, 0);
  }
});

test('preview and physical Orb display modes disable permission actions', () => {
  const { f } = actionableFace();
  f.permissionsEnabled = false;
  assert.equal(f.tap(2, APPROVE_BUTTON.x + 20, APPROVE_BUTTON.y + 20), undefined);
  assert.equal(f.tap(3, DENY_BUTTON.x + 20, DENY_BUTTON.y + 20), undefined);
  assert.equal(f.pendingDecisions.size, 0);
});
