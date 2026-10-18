#!/usr/bin/env node
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { GitHubPoller } from './github-poller.js';
import { loadGitHubToken, saveGitHubToken } from './github-token-store.js';
import { OrbEngine } from './orb-engine.js';
import { deviceSettings, parseDeviceSettingsUpdate, testDeviceSound } from './device-settings.js';
import { observerEvent } from '../observer/observer-protocol.js';
import { copilotOrbConfigPath, loadOrbConfig, removeOrbEndpoint, saveOrbEndpoint } from '../observer/config-store.js';
import type { OrbConnectionConfig } from '../observer/config-store.js';
import type { UsbAssetName, UsbSetupService } from './usb-setup.js';
import { DeviceUpdates, latestFirmware } from './device-updates.js';
import { installObserver } from '../observer/install-observer.js';
import { observerConfiguration } from './observer-status.js';
import { DemoPlayer } from './demo-sequence.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const emotions = JSON.parse(await readFile(join(root, 'protocol/emotions.json'), 'utf8'));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
};

interface DashboardServerOptions {
  token?: string;
  githubToken?: string;
  githubPollSec?: number;
  dataDir?: string;
  assetDir?: string;
  githubPoller?: GitHubPoller | false;
  usbSetup?: UsbSetupService | false;
  orbConfig?: () => Promise<OrbConnectionConfig>;
  firmwareDir?: string;
  observerConfigPath?: string;
  demoTimeScale?: number;
}

const MAX_FIRMWARE_BYTES = 0x300000;

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function proxyFirmwareUpload(req: http.IncomingMessage, res: http.ServerResponse, config: OrbConnectionConfig): void {
  const contentLength = req.headers['content-length'];
  const size = typeof contentLength === 'string' ? Number(contentLength) : NaN;
  if (req.headers['content-type'] !== 'application/octet-stream' ||
      !Number.isSafeInteger(size) || size <= 0 || size > MAX_FIRMWARE_BYTES) {
    req.resume();
    json(res, 400, { error: 'invalid_firmware_size' });
    return;
  }

  let replied = false;
  const upstream = http.request({
    hostname: config.host,
    port: config.port,
    path: '/ota',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size)
    }
  }, (upstreamResponse) => {
    const chunks: Buffer[] = [];
    let responseSize = 0;
    upstreamResponse.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      responseSize += buffer.length;
      if (responseSize > 4096) {
        upstream.destroy(new Error('invalid_orb_response'));
        return;
      }
      chunks.push(buffer);
    });
    upstreamResponse.on('end', () => {
      if (res.destroyed || replied) return;
      replied = true;
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        json(res, upstreamResponse.statusCode ?? 502, body);
      } catch {
        json(res, 502, { error: 'invalid_orb_response' });
      }
    });
    upstreamResponse.on('error', (error) => upstream.destroy(error));
  });

  upstream.on('error', (error) => {
    if (replied || res.destroyed || res.headersSent) return;
    replied = true;
    const timeout = error.message === 'orb_timeout';
    json(res, timeout ? 504 : 502, { error: timeout ? 'orb_timeout' : 'orb_unreachable' });
  });
  upstream.setTimeout(120_000, () => upstream.destroy(new Error('orb_timeout')));
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy();
  });
  req.pipe(upstream);
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function localUiRequest(req: http.IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false;
  try {
    const origin = req.headers.origin;
    if (!origin) {
      return req.headers['sec-fetch-site'] === 'same-origin' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(new URL(`http://${host}`).hostname);
    }
    const parsed = new URL(origin);
    return parsed.origin === `http://${host}` && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

interface RequestError extends Error {
  status?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const DEBUG_PAYLOAD_FIELDS = [
  'event', 'source', 'observerVersion', 'sessionId', 'instanceId', 'startedAt',
  'sequence', 'state', 'activity', 'agent', 'subagent', 'model', 'inputTokens', 'outputTokens',
  'contextPercent', 'busyForMs', 'attention', 'tool', 'project', 'sessionName', 'title', 'chat'
] as const;

interface DebugMessage {
  id: number;
  receivedAt: number;
  accepted: boolean;
  fields: Array<{ field: string; value: string }>;
  error?: string;
}

function debugText(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120)
    : '[non-string]';
}

function debugFieldValue(field: typeof DEBUG_PAYLOAD_FIELDS[number], value: unknown): string {
  switch (field) {
    case 'event':
    case 'source':
    case 'state':
    case 'activity':
    case 'tool':
      return value === null ? 'null' : debugText(value);
    case 'observerVersion':
    case 'startedAt':
    case 'sequence':
      return Number.isSafeInteger(value) ? String(value) : '[invalid]';
    case 'sessionId':
    case 'instanceId':
      return debugText(value);
    case 'agent':
    case 'subagent':
    case 'model':
      return debugText(value);
    case 'attention':
      // Kind only; the reason and preview stay out of the debug history.
      return isRecord(value)
        ? `${debugText(value.kind)} pending=${Number.isInteger(value.pending) ? value.pending : '?'}`
        : '[invalid]';
    case 'inputTokens':
    case 'outputTokens':
    case 'contextPercent':
    case 'busyForMs':
      return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xffffffff
        ? String(value) : '[invalid]';
    case 'project':
    case 'sessionName':
    case 'title':
    case 'chat':
      return debugText(value);
  }
}

function requestStatus(error: unknown): number {
  return error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : 400;
}

// Keep parsed request bodies untrusted; each route validates its own shape.
async function readJson(req: http.IncomingMessage, limit = 4096): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw Object.assign(new Error('payload_too_large') as RequestError, { status: 413 });
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('invalid_json') as RequestError, { status: 400 });
  }
}

