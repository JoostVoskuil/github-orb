import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Face } from '../../dashboard/face.js';
import { Frames, validateManifest } from '../../dashboard/frames.js';
import { CLIPS } from '../../dashboard/motion.js';
import { MONA_CLIPS, presentation, presentationChanged, previewState, githubUrl, renderNews } from '../../dashboard/presentation.js';
const emotions = JSON.parse(readFileSync(new URL('../../../protocol/emotions.json', import.meta.url), 'utf8'));
const sessions = [{ source: 'cli', state: 'thinking' }];
const mona = (id = 1, clip = 'mona-pr') => presentation({ mascot: 'mona', clip, mood: 'idle', presentationId: id, sessions }, emotions.presentations);
const manifest = () => ({
  version: 1, frameSize: 320,
  clips: Object.fromEntries(Object.keys(CLIPS).map((name) => [name, {
    frames: 36, fps: 12, columns: 8, loop: false, file: `${name}.webp`
  }]))
});

test('identity defaults to Copilot; Mona mood/clip selection retains underlying sessions', () => {
  assert.equal(presentation({ mood: 'tool' }, emotions.presentations).mascot, 'copilot');
  assert.equal(presentation({ mood: 'tool', mascot: 'unknown', clip: 'mona-pr' }, emotions.presentations).clip, 'tool');
  const expectedMoods: Record<string, string> = {
    'mona-idle': 'idle',
    'mona-thinking': 'thinking',
    'mona-tool': 'tool',
    'mona-pr': 'prAssigned',
    'mona-done': 'done',
    'mona-workflow': 'workflowFailure',
    'mona-security': 'securityAlert',
    'mona-offline': 'disconnected'
  };
  for (const clip of MONA_CLIPS) {
    const state = mona(1, clip);
    assert.equal(state.clip, clip);
    assert.equal(state.mood, expectedMoods[clip]);
    assert.equal(state.sessions, sessions);
    assert.ok(clip.length <= 15);
  }
  assert.equal(presentation({ mascot: 'mona', alert: { kind: 'security' } }, emotions.presentations).clip, 'mona-security');
  for (const [kind, mood, clip, task] of [
    ['prAssigned', 'prAssigned', 'mona-pr', 'PR assigned'],
    ['reviewRequested', 'reviewRequested', 'mona-pr', 'PR needs review'],
    ['workflowFailure', 'workflowFailure', 'mona-workflow', 'Workflow failed'],
    ['workflowUpdate', 'workflowFailure', 'mona-workflow', 'Workflow failed'],
    ['githubNotification', 'needsInput', 'mona-pr', 'GitHub needs attention'],
    ['securityAlert', 'securityAlert', 'mona-security', 'Security alert'],
    ['criticalSecurity', 'securityAlert', 'mona-security', 'Security alert'],
    ['monaScared', 'scared', 'mona-security', 'Scared']
  ]) {
    const state = presentation({ mascot: 'mona', alert: { kind } }, emotions.presentations);
    assert.equal(state.clip, clip);
    assert.equal(state.mood, mood);
    assert.equal(state.task, task);
    assert.equal(state.ring.mode,
      mood === 'prAssigned' || mood === 'reviewRequested' || mood === 'needsInput' ? 'animated' : 'solid');
  }
  assert.equal(presentation({ mascot: 'mona', clip: '../../bad', mood: 'idle' }, emotions.presentations).clip, 'mona-pr');
  const disconnected = presentation({ ...mona(), mood: 'disconnected' }, emotions.presentations);
  assert.equal(disconnected.mood, 'disconnected');
  assert.equal(disconnected.task, 'Offline');
  for (const id of [-1, 0.5, NaN, Infinity, '2', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(presentation({ presentationId: id }).presentationId, 0);
  }
});

test('every mascot mood defines a valid animation, task and explicit ring mode', () => {
  for (const [mascot, moods] of Object.entries(emotions.presentations)) {
    for (const [mood, definition] of Object.entries(moods as Record<string, any>)) {
      assert.ok(definition.animation, `${mascot}.${mood} animation`);
      assert.ok(definition.task, `${mascot}.${mood} task`);
      assert.ok(mascot === 'mona' ? MONA_CLIPS.includes(definition.animation) : Object.hasOwn(CLIPS, definition.animation));
      assert.ok(['animated', 'solid'].includes(definition.ring.mode));
      assert.ok(['chase', 'solid'].includes(definition.ring.anim));
    }
  }
});

test('same clip fresh presentation restarts; timestamps, settings, sessions and alert text do not', () => {
  const face = new Face(emotions);
  const state = mona(10);
  assert.equal(face.setState(state, 100), true);
  assert.equal(face.setState({ ...state, ts: 1000, sessions: [], alert: { title: 'updated' } }, 900), false);
  assert.equal(face.enteredAt, 100);
  assert.equal(face.setState({ ...state, presentationId: 11 }, 1000), true);
  assert.equal(face.enteredAt, 1000);
  assert.equal(face.setState({ ...state, presentationId: 11, ts: 99999 }, 2000), false);
  assert.equal(face.enteredAt, 1000);
  assert.equal(presentationChanged(state, { ...state, presentationId: 9 }), false);
  assert.equal(face.setState(mona(12, 'mona-workflow'), 3000), true);
});

test('fresh Copilot activity restarts an unchanged mood and identity changes clear cross-identity blends', () => {
  const frames = { current: {}, transition: {} };
  const face = new Face(emotions, null, frames);
  const state = { mood: 'thinking', presentationId: 1 };
  face.setState(state, 100);
  face.setState({ ...state, presentationId: 2 }, 300);
  assert.equal(face.enteredAt, 300);
  face.setState(mona(3), 400);
  assert.equal(frames.current, null);
  assert.equal(frames.transition, null);
});

test('Mona clips are optional in the shared manifest, but present clips must be safe', () => {
  const value = manifest();
  assert.equal(validateManifest(value), value);
  for (const clip of MONA_CLIPS) value.clips[clip] = { ...value.clips.error, file: `${clip}.webp` };
  assert.equal(validateManifest(value), value);
  value.clips['mona-security'].file = '../secrets.webp';
  assert.throws(() => validateManifest(value), /mona-security/);
});

test('missing Mona atlas does not prevent later Copilot playback', () => {
  const frames = new Frames();
  frames.manifest = manifest();
  frames.atlases.set('idle', {} as HTMLImageElement);
  const ctx = { drawImage() {} } as unknown as CanvasRenderingContext2D;
  assert.equal(frames.draw(ctx, 'mona-pr', 100, 100), false);
  assert.equal(frames.draw(ctx, 'idle', 200, 200), true);
});

test('Mona frame cropping uses selected alert clip and restarts on fresh presentation', () => {
  const frames = new Frames();
  frames.manifest = manifest();
  frames.manifest.clips['mona-security'] = { ...frames.manifest.clips.error };
  frames.atlases.set('mona-security', {} as HTMLImageElement);
  const face = new Face(emotions, null, frames);
  face.setState(mona(1, 'mona-security'), 100);
  const crops = [];
  const ctx = { drawImage(...args: unknown[]) { crops.push(args.slice(1, 3)); } } as unknown as CanvasRenderingContext2D;
  frames.draw(ctx, face.state.clip, 1100, face.enteredAt, 0);
  assert.deepEqual(crops.at(-1), [1280, 320]);
  face.setState(mona(2, 'mona-security'), 1200);
  frames.draw(ctx, face.state.clip, 1200, face.enteredAt, 0);
  assert.deepEqual(crops.at(-1), [0, 0]);
});

const context = () => new Proxy({} as Record<string, any>, { get: (target, key) => typeof key === 'string' ? target[key] ?? (() => {}) : undefined });

test('Mona uses its selected frame clip in all renderer modes', () => {
  for (const character of ['frames', 'artwork', 'vector']) {
    let renderedClip = '';
    const face = new Face(emotions, { draw() { assert.fail('Mona used Copilot artwork'); } }, {
      draw(_ctx, clip) { renderedClip = clip; return true; }
    });
    face.character = character;
    face.setState(mona(1, 'mona-security'), 100);
    face.drawMona = () => assert.fail('Mona used its static silhouette');
    face.drawHead = () => assert.fail('Mona used Copilot head');
    face.drawTopBadge = face.drawFx = face.drawLabel = face.drawRing = () => {};
    const ctx = context();
    const translations = [];
    ctx.translate = (...args) => translations.push(args);
    ctx.rotate = () => assert.fail('Procedural tilt applied to Mona');
    face.draw(ctx, 900);
    assert.equal(renderedClip, 'mona-security');
    assert.deepEqual(translations, [[240, 246]]);
  }
});

test('Mona falls back to its silhouette when frame assets are unavailable', () => {
  for (const character of ['frames', 'artwork', 'vector']) {
    const face = new Face(emotions, { draw() { assert.fail('Mona used Copilot artwork'); } }, { draw() { return false; } });
    face.character = character;
    face.setState(mona(), 100);
    let fallback = 0;
    face.drawMona = () => { fallback++; };
    face.drawHead = () => assert.fail('Mona used Copilot head');
    face.drawTopBadge = face.drawFx = face.drawLabel = face.drawRing = () => {};
    const ctx = context();
    const translations = [];
    ctx.translate = (...args) => translations.push(args);
    ctx.rotate = () => assert.fail('Procedural tilt applied to Mona');
    face.draw(ctx, 900);
    assert.equal(fallback, 1);
    assert.deepEqual(translations, [[240, 246]]);
  }
});

test('Mona source dot is GitHub, never the preserved Copilot sessions', () => {
  const face = new Face(emotions);
  face.setState(mona(), 0);
  const ctx = context();
  const colors = [];
  ctx.fill = () => colors.push(ctx.fillStyle);
  face.drawTopBadge(ctx);
  assert.deepEqual(colors, ['#f0f6fc']);
});

test('preview identity and alert are independent of live session aggregation', () => {
  const live = { mood: 'tool', sessions, presentationId: 100 };
  const preview = previewState(live, 'mona', 'mona-workflow', 'done', 101, emotions.presentations);
  assert.equal(preview.mood, 'workflowFailure');
  assert.equal(preview.sessions, sessions);
  assert.equal(live.mood, 'tool');
  assert.equal(previewState(live, 'copilot', 'mona-pr', 'thinking', 102, emotions.presentations).clip, 'thinking');
  assert.equal(previewState(live, '', 'mona-pr', '', 102, emotions.presentations).mood, 'tool');
});

test('news links allow only credential-free HTTPS github.com URLs', () => {
  assert.equal(githubUrl('https://github.com/org/repo/pull/1'), 'https://github.com/org/repo/pull/1');
  for (const url of ['http://github.com/x', 'https://github.com.evil.test/x', 'https://api.github.com/x',
    'https://evil.test/github.com', 'javascript:alert(1)', '//github.com/x', 'https://user:pass@github.com/x',
    'https://github.com:8443/x', '', undefined]) assert.equal(githubUrl(url), null);
});

test('news text is bounded textContent, and unsafe or cleared alerts remove stale href', () => {
  const element: Record<string, any> = { removeAttribute(key: string) { delete this[key]; } };
  const state = { ...mona(), task: 'Security alert', alert: {
    kind: 'criticalSecurity', title: '<img onerror=alert(1)>', repository: 'org/repo',
    organization: 'org', repositoryName: 'repo', url: 'https://github.com/org/repo'
  } };
  renderNews(element, state);
  assert.equal(element.textContent, 'Security alert · Organization: org · Repository: repo · <img onerror=alert(1)>');
  assert.equal(element.href, 'https://github.com/org/repo');
  assert.equal(element.rel, 'noopener noreferrer');
  renderNews(element, { ...state, alert: { title: 'x'.repeat(1000), url: 'javascript:alert(1)' } });
  assert.ok(element.textContent.length <= 180);
  assert.ok(element.textContent.endsWith('x'.repeat(120)));
  assert.equal(element.href, undefined);
  renderNews(element, { mascot: 'copilot' });
  assert.equal(element.hidden, true);
  assert.equal(element.textContent, '');
});