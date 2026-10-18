import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadGitHubToken, saveGitHubToken } from '../../dashboard/github-token-store.js';

test('dashboard GitHub tokens are stored privately and can be removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orb-github-token-'));
  const path = join(directory, 'settings.json');
  try {
    assert.equal(await loadGitHubToken(path), null);
    await saveGitHubToken('ghp-test-token', path);
    assert.equal(await loadGitHubToken(path), 'ghp-test-token');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { token: 'ghp-test-token' });

    await saveGitHubToken('', path);
    assert.equal(await loadGitHubToken(path), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
