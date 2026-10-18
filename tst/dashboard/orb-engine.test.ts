import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { OrbEngine, validateSettings } from '../../dashboard/orb-engine.js';

const emotions = JSON.parse(await readFile(new URL('../../../protocol/emotions.json', import.meta.url), 'utf8'));

function engine() {
  return new OrbEngine(emotions);
}

test('event lifecycle aggregates sessions, approval delay, priority, and expiry', () => {
  const orb = engine();
  assert.equal(orb.handleEvent({ source: 'vscode', sessionId: 'one', event: 'UserPromptSubmit' }, 100), true);
  assert.equal(orb.state(100).mood, 'thinking');
  assert.equal(orb.state(100).task, 'Working');
  assert.equal(orb.handleEvent({ source: 'cli', sessionId: 'two', event: 'PreToolUse', tool: 'npm' }, 200), true);
  assert.equal(orb.state(200).mood, 'tool');
  assert.equal(orb.state(200).task, 'Executing');
  assert.equal(orb.state(8200).mood, 'needsInput');
  assert.equal(orb.handleEvent({ source: 'vscode', sessionId: 'one', event: 'ErrorOccurred' }, 8300), true);
  assert.equal(orb.state(8300).mood, 'needsInput');
  assert.equal(orb.handleEvent({ source: 'cli', sessionId: 'two', event: 'SessionEnd' }, 8400), true);
  assert.equal(orb.state(8400).mood, 'error');
  assert.equal(orb.state(38_301).mood, 'done');
});

test('inactive sessions disappear at two minutes and new activity wakes the orb', () => {
  const orb = engine();
  orb.handleEvent({ source: 'sim', sessionId: 'one', event: 'SessionStart' }, 100);
  assert.equal(orb.state(100).mood, 'done');
  assert.equal(orb.state(120_099).sessions.length, 1);
  assert.equal(orb.state(120_100).sessions.length, 0);
  assert.equal(orb.state(120_100).mood, 'idle');
  orb.handleEvent({ source: 'sim', sessionId: 'one', event: 'Thinking' }, 121_000);
  assert.equal(orb.state(121_000).mood, 'thinking');
  assert.equal(orb.state(121_000).sessions.length, 1);
  assert.equal(orb.state(241_000).mood, 'idle');
});

test('events validate sources and names and support tool approval exceptions', () => {
  const orb = engine();
  assert.equal(orb.handleEvent({ source: 'unknown', event: 'Stop' }), false);
  assert.equal(orb.handleEvent({ source: 'cli', event: 'not-an-event' }), false);
  assert.equal(orb.handleEvent({ source: 'vscode', sessionId: 'q', event: 'PreToolUse', tool: 'vscode_askQuestions' }, 0), true);
  assert.equal(orb.state(0).mood, 'needsInput');
  assert.equal(orb.handleEvent({ source: 'vscode', sessionId: 'long', event: 'PreToolUse', tool: 'runSubagent' }, 0), true);
  assert.equal(orb.state(8_001).mood, 'needsInput');
  assert.equal(orb.state(8_001).sessions.find((item) => item.sessionId === 'long')?.state, 'tool');
});

test('GitHub alerts stay on Mona while Copilot works and return to the latest state only on acknowledgement', () => {
  const orb = engine();
  orb.handleEvent({ source: 'vscode', sessionId: 'one', event: 'UserPromptSubmit' }, 1);
  orb.setAlert({ id: 'alert-1', kind: 'workflowFailure', title: 'Build failed', url: 'https://github.com/o/r/actions/runs/1', repository: 'o/r' });
  assert.equal(orb.state(2).mascot, 'mona');
  assert.equal(orb.state(2).mood, 'workflowFailure');
  assert.equal(orb.state(2).sessions.length, 1);
  const alertPresentationId = orb.state(2).presentationId;
  orb.handleEvent({ source: 'vscode', sessionId: 'one', event: 'PreToolUse', tool: 'npm test' }, 3);
  assert.equal(orb.state(3).mascot, 'mona');
  assert.equal(orb.state(3).presentationId, alertPresentationId);
  orb.handleEvent({ source: 'vscode', sessionId: 'one', event: 'PostToolUse' }, 4);
  assert.equal(orb.state(4).mascot, 'mona');
  assert.equal(orb.state(4).presentationId, alertPresentationId);
  assert.equal(orb.acknowledgeAlert('wrong'), false);
  assert.equal(orb.acknowledgeAlert('alert-1'), true);
  assert.equal(orb.state(5).mascot, 'copilot');
  assert.equal(orb.state(5).mood, 'thinking');
  assert.ok(orb.state(5).presentationId > alertPresentationId);
  assert.equal(orb.acknowledgeAlert('alert-1'), false);
});

