import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionCarousel, workingSessionState, type CarouselSession } from '../../dashboard/session-carousel.js';

test('working sessions and recent completions reach the carousel without mutating history', () => {
  const sessions = ['idle', 'done', 'error', 'thinking', 'tool', 'needsInput', 'thinking'].map((state, index) => ({
    source: 'cli', sessionId: String(index), state, closed: index === 6
  }));
  const state = { sessions, primary: 5 };
  const display = workingSessionState(state);
  assert.deepEqual(display.sessions.map(session => session.state), ['done', 'thinking', 'tool', 'needsInput']);
  assert.equal('backgroundOnly' in display.sessions[0] && display.sessions[0].backgroundOnly, true);
  assert.equal(display.primary, 3);
  assert.equal(state.sessions.length, 7);
  assert.deepEqual(workingSessionState({ sessions: sessions.slice(0, 3), primary: 2 }), { sessions: [], primary: 0 });
});

test('completions remain background-only strictly less than two minutes and only alongside work', () => {
  const done = { source: 'cli', sessionId: 'done', state: 'idle', finished: true, endedAgoSec: 119 };
  const busy = { source: 'cli', sessionId: 'busy', state: 'thinking' };
  assert.equal(workingSessionState({ sessions: [done, busy], primary: 0 }).primary, 1);
  assert.equal(workingSessionState({ sessions: [done, busy] }).sessions.length, 2);
  assert.equal(workingSessionState({ sessions: [{ ...done, endedAgoSec: 120 }, busy] }).sessions.length, 1);
  assert.equal(workingSessionState({ sessions: [done] }).sessions.length, 0);
});

test('a manually focused session completing rotates behind busy work even while a card is open', () => {
  const carousel = new SessionCarousel(), list = sessions();
  carousel.update(list, 0, 0);
  carousel.select('cli:a', 1, true);
  const state = workingSessionState({ sessions: [{ ...list[0], state: 'done' }, list[1]], primary: 0 });
  carousel.update(state.sessions, state.primary, 10, true);
  assert.equal(carousel.selectedKey, 'cli:b');
  assert.deepEqual(carousel.pose(0, 710), { x: 394, y: 258, size: 112 });
  carousel.select('cli:a', 800, true);
  carousel.update(state.sessions, 0, 10_000);
  assert.equal(carousel.selectedKey, 'cli:b', 'completion must not re-enter the rotation queue');
});

const sessions = (): CarouselSession[] => ['a', 'b', 'c'].map(sessionId => ({
  source: 'cli', sessionId, state: 'thinking'
}));

test('meaningful updates queue once per session and respect the four-second viewing time', () => {
  const carousel = new SessionCarousel(), list = sessions();
  carousel.update(list, 0, 0);
  list[1] = { ...list[1], state: 'tool', tool: 'bash' };
  list[2] = { ...list[2], state: 'done' };
  carousel.update(list, 2, 1000);
  carousel.update(list.map(session => ({ ...session })), 2, 3999);
  assert.equal(carousel.selectedKey, 'cli:a');
  carousel.update(list, 2, 4000);
  assert.equal(carousel.selectedKey, 'cli:b');
  carousel.update(list, 2, 8000);
  assert.equal(carousel.selectedKey, 'cli:c');
  carousel.update(list, 0, 60_000);
  assert.equal(carousel.selectedKey, 'cli:c', 'no spinning or priority jumps without new activity');
});

test('input preempts errors, holds until resolved, and ignores metadata', () => {
  const carousel = new SessionCarousel(), list = sessions();
  carousel.update(list, 0, 0);
  list[1].state = 'error';
  carousel.update(list, 0, 10);
  assert.equal(carousel.selectedKey, 'cli:b');
  list[2].state = 'needsInput';
  list[2].attention = { id: 'approval' };
  carousel.update(list, 0, 20);
  assert.equal(carousel.selectedKey, 'cli:c');
  list[0].state = 'done';
  carousel.update(list, 0, 10_000);
  assert.equal(carousel.selectedKey, 'cli:c');
  carousel.update(list, 0, 20_000);
  assert.equal(carousel.selectedKey, 'cli:c');
  list[2].state = 'thinking';
  carousel.update(list, 0, 20_001);
  assert.equal(carousel.selectedKey, 'cli:b');
});

test('manual selection lasts six seconds before returning to outstanding attention', () => {
  const carousel = new SessionCarousel(), list = sessions();
  list[1].state = 'needsInput';
  carousel.update(list, 1, 0);
  carousel.select('cli:a', 10, true);
  carousel.update(list, 1, 6009);
  assert.equal(carousel.selectedKey, 'cli:a');
  carousel.update(list, 1, 6010);
  assert.equal(carousel.selectedKey, 'cli:b');
});

test('Mona and open cards suspend rotations but retain pending activity', () => {
  const carousel = new SessionCarousel(), list = sessions();
  carousel.update(list, 0, 0);
  list[1].state = 'tool';
  carousel.update(list, 1, 5000, true);
  assert.equal(carousel.selectedKey, 'cli:a');
  carousel.update(list, 1, 6000);
  assert.equal(carousel.selectedKey, 'cli:b');
});

test('expired/replaced sessions cannot leave stale queued rotations or selection', () => {
  const carousel = new SessionCarousel(), list = sessions();
  carousel.update(list, 0, 0);
  list[1].state = 'done';
  carousel.update(list, 0, 100);
  carousel.update([list[2]], 0, 4000);
  assert.equal(carousel.selectedKey, 'cli:c');
  assert.deepEqual(carousel.pose(0, 4000), { x: 240, y: 246, size: 320 });
  carousel.update([], 0, 5000);
  assert.equal(carousel.selectedKey, null);
});

test('completion settling to idle and metadata-only refreshes do not queue another rotation', () => {
  const carousel = new SessionCarousel(), list = sessions();
  list[1].state = 'done';
  carousel.update(list, 0, 0);
  list[1].state = 'idle';
  carousel.update(list.map(session => ({ ...session, name: 'Renamed', inputTokens: 999 })), 1, 20_000);
  assert.equal(carousel.selectedKey, 'cli:a');
});

test('poses slide smoothly, preserve independent identities, and hit-test depth order', () => {
  const carousel = new SessionCarousel(), list = sessions();
  carousel.update(list, 0, 0);
  assert.deepEqual(carousel.pose(0, 0), { x: 240, y: 246, size: 256 });
  assert.equal(carousel.hit(394, 258, 0), 1);
  assert.equal(carousel.hit(86, 258, 0), 2);
  assert.equal(carousel.hit(240, 246, 0), 0);
  assert.equal(carousel.hit(20, 20, 0), -1);
  carousel.select('cli:b', 100, true);
  assert.deepEqual(carousel.pose(1, 100), { x: 394, y: 258, size: 112 });
  assert.deepEqual(carousel.pose(1, 450), { x: 317, y: 252, size: 184 });
  assert.deepEqual(carousel.pose(1, 800), { x: 240, y: 246, size: 256 });
  carousel.update([list[2], list[1], list[0]], 0, 900);
  assert.equal(carousel.selectedKey, 'cli:b');
  assert.deepEqual(carousel.pose(1, 900), { x: 240, y: 246, size: 256 });
});
