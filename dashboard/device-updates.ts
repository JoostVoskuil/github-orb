import http from 'node:http';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OrbConnectionConfig } from '../observer/config-store.js';
import type { UsbAssetName, UsbAssetUploadProgress, UsbSetupService } from './usb-setup.js';

export type UpdateTransport = 'wifi' | 'usb';
type Target = { transport: 'wifi'; config: OrbConnectionConfig; expires: number } |
  { transport: 'usb'; portId: string; expires: number };

export async function latestFirmware(directory: string): Promise<{ name: string; path: string; size: number }> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new Error('firmware_not_found');
    throw error;
  }
  const artifacts = await Promise.all(entries
    .filter(name => /^[A-Za-z0-9._-]+\.bin$/i.test(name))
    .map(async name => ({ name, path: join(directory, name), info: await lstat(join(directory, name)) })));
  const latest = artifacts.filter(file => file.info.isFile())
    .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs || b.name.localeCompare(a.name))[0];
  if (!latest) throw new Error('firmware_not_found');
  return { name: latest.name, path: latest.path, size: latest.info.size };
}

export class DeviceUpdates {
  private targets = new Map<string, Target>();
  private busy = false;
  private progress: UsbAssetUploadProgress | null = null;

  constructor(private readonly options: {
    usb?: UsbSetupService;
    config: () => Promise<OrbConnectionConfig>;
    assetDir: string;
    firmwareDir: string;
  }) {}

  async target(transport: unknown, portId: unknown): Promise<string> {
    for (const [id, target] of this.targets) if (target.expires < Date.now()) this.targets.delete(id);
    if (this.targets.size >= 64) throw new Error('too_many_update_targets');
    const expires = Date.now() + 30 * 60_000;
    let target: Target;
    if (transport === 'wifi') target = { transport, config: { ...await this.options.config() }, expires };
    else if (transport === 'usb') {
      if (!this.options.usb) throw new Error('serial_unavailable');
      if (typeof portId !== 'string' || !portId) throw new Error('device_not_found');
      if (!(await this.options.usb.listPorts()).some(port => port.id === portId)) throw new Error('device_not_found');
      target = { transport, portId, expires };
    } else throw new Error('invalid_transport');
    const id = randomUUID();
    this.targets.set(id, target);
    return id;
  }

  getProgress(): UsbAssetUploadProgress | null {
    return this.options.usb?.getAssetUploadProgress() ?? (this.progress ? { ...this.progress } : null);
  }

  private getTarget(id: string): Target {
    const target = this.targets.get(id);
    if (!target || target.expires < Date.now()) throw new Error('update_target_expired');
    return target;
  }

  async upload(id: string, requestedName: string, signal?: AbortSignal): Promise<{ uploaded: string; size: number }> {
    if (this.busy) throw new Error('busy');
    this.busy = true;
    try {
      const target = this.getTarget(id);
      const firmware = requestedName === 'firmware.bin';
      if (!firmware && requestedName !== 'animations.orb' && requestedName !== 'sounds.json') throw new Error('invalid_asset');
      const name: UsbAssetName | 'firmware.bin' = requestedName;
      let path: string;
      if (firmware) {
        path = (await latestFirmware(this.options.firmwareDir)).path;
      } else path = join(this.options.assetDir, name);
      const info = await lstat(path);
      const maximum = firmware ? 0x300000 : name === 'animations.orb' ? 32 * 1024 * 1024 : 4096;
      if (!info.isFile() || info.size <= 0 || info.size > maximum) throw new Error(firmware ? 'invalid_firmware_size' : 'asset_unavailable');
      this.progress = { name, size: info.size, sent: 0, phase: 'connecting' };
      const source = createReadStream(path, { highWaterMark: 4096, signal });
      try {
        if (target.transport === 'usb') {
          if (name === 'firmware.bin') await this.options.usb.uploadFirmware(target.portId, info.size, source);
          else await this.options.usb.uploadAsset(target.portId, name, info.size, source);
        } else {
          await this.wifi(target.config, firmware ? '/ota' : `/assets?name=${name}`, source, info.size, signal);
        }
      } finally {
        source.destroy();
      }
      return { uploaded: name, size: info.size };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        throw new Error(requestedName === 'firmware.bin' ? 'firmware_not_found' : 'asset_not_published');
      throw error;
    } finally {
      this.progress = null;
      this.busy = false;
    }
  }

  async restart(id: string, signal?: AbortSignal): Promise<void> {
    if (this.busy) throw new Error('busy');
    this.busy = true;
    try {
      const target = this.getTarget(id);
      if (target.transport === 'usb') await this.options.usb.restart(target.portId);
      else await this.wifi(target.config, '/restart', undefined, 0, signal);
    } finally {
      this.busy = false;
    }
  }

  private wifi(config: OrbConnectionConfig, path: string, source: ReturnType<typeof createReadStream> | undefined,
    size: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = http.request({
        hostname: config.host, port: config.port, path, method: 'POST', signal,
        headers: {
          Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/octet-stream', 'Content-Length': size,
          ...(path.startsWith('/assets?') ? { 'X-Orb-Asset': new URL(path, 'http://orb').searchParams.get('name') } : {})
        }
      }, response => {
        const chunks: Buffer[] = [];
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > 4096) request.destroy(new Error('invalid_orb_response'));
          else chunks.push(chunk);
        });
        response.on('error', error => request.destroy(error));
        response.on('end', () => {
          let body: unknown;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { reject(new Error('invalid_orb_response')); return; }
          if (response.statusCode === 404) { reject(new Error('unsupported_firmware')); return; }
          if (response.statusCode === 401 || response.statusCode === 403) { reject(new Error('orb_unauthorized')); return; }
          if (response.statusCode !== 200) {
            const error = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' &&
              /^[a-z][a-z0-9_]*$/.test(body.error) ? body.error : 'update_rejected';
            reject(new Error(error));
            return;
          }
          if (!body || typeof body !== 'object' ||
              (path === '/restart' ? !('restarting' in body && body.restarting === true) : !('ok' in body && body.ok === true))) {
            reject(new Error('invalid_orb_response'));
            return;
          }
          resolve();
        });
      });
      request.setTimeout(120_000, () => request.destroy(new Error('orb_timeout')));
      request.on('error', error => {
        reject(new Error(['orb_timeout', 'invalid_orb_response'].includes(error.message) ? error.message : 'orb_unreachable'));
      });
      if (source) {
        source.on('error', error => request.destroy(error));
        source.on('data', chunk => {
          if (this.progress) {
            this.progress.sent += chunk.length;
            this.progress.phase = this.progress.sent === size ? 'validating' : 'transferring';
          }
        });
        source.pipe(request);
      } else request.end();
    });
  }
}