test('all GitHub notification kinds remain sticky, and an old tap cannot dismiss a newer notification', () => {
  for (const kind of [
    'prAssigned', 'reviewRequested', 'workflowFailure', 'workflowUpdate',
    'securityAlert', 'githubNotification', 'criticalSecurity'
  ] as const) {
    const orb = engine();
    orb.handleEvent({ source: 'vscode', sessionId: 'one', event: 'UserPromptSubmit' }, 1);
    orb.setAlert({ id: 'alert-1', kind, title: 'News', url: 'https://github.com/o/r', repository: 'o/r' });
    orb.handleEvent({ source: 'vscode', sessionId: 'one', event: 'Stop' }, 2);
    assert.equal(orb.state(2).mascot, 'mona');
    orb.setAlert({ id: 'alert-2', kind: 'criticalSecurity', title: 'Critical', url: 'https://github.com/o/r', repository: 'o/r' });
    assert.equal(orb.acknowledgeAlert('alert-1'), false);
    assert.equal(orb.state(3).mood, 'securityAlert');
    assert.equal(orb.acknowledgeAlert('alert-2'), true);
    assert.equal(orb.state(4).mood, 'done');
  }
});

test('agent-session-finished shows Copilot done briefly then restores live state', () => {
  const orb = engine();
  orb.handleEvent({ source: 'vscode', sessionId: 'one', event: 'UserPromptSubmit' }, 1);
  orb.setAlert({
    id: 'finished-1', kind: 'agentSessionFinished', title: 'Copilot done',
    url: 'https://github.com/o/r', repository: 'o/r'
  }, 100);
  const completed = orb.state(100);
  assert.equal(completed.copilotNotification, true);
  assert.equal(completed.mascot, 'copilot');
  assert.equal(completed.mood, 'done');
  assert.equal(completed.clip, 'done');
  assert.equal(completed.task, 'Done');
  assert.equal(completed.alert, null);
  assert.equal(orb.state(10_099).mood, 'done');
  assert.equal(orb.state(10_100).mood, 'thinking');
  assert.equal(orb.state(10_100).copilotNotification, false);

  orb.setAlert({
    id: 'finished-2', kind: 'agentSessionFinished', title: 'Copilot done',
    url: 'https://github.com/o/r', repository: 'o/r'
  }, 20_000);
  orb.handleEvent({ source: 'vscode', sessionId: 'one', event: 'UserPromptSubmit' }, 20_001);
  assert.equal(orb.state(20_001).mood, 'thinking');
});

test('generic GitHub notifications ask Mona for attention', () => {
  const orb = engine();
  orb.setAlert({
    id: 'generic-1', kind: 'githubNotification', title: 'Issue mentioned',
    url: 'https://github.com/o/r', repository: 'o/r'
  });
  const state = orb.state();
  assert.equal(state.mascot, 'mona');
  assert.equal(state.mood, 'needsInput');
  assert.equal(state.clip, 'mona-pr');
  assert.equal(state.task, 'GitHub needs attention');
});

test('sessionEnd does not dismiss the latest GitHub notification', () => {
  const orb = engine();
  orb.handleEvent({ source: 'vscode', sessionId: 'one', event: 'UserPromptSubmit' }, 1);
  orb.setAlert({ id: 'alert-1', kind: 'workflowFailure', title: 'Build failed', url: 'https://github.com/o/r/actions/runs/1', repository: 'o/r' });
  orb.handleEvent({ source: 'vscode', sessionId: 'one', event: 'SessionEnd' }, 3);
  assert.equal(orb.state(3).mascot, 'mona');
  orb.handleEvent({ source: 'vscode', sessionId: 'one', event: 'Thinking' }, 4);
  assert.equal(orb.state(4).mascot, 'mona');
});

