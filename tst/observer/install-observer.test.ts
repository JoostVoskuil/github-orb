import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { copilotOrbConfigPath } from '../../observer/config-store.js';
import { installObserver } from '../../observer/install-observer.js';

test('dashboard installer uses the private Copilot home config and installs the user extension', async () => {
  const home = await mkdtemp(join(tmpdir(), 'orb-dashboard-install-'));
  const previousCopilotHome = process.env.COPILOT_HOME;
  const configPath = join(home, 'orb', 'config.json');
  try {
    process.env.COPILOT_HOME = home;
    assert.equal(copilotOrbConfigPath(), configPath);
    await mkdir(join(home, 'orb'), { recursive: true });
    await writeFile(configPath, JSON.stringify({ host: '192.0.2.1', port: 7420, token: 'private-test-token' }), { mode: 0o600 });

    const extensionPath = await installObserver(configPath);
    assert.equal(extensionPath, join(home, 'extensions', 'github-orb', 'extension.mjs'));
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    const entry = await readFile(extensionPath, 'utf8');
    assert.ok(entry.includes(configPath));
    assert.equal(entry.includes('private-test-token'), false);
  } finally {
    if (previousCopilotHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = previousCopilotHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('observer installation remains private and idempotent without modifying unrelated configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orb-install-'));
  try {
    const configPath = join(directory, 'orb.json');
    const originalConfig = JSON.stringify({ host: '127.0.0.1', port: 7421, token: 'install-test', other: true });
    await writeFile(configPath, originalConfig, { mode: 0o600 });
    const env = { ...process.env, COPILOT_HOME: join(directory, 'home'), ORB_CONFIG: configPath };
    const install = (...args: string[]) => spawnSync(process.execPath,
      [fileURLToPath(new URL('../../observer/install-observer.js', import.meta.url)), ...args], { env, encoding: 'utf8' });
    const legacyEntry = join(directory, 'home/extensions/copilot-orb/extension.mjs');
    await mkdir(join(directory, 'home/extensions/copilot-orb'), { recursive: true });
    await writeFile(legacyEntry, '// old observer');
    const blocked = install();
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /legacy copilot-orb observer/i);
    await rm(legacyEntry);
    const first = install();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout.includes('install-test'), false);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(config.other, true);
    assert.equal(await readFile(configPath, 'utf8'), originalConfig);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    const entry = join(directory, 'home/extensions/github-orb/extension.mjs');
    assert.equal((await stat(entry)).mode & 0o777, 0o600);
    const content = await readFile(entry, 'utf8');
    assert.ok(content.includes('@github/copilot-sdk/extension'));
    assert.ok(content.includes('/dist/observer/observer.js'));
    assert.ok(content.includes(configPath));
    assert.equal(content.includes('install-test'), false);
    assert.equal(install().status, 0);
    assert.equal(await readFile(configPath, 'utf8'), originalConfig);
    await writeFile(entry, '// unrelated extension');
    assert.notEqual(install().status, 0);
    assert.equal(await readFile(entry, 'utf8'), '// unrelated extension');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
