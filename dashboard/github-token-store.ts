import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function loadGitHubToken(path: string): Promise<string | null> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe_github_token_path');

  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isRecord(parsed) || typeof parsed.token !== 'string' || parsed.token.length > 512) {
    throw new Error('invalid_github_token_config');
  }
  return parsed.token || null;
}

export async function saveGitHubToken(token: string, path: string): Promise<void> {
  if (token.length > 512) throw new Error('invalid_github_token');
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe_github_token_path');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }

  if (!token) {
    try {
      await unlink(path);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    return;
  }

  const temporary = join(directory, `.${randomUUID()}.github-token.tmp`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ token })}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Could not replace the GitHub token config or remove its temporary file');
    }
    throw error;
  }
  const directoryHandle = await open(directory, constants.O_RDONLY);
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}