test('settings are partially updated, bounded, and reject malformed input', () => {
  const current = { sound: false, volume: 0.5, brightness: 1, quietHours: { enabled: true, start: '22:00', end: '08:00' } };
  assert.deepEqual(validateSettings(current, { volume: 2, brightness: 0 }), {
    ...current, volume: 1, brightness: 0.05
  });
  assert.equal(validateSettings(current, { quietHours: { start: '25:00' } }), null);
  assert.equal(validateSettings(current, { quietHours: { start: '24:00' } }), null);
  assert.deepEqual(validateSettings(current, { quietHours: { start: '23:59' } }), {
    ...current, quietHours: { ...current.quietHours, start: '23:59' }
  });
  assert.equal(validateSettings(current, null), null);
});

test('reset clears sessions, alerts, presentation, and settings', () => {
  const orb = engine();
  orb.handleEvent({ source: 'vscode', sessionId: 'one', event: 'UserPromptSubmit' }, 1);
  orb.setAlert({ id: 'alert-1', kind: 'prAssigned', title: 'Assigned', url: 'https://github.com/o/r/pull/1', repository: 'o/r' });
  orb.setSettings({ sound: true, volume: 0.2 });
  orb.reset();

  const state = orb.state(2);
  assert.equal(state.mood, 'idle');
  assert.equal(state.mascot, 'copilot');
  assert.equal(state.sessions.length, 0);
  assert.equal(state.alert, null);
  assert.deepEqual(state.settings, {
    sound: false,
    volume: 0.5,
    brightness: 1,
    quietHours: { enabled: true, start: '22:00', end: '08:00' }
  });
});

test('session names upgrade from id to project to title and never downgrade', () => {
  const orb = engine();
  const name = () => orb.state(10).sessions[0].name;
  orb.handleEvent({ source: 'vscode', sessionId: 'a21332e3-bd5a-4370', event: 'SessionStart' }, 1);
  assert.equal(name(), 'a21332e3');
  orb.handleEvent({ source: 'vscode', sessionId: 'a21332e3-bd5a-4370', event: 'PreToolUse', project: 'copilotesp32' }, 2);
  assert.equal(name(), 'copilotesp32');
  orb.handleEvent({ source: 'vscode', sessionId: 'a21332e3-bd5a-4370', event: 'UserPromptSubmit', title: '  Fix\nthe   build  ', project: 'copilotesp32' }, 3);
  assert.equal(name(), 'Fix the build');
  orb.handleEvent({ source: 'vscode', sessionId: 'a21332e3-bd5a-4370', event: 'UserPromptSubmit', title: 'Second prompt', project: 'other' }, 4);
  assert.equal(name(), 'Fix the build');
});

test('a chat title always wins and follows renames', () => {
  const orb = engine();
  const name = () => orb.state(10).sessions[0].name;
  orb.handleEvent({ source: 'vscode', sessionId: 's', event: 'UserPromptSubmit', title: 'First prompt', project: 'repo' }, 1);
  assert.equal(name(), 'First prompt');
  orb.handleEvent({ source: 'vscode', sessionId: 's', event: 'Stop', chat: 'Simulate mode behavior adjustments' }, 2);
  assert.equal(name(), 'Simulate mode behavior adjustments');
  orb.handleEvent({ source: 'vscode', sessionId: 's', event: 'UserPromptSubmit', title: 'Second prompt', project: 'other' }, 3);
  assert.equal(name(), 'Simulate mode behavior adjustments');
  orb.handleEvent({ source: 'vscode', sessionId: 's', event: 'Stop', chat: 'Renamed chat' }, 4);
  assert.equal(name(), 'Renamed chat');
});

test('session names are bounded and ignore non-strings', () => {
  const orb = engine();
  orb.handleEvent({ source: 'cli', sessionId: 'one', event: 'UserPromptSubmit', title: 'x'.repeat(100) }, 1);
  assert.equal(orb.state(2).sessions[0].name.length, 40);
  orb.handleEvent({ source: 'cli', sessionId: 'two', event: 'UserPromptSubmit', title: { bad: true } }, 3);
  assert.equal(orb.state(4).sessions.find((item) => item.sessionId === 'two')?.name, 'two');
});