export function createDashboardServer(options: DashboardServerOptions = {}) {
  const engine = new OrbEngine(emotions);
  const token = options.token ?? process.env.ORB_TOKEN ?? '';
  const getOrbConfig = options.orbConfig ?? loadOrbConfig;
  const dataDir = options.dataDir ?? process.env.ORB_DATA_DIR ?? join(root, 'dashboard-data');
  const githubTokenPath = join(dataDir, 'github-token.json');
  const githubTokenEnvironmentManaged = Boolean(
    options.githubToken !== undefined
      ? options.githubToken.trim()
      : process.env.ORB_GITHUB_PAT?.trim()
  );
  let githubTokenSource: 'environment' | 'saved' | 'none' = githubTokenEnvironmentManaged ? 'environment' : 'none';
  let githubTokenStorageError: string | null = null;
  const firmwareDir = options.firmwareDir ?? join(root, 'dist/firmware');
  const githubPoller = options.githubPoller === false ? undefined : options.githubPoller ?? new GitHubPoller({
    token: options.githubToken ?? process.env.ORB_GITHUB_PAT,
    pollSec: options.githubPollSec ?? Number(process.env.ORB_GITHUB_POLL_SEC || 60),
    dataDir,
    onAlert: (alert) => engine.setAlert(alert)
  });
  githubPoller?.start();
  const githubTokenReady = githubPoller && !githubTokenEnvironmentManaged
    ? loadGitHubToken(githubTokenPath).then((savedToken) => {
      if (savedToken) {
        githubTokenSource = 'saved';
        githubPoller.setToken(savedToken);
      }
    }).catch((error: unknown) => {
      githubTokenStorageError = 'Could not load saved dashboard GitHub settings.';
      console.error('Could not load saved dashboard GitHub settings:', error);
    })
    : Promise.resolve();
  const usbSetup = options.usbSetup === false ? undefined : options.usbSetup;
  const updates = new DeviceUpdates({
    usb: usbSetup, config: getOrbConfig, firmwareDir,
    assetDir: options.assetDir ?? join(root, 'dist/sdcard')
  });
  const debugMessages: DebugMessage[] = [];
  const demo = new DemoPlayer({
    config: async () => {
      try {
        return await getOrbConfig();
      } catch (error) {
        // With observers removed, the demo can still reach a USB-attached Orb without saving anything.
        if (!(error instanceof Error && error.message === 'no_observer_destinations') || !usbSetup?.readOrbConnection) throw error;
        return usbSetup.readOrbConnection();
      }
    },
    timeScale: options.demoTimeScale
  });
  let debugMessageId = 0;
  const recordDebugMessage = (payload: unknown, accepted: boolean, error?: string) => {
    const message = isRecord(payload) ? payload : {};
    debugMessages.push({
      id: ++debugMessageId,
      receivedAt: Date.now(),
      accepted,
      fields: DEBUG_PAYLOAD_FIELDS.flatMap((field) => field in message
        ? [{ field, value: debugFieldValue(field, message[field]) }]
        : []),
      ...(error ? { error } : {})
    });
    if (debugMessages.length > 40) debugMessages.shift();
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    const apiPaths = ['/event', '/state', '/messages', '/settings', '/github/status', '/github/token', '/github/acknowledge', '/ota'];

    if (req.method === 'OPTIONS' && apiPaths.includes(pathname)) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Orb-Token',
        'Access-Control-Max-Age': '600'
      });
      res.end();
      return;
    }

    const authorized = () => {
      if (localUiRequest(req)) return true;
      let candidate = '';
      const authorization = req.headers.authorization;
      if (authorization?.startsWith('Bearer ')) candidate = authorization.slice(7);
      if (!candidate && typeof req.headers['x-orb-token'] === 'string') candidate = req.headers['x-orb-token'];
      if (!candidate) candidate = url.searchParams.get('token') ?? '';
      return constantTimeEqual(candidate, token);
    };

    if (req.method === 'GET' && pathname === '/health') {
      json(res, 200, { status: 'ok', uptimeSec: Math.floor(process.uptime()), wifiConnected: true, dashboard: true });
      return;
    }

    if (pathname === '/setup/observer') {
      if (!localUiRequest(req)) {
        req.resume();
        json(res, 403, { error: 'forbidden' });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        req.resume();
        json(res, 405, { error: 'method_not_allowed' });
        return;
      }
      try {
        if (req.method === 'DELETE') {
          const body = await readJson(req);
          if (!isRecord(body) || typeof body.host !== 'string' ||
              !Number.isInteger(body.port) || Number(body.port) < 1 || Number(body.port) > 65535 ||
              (body.id !== undefined && typeof body.id !== 'string')) {
            json(res, 400, { error: 'invalid_request' });
            return;
          }
          await removeOrbEndpoint({
            host: body.host, port: Number(body.port),
            ...(typeof body.id === 'string' ? { id: body.id } : {})
          }, options.observerConfigPath);
          json(res, 200, { removed: true });
          return;
        }
        json(res, 200, await observerConfiguration(options.observerConfigPath));
      } catch (error) {
        const code = error instanceof Error && error.message === 'observer_destination_not_found'
          ? 'observer_destination_not_found' : 'observer_config_unavailable';
        json(res, code === 'observer_destination_not_found' ? 404 : 503, { error: code });
      }
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/firmware/latest') {
      if (!localUiRequest(req)) {
        req.resume();
        json(res, 403, { error: 'forbidden' });
        return;
      }
      try {
        const firmware = await latestFirmware(firmwareDir);
        if (firmware.size <= 0 || firmware.size > MAX_FIRMWARE_BYTES) {
          json(res, 413, { error: 'firmware_too_large' });
          return;
        }
        const headers = {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(firmware.size),
          'X-Firmware-Name': firmware.name,
          'Cache-Control': 'no-store'
        };
        if (req.method === 'HEAD') {
          res.writeHead(200, headers);
          res.end();
          return;
        }
        const content = await readFile(firmware.path);
        if (content.length !== firmware.size) {
          json(res, 409, { error: 'firmware_changed' });
          return;
        }
        res.writeHead(200, headers);
        res.end(content);
      } catch (error) {
        const code = error instanceof Error && error.message === 'firmware_not_found'
          ? 'firmware_not_found'
          : 'firmware_unavailable';
        json(res, code === 'firmware_not_found' ? 404 : 503, { error: code });
      }
      return;
    }

    if (pathname.startsWith('/setup/updates/')) {
      if (!localUiRequest(req)) {
        req.resume();
        json(res, 403, { error: 'forbidden' });
        return;
      }
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      try {
        if (req.method === 'GET' && pathname === '/setup/updates/progress') {
          json(res, 200, { progress: updates.getProgress() });
          return;
        }
        if (req.method !== 'POST') {
          json(res, 405, { error: 'method_not_allowed' });
          return;
        }
        const body = await readJson(req);
        if (!isRecord(body)) throw new Error('invalid_request');
        if (pathname === '/setup/updates/target') {
          json(res, 200, { targetId: await updates.target(body.transport, body.portId) });
        } else if (typeof body.targetId !== 'string' || !body.targetId) {
          throw new Error('invalid_request');
        } else if (pathname === '/setup/updates/assets') {
          if (body.name !== 'animations.orb' && body.name !== 'sounds.json') throw new Error('invalid_asset');
          json(res, 200, await updates.upload(body.targetId, body.name, controller.signal));
        } else if (pathname === '/setup/updates/firmware') {
          json(res, 200, { ...await updates.upload(body.targetId, 'firmware.bin', controller.signal), ok: true, restarting: true });
        } else if (pathname === '/setup/updates/restart') {
          await updates.restart(body.targetId, controller.signal);
          json(res, 200, { restarting: true });
        } else {
          throw new Error('invalid_request');
        }
      } catch (error) {
        const code = error instanceof Error && /^[a-z][a-z0-9_]*$/.test(error.message) ? error.message : 'update_failed';
        const status = code === 'busy' || code === 'sd_unavailable' || code === 'update_target_expired' ? 409 :
          ['invalid_request', 'invalid_transport', 'invalid_asset', 'invalid_firmware_size'].includes(code) ? 400 :
          code === 'device_not_found' || code === 'firmware_not_found' ? 404 :
          ['serial_unavailable', 'invalid_orb_config', 'asset_not_published', 'asset_unavailable'].includes(code) ? 503 :
          code === 'orb_timeout' ? 504 : 502;
        if (!res.destroyed) json(res, status, { error: code });
      }
      return;
    }

    if (pathname === '/setup/audio/test') {
      req.resume();
      if (!localUiRequest(req)) {
        json(res, 403, { error: 'forbidden' });
        return;
      }
      if (req.method !== 'POST') {
        json(res, 405, { error: 'method_not_allowed' });
        return;
      }
      try {
        await testDeviceSound(await getOrbConfig());
        json(res, 202, { scheduled: true });
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        const conflicts = ['invalid_orb_config', 'destination_is_dashboard', 'sound_assets_unavailable',
          'sound_muted', 'quiet_hours_active', 'audio_busy', 'audio_test_unsupported'];
        const known = [...conflicts, 'orb_timeout', 'orb_unreachable', 'orb_unauthorized',
          'orb_settings_rejected', 'invalid_orb_response'];
        json(res, conflicts.includes(code) ? 409 : code === 'orb_timeout' ? 504 : 502,
          { error: known.includes(code) ? code : 'orb_audio_unavailable' });
      }
      return;
    }

    if (pathname === '/setup/demo') {
      req.resume();
      if (!localUiRequest(req)) {
        json(res, 403, { error: 'forbidden' });
        return;
      }
      if (req.method === 'GET') {
        json(res, 200, demo.status());
        return;
      }
      if (req.method === 'DELETE') {
        json(res, 200, await demo.stop());
        return;
      }
      if (req.method !== 'POST') {
        json(res, 405, { error: 'method_not_allowed' });
        return;
      }
      try {
        json(res, 202, await demo.start());
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        const conflicts = ['demo_running', 'demo_cancelled', 'invalid_orb_config', 'destination_is_dashboard', 'mona_simulation_unsupported',
          'no_observer_destinations', 'device_not_found', 'multiple_devices', 'orb_not_connected', 'busy'];
        const known = [...conflicts, 'orb_timeout', 'orb_unreachable', 'orb_unauthorized', 'orb_rejected', 'invalid_orb_response',
          'token_unavailable', 'unsupported_firmware'];
        json(res, conflicts.includes(code) ? 409 : code === 'orb_timeout' ? 504 : 502,
          { error: known.includes(code) ? code : 'demo_unavailable' });
      }
      return;
    }

    if (pathname === '/setup/settings') {
      if (!localUiRequest(req)) {
        req.resume();
        json(res, 403, { error: 'forbidden' });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'PUT') {
        req.resume();
        json(res, 405, { error: 'method_not_allowed' });
        return;
      }
      try {
        const update = req.method === 'PUT' ? parseDeviceSettingsUpdate(await readJson(req)) : undefined;
        if (update === null) {
          json(res, 400, { error: 'invalid_settings' });
          return;
        }
        json(res, 200, await deviceSettings(await getOrbConfig(), update));
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        const known = ['invalid_orb_config', 'destination_is_dashboard', 'orb_timeout', 'orb_unreachable',
          'orb_unauthorized', 'orb_settings_rejected', 'invalid_orb_response', 'invalid_json', 'payload_too_large'];
        const status = code === 'invalid_json' ? 400 : code === 'payload_too_large' ? 413 :
          code === 'invalid_orb_config' || code === 'destination_is_dashboard' ? 409 : code === 'orb_timeout' ? 504 : 502;
        json(res, status, { error: known.includes(code) ? code : 'orb_settings_unavailable' });
      }
      return;
    }

    if (pathname === '/setup/ports' || pathname === '/setup/install-observer' || pathname === '/setup/provision' ||
        pathname === '/setup/assets' || pathname === '/setup/assets/progress' || pathname === '/setup/restart') {
      if (!localUiRequest(req)) {
        json(res, 403, { error: 'forbidden' });
        return;
      }
      if (!usbSetup) {
        json(res, 503, { error: 'serial_unavailable' });
        return;
      }
      if (req.method === 'GET' && pathname === '/setup/ports') {
        try {
          json(res, 200, { ports: await usbSetup.listPorts() });
        } catch {
          json(res, 503, { error: 'serial_unavailable' });
        }
        return;
      }
      if (req.method === 'POST' && pathname === '/setup/provision') {
        try {
          const body = await readJson(req);
          if (!isRecord(body) || typeof body.portId !== 'string' ||
              typeof body.wifiSsid !== 'string' || typeof body.wifiPassword !== 'string') {
            json(res, 400, { error: 'invalid_request' });
            return;
          }
          json(res, 200, await usbSetup.provision({
            portId: body.portId,
            wifiSsid: body.wifiSsid,
            wifiPassword: body.wifiPassword
          }));
        } catch (error) {
          const code = error instanceof Error && /^[a-z][a-z0-9_]*$/.test(error.message) ? error.message : 'provision_failed';
          const status = code === 'busy' ? 409 : code === 'invalid_credentials' ? 400 : code === 'device_not_found' ? 404 : 502;
          json(res, status, { error: code });
        }
        return;
      }
      if (req.method === 'POST' && pathname === '/setup/install-observer') {
        try {
          const body = await readJson(req);
          if (!isRecord(body) || typeof body.portId !== 'string') {
            json(res, 400, { error: 'invalid_request' });
            return;
          }
          json(res, 200, await usbSetup.installObserver(body.portId));
        } catch (error) {
          const code = error instanceof Error && /^[a-z][a-z0-9_]*$/.test(error.message) ? error.message : 'observer_install_failed';
          const status = code === 'busy' ? 409 : code === 'device_not_found' ? 404 : 502;
          json(res, status, { error: code });
        }
        return;
      }
      if (pathname === '/setup/assets' || pathname === '/setup/assets/progress' || pathname === '/setup/restart') {
        if (!localUiRequest(req)) {
          json(res, 403, { error: 'forbidden' });
          return;
        }
        if (!usbSetup) {
          json(res, 503, { error: 'serial_unavailable' });
          return;
        }
        if (req.method === 'GET' && pathname === '/setup/assets/progress') {
          json(res, 200, { progress: usbSetup.getAssetUploadProgress() });
          return;
        }
        if (req.method === 'POST' && pathname === '/setup/assets') {
          const portId = url.searchParams.get('portId') ?? '';
          const requestedName = url.searchParams.get('name') ?? '';
          const name: UsbAssetName | undefined = requestedName === 'animations.orb' || requestedName === 'sounds.json'
            ? requestedName
            : undefined;
          const maxSize = name === 'animations.orb' ? 32 * 1024 * 1024 : name === 'sounds.json' ? 4096 : 0;
          if (!portId || !name || !maxSize) {
            json(res, 400, { error: 'invalid_asset' });
            return;
          }
          try {
            const content = await readFile(join(options.assetDir ?? join(root, 'dist/sdcard'), name));
            if (content.length === 0 || content.length > maxSize) {
              json(res, 503, { error: 'asset_unavailable' });
              return;
            }
            await usbSetup.uploadAsset(portId, name, content.length, Readable.from([content]));
            json(res, 200, { uploaded: name, size: content.length });
          } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
              json(res, 503, { error: 'asset_not_published' });
              return;
            }
            const code = error instanceof Error && /^[a-z][a-z0-9_]*$/.test(error.message) ? error.message : 'upload_failed';
            const status = code === 'busy' ? 409 : code === 'device_not_found' ? 404 :
              code === 'invalid_asset' || code === 'asset_size_mismatch' ? 400 :
              code === 'sd_unavailable' ? 409 : code === 'asset_not_published' || code === 'asset_unavailable' ? 503 : 502;
            json(res, status, { error: code });
          }
          return;
        }
        if (req.method === 'POST' && pathname === '/setup/restart') {
          try {
            const body = await readJson(req);
            if (!isRecord(body) || typeof body.portId !== 'string' || !body.portId) {
              json(res, 400, { error: 'invalid_request' });
              return;
            }
            await usbSetup.restart(body.portId);
            json(res, 200, { restarting: true });
          } catch (error) {
            const code = error instanceof Error && /^[a-z][a-z0-9_]*$/.test(error.message) ? error.message : 'restart_failed';
            const status = code === 'busy' ? 409 : code === 'device_not_found' ? 404 : 502;
            json(res, status, { error: code });
          }
          return;
        }
        json(res, 405, { error: 'method_not_allowed' });
        return;
      }
      json(res, 405, { error: 'method_not_allowed' });
      return;
    }

    if (apiPaths.includes(pathname) && !authorized()) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }

    if (req.method === 'POST' && pathname === '/event') {
      try {
        const payload = await readJson(req);
        const event = isRecord(payload) ? payload.event : undefined;
        if (typeof event === 'string' && event.startsWith('observer') && !observerEvent(event)) {
          json(res, 400, { error: 'invalid_observer_event' });
        } else if (observerEvent(event)) {
          const error = engine.handleObserver(payload);
          recordDebugMessage(payload, !error, error ?? undefined);
          json(res, error ? error === 'invalid_observer_event' ? 400 : 409 : 202,
            error ? { error } : { accepted: true });
        } else {
          const accepted = engine.handleEvent(payload);
          recordDebugMessage(payload, accepted, accepted ? undefined : 'event_rejected');
          json(res, 202, { accepted });
        }
      } catch (error) {
        const status = requestStatus(error);
        const code = status === 413 ? 'payload_too_large' : 'invalid_json';
        recordDebugMessage(undefined, false, code);
        json(res, status, { error: code });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/state') {
      json(res, 200, engine.state());
      return;
    }

    if (req.method === 'GET' && pathname === '/messages') {
      json(res, 200, { messages: debugMessages });
      return;
    }

    if (req.method === 'GET' && pathname === '/settings') {
      json(res, 200, engine.getSettings());
      return;
    }

    if (req.method === 'PUT' && pathname === '/settings') {
      try {
        if (!engine.setSettings(await readJson(req))) {
          json(res, 400, { error: 'invalid_settings' });
          return;
        }
        json(res, 200, engine.getSettings());
      } catch (error) {
        const status = requestStatus(error);
        json(res, status, { error: status === 413 ? 'payload_too_large' : 'invalid_json' });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/github/status') {
      await githubTokenReady;
      const status = githubPoller?.status() ?? { enabled: false, status: 'disabled', lastSuccessMs: null, error: null };
      json(res, 200, {
        ...status,
        source: githubTokenStorageError ? 'error' : githubTokenSource,
        configurationError: githubTokenStorageError
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/github/acknowledge') {
      try {
        const body = await readJson(req);
        if (!isRecord(body) || typeof body.id !== 'string' || !body.id || body.id.length > 128) {
          json(res, 400, { error: 'invalid_alert_id' });
          return;
        }
        if (!engine.acknowledgeAlert(body.id)) {
          json(res, 409, { error: 'alert_changed' });
          return;
        }
        json(res, 200, { acknowledged: true });
      } catch (error) {
        const status = requestStatus(error);
        json(res, status, { error: status === 413 ? 'payload_too_large' : 'invalid_json' });
      }
      return;
    }

    if (req.method === 'PUT' && pathname === '/github/token') {
      let body: unknown;
      try {
        body = await readJson(req);
      } catch (error) {
        const status = requestStatus(error);
        json(res, status, { error: status === 413 ? 'payload_too_large' : 'invalid_json' });
        return;
      }
      if (!isRecord(body) || typeof body.token !== 'string' || body.token.length > 512) {
        json(res, 400, { error: 'invalid_token' });
        return;
      }
      await githubTokenReady;
      if (!githubPoller) {
        json(res, 503, { error: 'github_polling_unavailable' });
        return;
      }
      if (githubTokenEnvironmentManaged) {
        json(res, 409, { error: 'github_token_environment_managed' });
        return;
      }
      try {
        const nextToken = body.token.trim();
        await saveGitHubToken(nextToken, githubTokenPath);
        githubPoller.setToken(nextToken);
        githubTokenSource = nextToken ? 'saved' : 'none';
        githubTokenStorageError = null;
        json(res, 200, { ...githubPoller.status(), source: githubTokenSource, configurationError: null });
      } catch (error) {
        console.error('Could not save dashboard GitHub settings:', error);
        json(res, 503, { error: 'github_config_unavailable' });
      }
      return;
    }

    if (pathname === '/setup/install-dashboard-observer') {
      if (!localUiRequest(req)) {
        req.resume();
        json(res, 403, { error: 'forbidden' });
        return;
      }
      if (req.method !== 'POST') {
        req.resume();
        json(res, 405, { error: 'method_not_allowed' });
        return;
      }
      const host = process.env.ORB_DASHBOARD_OBSERVER_HOST || '127.0.0.1';
      const port = Number(process.env.ORB_DASHBOARD_PUBLISHED_PORT ?? process.env.ORB_DASHBOARD_PORT ?? 7420);
      if (!token || !Number.isInteger(port) || port < 1 || port > 65535) {
        json(res, 409, { error: !token ? 'dashboard_observer_token_required' : 'invalid_dashboard_observer_target' });
        return;
      }
      const configPath = copilotOrbConfigPath();
      try {
        await saveOrbEndpoint({ id: 'dashboard', host, port, token }, configPath);
        const extensionPath = await installObserver(configPath);
        json(res, 200, { host, port, configPath, extensionPath });
      } catch (error) {
        const code = error instanceof Error && /^[a-z][a-z0-9_]*$/.test(error.message)
          ? error.message
          : 'observer_install_failed';
        const status = ['invalid_orb_config', 'unsafe_config_path', 'observer_install_failed'].includes(code) ? 409 : 500;
        console.error('Could not install the local dashboard Copilot extension:', error);
        json(res, status, { error: code });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/ota') {
      if (!localUiRequest(req)) {
        req.resume();
        json(res, 403, { error: 'forbidden' });
        return;
      }
      try {
        proxyFirmwareUpload(req, res, await getOrbConfig());
      } catch (error) {
        req.resume();
        const code = error instanceof Error && error.message === 'invalid_orb_config'
          ? 'orb_not_configured'
          : 'orb_config_unavailable';
        json(res, 503, { error: code });
      }
      return;
    }

    if (pathname === '/') {
      res.writeHead(302, { Location: '/dashboard/' });
      res.end();
      return;
    }

    const dashboardPath = pathname === '/dashboard' ? '/dashboard/' : pathname;
    const mappedPath = dashboardPath.startsWith('/dashboard/') ? `/dashboard/${dashboardPath.slice('/dashboard/'.length)}` : dashboardPath;
    const relative = mappedPath.endsWith('/') ? `${mappedPath}index.html` : mappedPath;
    const candidate = resolve(root, `.${relative}`);
    const allowedRoots = ['dashboard', 'dist', 'media', 'protocol'].map((dir) => resolve(root, dir));
    if (!allowedRoots.some((allowed) => candidate === allowed || candidate.startsWith(`${allowed}${sep}`))) {
      json(res, 403, { error: 'forbidden' });
      return;
    }

    try {
      const info = await stat(candidate);
      if (!info.isFile()) throw new Error('Not a file');
      const data = await readFile(candidate);
      res.writeHead(200, {
        'Content-Type': MIME[extname(candidate)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(data);
    } catch {
      json(res, 404, { error: 'not_found' });
    }
  });

  server.on('close', () => {
    githubPoller?.stop();
    void demo.stop();
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.ORB_DASHBOARD_PORT || 7420);
  const host = process.env.ORB_DASHBOARD_HOST || '127.0.0.1';
  const usbSetup = process.env.ORB_USB_SETUP === 'off' ? false : new (await import('./usb-setup.js')).NodeUsbSetupService();
  const server = createDashboardServer({ usbSetup });
  server.listen(port, host, () => {
    const published = process.env.ORB_DASHBOARD_PUBLISHED_PORT;
    console.log(`Orb Dashboard listening on port ${port}${published ? ` (container); open http://127.0.0.1:${published}/dashboard/` : `: http://127.0.0.1:${port}/dashboard/`}`);
  });
}
