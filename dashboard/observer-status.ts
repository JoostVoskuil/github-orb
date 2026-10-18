import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { copilotOrbConfigPath, loadSavedOrbEndpoints } from '../observer/config-store.js';

export interface ObserverDestination {
  id?: string;
  kind: 'orb' | 'dashboard' | 'other';
  host: string;
  port: number;
  status: 'reachable' | 'unauthorized' | 'unreachable' | 'invalid_response';
  activeSessions: number | null;
}

export interface ObserverConfiguration {
  installed: boolean;
  configPath: string;
  destinations: ObserverDestination[];
  error: 'config_not_found' | 'invalid_orb_config' | 'observer_config_unavailable' | null;
}

export async function observerConfiguration(configPath = copilotOrbConfigPath()): Promise<ObserverConfiguration> {
  const extensionPath = join(dirname(dirname(configPath)), 'extensions/github-orb/extension.mjs');
  let installed = false;
  try {
    const entry = await readFile(extensionPath, 'utf8');
    installed = entry.includes('observeSession') && entry.includes(JSON.stringify(configPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const result: ObserverConfiguration = { installed, configPath, destinations: [], error: null };
  try {
    await readFile(configPath);
    const endpoints = await loadSavedOrbEndpoints(configPath);
    result.destinations = await Promise.all(endpoints.map(async (endpoint): Promise<ObserverDestination> => {
      const destination: ObserverDestination = {
        ...(endpoint.id === undefined ? {} : { id: endpoint.id }),
        kind: endpoint.id === 'orb' || endpoint.id === 'dashboard' ? endpoint.id : 'other',
        host: endpoint.host, port: endpoint.port, status: 'unreachable', activeSessions: null
      };
      try {
        const response = await fetch(`http://${endpoint.host}:${endpoint.port}/state`, {
          headers: { Authorization: ['Bearer', endpoint.token].join(' ') },
          redirect: 'error', signal: AbortSignal.timeout(1500)
        });
        if (response.status === 401 || response.status === 403) {
          destination.status = 'unauthorized';
          await response.body?.cancel();
        } else if (!response.ok) {
          destination.status = 'invalid_response';
          await response.body?.cancel();
        } else {
          const state: unknown = await response.json();
          if (state && typeof state === 'object' && 'type' in state && state.type === 'state' &&
              'sessions' in state && Array.isArray(state.sessions) &&
              'sessionCount' in state && Number.isInteger(state.sessionCount) && Number(state.sessionCount) >= 0) {
            destination.status = 'reachable';
            destination.activeSessions = Number(state.sessionCount);
          } else destination.status = 'invalid_response';
        }
      } catch {
        destination.status = 'unreachable';
      }
      return destination;
    }));
  } catch (error) {
    result.error = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'config_not_found' :
      error instanceof SyntaxError || (error instanceof Error && error.message === 'invalid_orb_config')
        ? 'invalid_orb_config' : 'observer_config_unavailable';
  }
  return result;
}
