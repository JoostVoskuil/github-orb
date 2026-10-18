import type { OrbConnectionConfig } from '../observer/config-store.js';
import { DEFAULT_SETTINGS, validateSettings, type DashboardSettings } from './orb-engine.js';

export interface DeviceSettings extends DashboardSettings {
  timezone: string;
  githubPollSec: number;
  githubConfigured: boolean;
}

export interface DeviceSettingsUpdate extends DashboardSettings {
  timezone: string;
  githubPollSec: number;
  githubPat?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseSettings(value: unknown): Omit<DeviceSettings, 'githubConfigured'> | null {
  if (!isRecord(value) || typeof value.sound !== 'boolean' ||
      typeof value.volume !== 'number' || value.volume < 0 || value.volume > 1 ||
      typeof value.brightness !== 'number' || value.brightness < 0.05 || value.brightness > 1 ||
      !isRecord(value.quietHours) || typeof value.quietHours.enabled !== 'boolean' ||
      typeof value.quietHours.start !== 'string' || typeof value.quietHours.end !== 'string' ||
      typeof value.timezone !== 'string' || !value.timezone.trim() || value.timezone.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(value.timezone) ||
      !Number.isInteger(value.githubPollSec) || Number(value.githubPollSec) < 30 || Number(value.githubPollSec) > 3600)
    return null;
  const settings = validateSettings(DEFAULT_SETTINGS, value);
  if (!settings) return null;
  return { ...settings, timezone: value.timezone, githubPollSec: Number(value.githubPollSec) };
}

export function parseDeviceSettingsUpdate(value: unknown): DeviceSettingsUpdate | null {
  const settings = parseSettings(value);
  if (!settings || !isRecord(value)) return null;
  if ('githubPat' in value) {
    if (typeof value.githubPat !== 'string' || value.githubPat.length > 512 ||
        /[\u0000-\u0020\u007f]/.test(value.githubPat)) return null;
    return { ...settings, githubPat: value.githubPat };
  }
  return settings;
}

export async function deviceSettings(
  config: OrbConnectionConfig, update?: DeviceSettingsUpdate
): Promise<DeviceSettings> {
  const base = `http://${config.host}:${config.port}`;
  const request = async (path: string, body?: DeviceSettingsUpdate): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method: body ? 'PUT' : 'GET',
        headers: {
          Authorization: `Bearer ${config.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
        redirect: 'error'
      });
    } catch (error) {
      throw new Error(error instanceof Error && error.name === 'TimeoutError' ? 'orb_timeout' : 'orb_unreachable');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(response.status === 401 || response.status === 403 ? 'orb_unauthorized' : 'orb_settings_rejected');
    }
    try {
      return await response.json();
    } catch {
      throw new Error('invalid_orb_response');
    }
  };
  // A dashboard also exposes /settings, but cannot persist physical device settings.
  const health = await request('/health');
  if (!isRecord(health) || health.status !== 'ok') throw new Error('invalid_orb_response');
  if (health.dashboard === true) throw new Error('destination_is_dashboard');
  const result = await request('/settings', update);
  const settings = parseSettings(result);
  if (!settings || !isRecord(result) || typeof result.githubConfigured !== 'boolean')
    throw new Error('invalid_orb_response');
  return { ...settings, githubConfigured: result.githubConfigured };
}

export async function testDeviceSound(config: OrbConnectionConfig): Promise<void> {
  // Validate the destination before asking it to produce physical audio.
  await deviceSettings(config);
  let response: Response;
  try {
    response = await fetch(`http://${config.host}:${config.port}/audio/test`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(10_000),
      redirect: 'error'
    });
  } catch (error) {
    throw new Error(error instanceof Error && error.name === 'TimeoutError' ? 'orb_timeout' : 'orb_unreachable');
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new Error('orb_unauthorized');
  }
  if (response.status === 404) {
    await response.body?.cancel();
    throw new Error('audio_test_unsupported');
  }
  const result: unknown = await response.json().catch(() => { throw new Error('invalid_orb_response'); });
  if (!isRecord(result)) throw new Error('invalid_orb_response');
  if (response.status === 409 && ['sound_assets_unavailable', 'sound_muted', 'quiet_hours_active', 'audio_busy'].includes(String(result.error)))
    throw new Error(String(result.error));
  if (response.status !== 202 || result.scheduled !== true) throw new Error('invalid_orb_response');
}
