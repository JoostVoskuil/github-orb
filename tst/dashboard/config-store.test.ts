import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadOrbEndpoints, loadSavedOrbEndpoints, saveOrbConfig, saveOrbEndpoint } from '../../observer/config-store.js';

test('Orb config save is atomic, private, and preserves unrelated fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orb-config-'));
  const path = join(directory, 'config.json');
  try {
    await writeFile(path, '{"custom":true,"host":"old"}\n', { mode: 0o600 });
    await saveOrbConfig({ host: '192.168.1.69', port: 7420, token: 'test-token', custom: false }, path);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(saved, { custom: true, host: '192.168.1.69', port: 7420, token: 'test-token' });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ['config.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Orb config save rejects symlink destinations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orb-config-'));
  try {
    const target = join(directory, 'target.json');
    const path = join(directory, 'config.json');
    await writeFile(target, '{}');
    await symlink(target, path);
    await assert.rejects(saveOrbConfig({ host: 'orb.local', port: 7420, token: 'test-token' }, path), /unsafe_config_path/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Orb config save does not overwrite a malformed existing file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orb-config-'));
  const path = join(directory, 'config.json');
  const malformed = '{"host":';
  try {
    await writeFile(path, malformed, { mode: 0o600 });
    await assert.rejects(
      saveOrbConfig({ host: 'orb.local', port: 7420, token: 'test-token' }, path),
      SyntaxError
    );
    assert.equal(await readFile(path, 'utf8'), malformed);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('observer config upserts named endpoints and loads legacy single-endpoint files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orb-config-endpoints-'));
  const path = join(directory, 'config.json');
  const env = {
    host: process.env.ORB_HOST,
    port: process.env.ORB_PORT,
    token: process.env.ORB_TOKEN
  };
  delete process.env.ORB_HOST;
  delete process.env.ORB_PORT;
  delete process.env.ORB_TOKEN;
  try {
    await writeFile(path, JSON.stringify({
      host: '192.0.2.1', port: 7420, token: 'legacy-token', preference: 'keep'
    }), { mode: 0o600 });
    await saveOrbEndpoint({
      id: 'dashboard', host: '127.0.0.1', port: 7421, token: 'dashboard-token'
    }, path);
    await saveOrbEndpoint({
      id: 'orb', host: '192.0.2.1', port: 7420, token: 'orb-token'
    }, path);
    await saveOrbEndpoint({
      id: 'orb', host: '192.0.2.2', port: 7420, token: 'updated-orb-token'
    }, path);

    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.preference, 'keep');
    assert.deepEqual(saved.endpoints, [
      { id: 'orb', host: '192.0.2.2', port: 7420, token: 'updated-orb-token' },
      { id: 'dashboard', host: '127.0.0.1', port: 7421, token: 'dashboard-token' }
    ]);
    assert.deepEqual(await loadOrbEndpoints(path), saved.endpoints);
    process.env.ORB_HOST = 'override.local';
    process.env.ORB_PORT = '1234';
    process.env.ORB_TOKEN = 'override-token';
    assert.deepEqual(await loadSavedOrbEndpoints(path), saved.endpoints,
      'Dashboard status must show saved destinations, not dashboard-process environment overrides');
    assert.deepEqual(await loadOrbEndpoints(path), [
      { ...saved.endpoints[0], host: 'override.local', port: 1234, token: 'override-token' },
      saved.endpoints[1]
    ], 'Observer runtime must preserve its environment override behavior');
  } finally {
    if (env.host === undefined) delete process.env.ORB_HOST;
    else process.env.ORB_HOST = env.host;
    if (env.port === undefined) delete process.env.ORB_PORT;
    else process.env.ORB_PORT = env.port;
    if (env.token === undefined) delete process.env.ORB_TOKEN;
    else process.env.ORB_TOKEN = env.token;
    await rm(directory, { recursive: true, force: true });
  }
});