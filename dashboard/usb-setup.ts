import { randomBytes } from 'node:crypto';
import { access, readFile, realpath, readdir } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { SerialPort } from 'serialport';
import { copilotOrbConfigPath, saveOrbEndpoint } from '../observer/config-store.js';
import type { OrbConnectionConfig } from '../observer/config-store.js';
import { installObserver } from '../observer/install-observer.js';

const RESPONSE_PREFIX = '@ORB ';
const PROTOCOL_VERSION = 1;

export interface UsbPortInfo {
  id: string;
  path: string;
  label: string;
  serialNumber: string | null;
  vendorId: string | null;
  productId: string | null;
}

export interface UsbProvisionRequest {
  portId: string;
  wifiSsid: string;
  wifiPassword: string;
}

export interface UsbProvisionResult {
  host: string;
  port: number;
  configSaved: true;
}

export interface UsbObserverInstallResult {
  host: string;
  port: number;
  configPath: string;
  extensionPath: string;
}

export interface UsbAssetUploadProgress {
  name: UsbAssetName | 'firmware.bin';
  size: number;
  sent: number;
  phase: 'connecting' | 'transferring' | 'validating';
}

export type UsbAssetName = 'animations.orb' | 'sounds.json';

export interface UsbSetupService {
  listPorts(): Promise<UsbPortInfo[]>;
  installObserver(portId: string): Promise<UsbObserverInstallResult>;
  provision(request: UsbProvisionRequest): Promise<UsbProvisionResult>;
  uploadAsset(portId: string, name: UsbAssetName, size: number, source: AsyncIterable<Uint8Array>): Promise<void>;
  uploadFirmware(portId: string, size: number, source: AsyncIterable<Uint8Array>): Promise<void>;
  getAssetUploadProgress(): UsbAssetUploadProgress | null;
  restart(portId: string): Promise<void>;
  // Reads the connected Orb's Wi-Fi address and token without saving them.
  readOrbConnection?(): Promise<OrbConnectionConfig>;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function readSysAttribute(path: string): Promise<string | null> {
  try {
    const value = (await readFile(path, 'utf8')).trim();
    return value || null;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

export async function listLinuxSerialPorts(sysRoot = '/sys', devRoot = '/dev'): Promise<UsbPortInfo[]> {
  const resolvedSysRoot = await realpath(sysRoot);
  const ttyRoot = join(resolvedSysRoot, 'class', 'tty');
  const names = await readdir(ttyRoot);
  const ports: UsbPortInfo[] = [];

  for (const name of names) {
    if (!/^(?:tty(?:S|WCH|ACM|USB|AMA|MFD|O|XRUSB)|rfcomm)/.test(name)) continue;
    const path = join(devRoot, name);
    try {
      await access(path);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }

    let devicePath: string;
    try {
      devicePath = await realpath(join(ttyRoot, name, 'device'));
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (!devicePath.startsWith(`${resolvedSysRoot}${sep}`)) continue;

    for (let directory = devicePath; directory !== resolvedSysRoot; directory = dirname(directory)) {
      const vendorId = await readSysAttribute(join(directory, 'idVendor'));
      const productId = await readSysAttribute(join(directory, 'idProduct'));
      if (!vendorId || !productId) continue;
      const [manufacturer, serialNumber] = await Promise.all([
        readSysAttribute(join(directory, 'manufacturer')),
        readSysAttribute(join(directory, 'serial'))
      ]);
      ports.push({
        id: path,
        path,
        label: manufacturer ? `${manufacturer} (${path})` : path,
        serialNumber,
        vendorId: vendorId.toLowerCase(),
        productId: productId.toLowerCase()
      });
      break;
    }
  }
  return ports;
}

export interface ControlResponse {
  orb: string;
  v: number;
  id: string;
  ok: boolean;
  error?: string;
  result?: {
    configured?: boolean;
    connected?: boolean;
    ip?: string;
    hostname?: string;
    port?: number;
    token?: string;
    usbFirmwareUpdate?: boolean;
    updateReceived?: number;
    operation?: { id?: string; success?: boolean; error?: string };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isControlResponse(value: unknown): value is ControlResponse {
  if (!isRecord(value) || value.orb !== 'control' || value.v !== PROTOCOL_VERSION ||
      typeof value.id !== 'string' || !value.id || typeof value.ok !== 'boolean' ||
      (value.error !== undefined && typeof value.error !== 'string')) return false;
  if (value.result === undefined) return true;
  if (!isRecord(value.result)) return false;
  const result = value.result;
  if ((result.configured !== undefined && typeof result.configured !== 'boolean') ||
      (result.connected !== undefined && typeof result.connected !== 'boolean') ||
      (result.ip !== undefined && typeof result.ip !== 'string') ||
      (result.hostname !== undefined && typeof result.hostname !== 'string') ||
      (result.port !== undefined && (!Number.isInteger(result.port) || Number(result.port) < 1 || Number(result.port) > 65535)) ||
      (result.token !== undefined && typeof result.token !== 'string')) return false;
  if ((result.usbFirmwareUpdate !== undefined && typeof result.usbFirmwareUpdate !== 'boolean') ||
      (result.updateReceived !== undefined && (!Number.isSafeInteger(result.updateReceived) || Number(result.updateReceived) < 0))) return false;
  if (result.operation === undefined) return true;
  return isRecord(result.operation) &&
    (result.operation.id === undefined || typeof result.operation.id === 'string') &&
    (result.operation.success === undefined || typeof result.operation.success === 'boolean') &&
    (result.operation.error === undefined || typeof result.operation.error === 'string');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function asErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^[a-z][a-z0-9_]*$/.test(message) ? message : 'serial_error';
}

export interface UsbControlSession {
  request(command: string, fields?: Record<string, unknown>, timeoutMs?: number): Promise<ControlResponse>;
  writeBytes(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

class ControlSession implements UsbControlSession {
  private buffer = '';
  private nextId = 0;
  private pending = new Map<string, { resolve: (response: ControlResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly port: SerialPort) {
    port.on('data', (chunk: Buffer) => this.consume(chunk));
    port.on('error', () => this.rejectAll(new Error('serial_error')));
    port.on('close', () => this.rejectAll(new Error('disconnected')));
  }

  static async open(path: string): Promise<ControlSession> {
    const port = new SerialPort({
      path, baudRate: 115200, autoOpen: false,
      ...(process.platform === 'darwin' ? { vmin: 0, vtime: 1 } : {})
    });
    try {
      await new Promise<void>((resolve, reject) => port.open((error) => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => port.set({ dtr: false, rts: false }, (error) => error ? reject(error) : resolve()));
      return new ControlSession(port);
    } catch (error) {
      if (port.isOpen) {
        try {
          await new Promise<void>((resolve, reject) => port.close((closeError) => closeError ? reject(closeError) : resolve()));
        } catch (closeError) {
          throw new AggregateError([error, closeError], 'Could not initialize or close the serial port');
        }
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    this.rejectAll(new Error('disconnected'));
    if (!this.port.isOpen) return;
    await new Promise<void>((resolve, reject) => this.port.close((error) => error ? reject(error) : resolve()));
  }

  async request(command: string, fields: Record<string, unknown> = {}, timeoutMs = 2500): Promise<ControlResponse> {
    const id = `host-${++this.nextId}`;
    const payload = `${JSON.stringify({ v: PROTOCOL_VERSION, id, cmd: command, ...fields })}\n`;
    const response = new Promise<ControlResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    // The timeout can fire while write/drain is still pending. Mark the
    // rejection handled immediately; awaiting below still propagates it.
    void response.catch(() => {});
    try {
      await new Promise<void>((resolve, reject) => this.port.write(payload, (error) => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => this.port.drain((error) => error ? reject(error) : resolve()));
    } catch (error) {
      const waiter = this.pending.get(id);
      if (waiter) clearTimeout(waiter.timer);
      this.pending.delete(id);
      throw error;
    }
    const reply = await response;
    if (!reply.ok) throw new Error(reply.error || 'protocol_error');
    return reply;
  }

  async writeBytes(bytes: Uint8Array): Promise<void> {
    await new Promise<void>((resolve, reject) => this.port.write(Buffer.from(bytes), (error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => this.port.drain((error) => error ? reject(error) : resolve()));
  }

  private consume(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    if (this.buffer.length > 16384) this.buffer = this.buffer.slice(-8192);
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.startsWith(RESPONSE_PREFIX)) continue;
      try {
        const parsed: unknown = JSON.parse(line.slice(RESPONSE_PREFIX.length));
        if (!isControlResponse(parsed)) continue;
        const waiter = this.pending.get(parsed.id);
        if (!waiter) continue;
        clearTimeout(waiter.timer);
        this.pending.delete(parsed.id);
        waiter.resolve(parsed);
      } catch {
        // Ignore truncated diagnostics and unrelated serial output.
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }
}

async function handshake(session: UsbControlSession, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      await session.request('hello', {}, 1200);
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error('unsupported_firmware');
}

function validCredentials(ssid: string, password: string): boolean {
  const ssidBytes = Buffer.byteLength(ssid, 'utf8');
  const passwordBytes = Buffer.byteLength(password, 'utf8');
  return ssidBytes > 0 && ssidBytes <= 32 && (passwordBytes === 0 || (passwordBytes >= 8 && passwordBytes <= 63));
}

export class NodeUsbSetupService implements UsbSetupService {
  private busy = false;
  private assetUploadProgress: UsbAssetUploadProgress | null = null;

  constructor(private readonly options: {
    openSession?: (path: string) => Promise<UsbControlSession>;
    listPorts?: () => Promise<UsbPortInfo[]>;
  } = {}) {}

  getAssetUploadProgress(): UsbAssetUploadProgress | null {
    return this.assetUploadProgress ? { ...this.assetUploadProgress } : null;
  }

  async listPorts(): Promise<UsbPortInfo[]> {
    if (this.options.listPorts) return this.options.listPorts();
    const serialPorts = process.platform === 'linux'
      ? await listLinuxSerialPorts()
      : await SerialPort.list();
    return serialPorts.flatMap((port) => {
      const path = port.path;
      if (!path || port.vendorId?.toLowerCase() !== '303a' || port.productId?.toLowerCase() !== '1001') return [];
      return [{
        id: path,
        path,
        label: port.manufacturer ? `${port.manufacturer} (${path})` : path,
        serialNumber: port.serialNumber ?? null,
        vendorId: port.vendorId ?? null,
        productId: port.productId ?? null
      }];
    });
  }

  async provision(request: UsbProvisionRequest): Promise<UsbProvisionResult> {
    if (this.busy) throw new Error('busy');
    if (!request || typeof request.portId !== 'string' || typeof request.wifiSsid !== 'string' || typeof request.wifiPassword !== 'string' || !validCredentials(request.wifiSsid, request.wifiPassword)) {
      throw new Error('invalid_credentials');
    }

    const selected = (await this.listPorts()).find((port) => port.id === request.portId);
    if (!selected) throw new Error('device_not_found');
    this.busy = true;
    const operationId = randomBytes(12).toString('hex');
    try {
      let initial: ControlSession | undefined;
      try {
        initial = await ControlSession.open(selected.path);
        await handshake(initial, Date.now() + 8000);
        await initial.request('configure', {
          operationId,
          ssid: request.wifiSsid,
          password: request.wifiPassword
        }, 4000);
      } finally {
        await initial?.close();
      }

      const deadline = Date.now() + 55000;
      await delay(1200);
      while (Date.now() < deadline) {
        let session: ControlSession | undefined;
        let config: { host: string; port: number; token: string } | undefined;
        try {
          const ports = await this.listPorts();
          const current = ports.find((port) => port.path === selected.path) ??
            ports.find((port) => selected.serialNumber && port.serialNumber === selected.serialNumber);
          if (!current) {
            await delay(500);
            continue;
          }
          session = await ControlSession.open(current.path);
          await handshake(session, Math.min(deadline, Date.now() + 4000));
          const status = (await session.request('status')).result;
          const operation = status?.operation;
          if (operation?.id !== operationId) {
            await delay(500);
            continue;
          }
          if (!operation.success) throw new Error(operation.error || 'wifi_failed');
          if (!status?.configured || !status.connected || !status.ip || !status.port) {
            await delay(500);
            continue;
          }
          const token = (await session.request('token')).result?.token;
          if (!token) throw new Error('token_unavailable');
          config = { host: status.ip, port: status.port, token };
        } catch (error) {
          const code = asErrorCode(error);
          if (['wifi_failed', 'token_unavailable'].includes(code)) throw error;
          await delay(500);
        } finally {
          await session?.close();
        }
        if (config) {
          await saveOrbEndpoint({ ...config, id: 'orb' });
          return { host: config.host, port: config.port, configSaved: true };
        }
      }
      throw new Error('timeout');
    } finally {
      this.busy = false;
    }
  }

  async readOrbConnection(): Promise<OrbConnectionConfig> {
    if (this.busy) throw new Error('busy');
    const ports = await this.listPorts();
    if (!ports.length) throw new Error('device_not_found');
    if (ports.length > 1) throw new Error('multiple_devices');
    this.busy = true;
    let session: UsbControlSession | undefined;
    try {
      session = await (this.options.openSession ?? ControlSession.open)(ports[0].path);
      await handshake(session, Date.now() + 8000);
      const status = (await session.request('status')).result;
      if (!status?.configured || !status.connected || !status.ip || !status.port) throw new Error('orb_not_connected');
      const token = (await session.request('token')).result?.token;
      if (!token) throw new Error('token_unavailable');
      return { host: status.ip, port: status.port, token };
    } finally {
      await session?.close();
      this.busy = false;
    }
  }

  async installObserver(portId: string): Promise<UsbObserverInstallResult> {
    if (this.busy) throw new Error('busy');
    const selected = (await this.listPorts()).find((port) => port.id === portId);
    if (!selected) throw new Error('device_not_found');
    this.busy = true;
    let session: ControlSession | undefined;
    try {
      session = await ControlSession.open(selected.path);
      await handshake(session, Date.now() + 8000);
      const status = (await session.request('status')).result;
      if (!status?.configured || !status.connected || !status.ip || !status.port) throw new Error('orb_not_connected');
      const token = (await session.request('token')).result?.token;
      if (!token) throw new Error('token_unavailable');
      const configPath = copilotOrbConfigPath();
      await saveOrbEndpoint({ id: 'orb', host: status.ip, port: status.port, token }, configPath);
      const extensionPath = await installObserver(configPath);
      return { host: status.ip, port: status.port, configPath, extensionPath };
    } finally {
      await session?.close();
      this.busy = false;
    }
  }

  async uploadAsset(portId: string, name: UsbAssetName, size: number, source: AsyncIterable<Uint8Array>): Promise<void> {
    if (name !== 'animations.orb' && name !== 'sounds.json') throw new Error('invalid_asset');
    return this.upload(portId, name, size, source);
  }

  async uploadFirmware(portId: string, size: number, source: AsyncIterable<Uint8Array>): Promise<void> {
    return this.upload(portId, 'firmware.bin', size, source);
  }

  private async upload(portId: string, name: UsbAssetName | 'firmware.bin', size: number, source: AsyncIterable<Uint8Array>): Promise<void> {
    if (this.busy) throw new Error('busy');
    const firmware = name === 'firmware.bin';
    const maxSize = firmware ? 0x300000 : name === 'animations.orb' ? 32 * 1024 * 1024 : 4096;
    if (!Number.isSafeInteger(size) || size <= 0 || size > maxSize) {
      throw new Error(firmware ? 'invalid_firmware_size' : 'invalid_asset');
    }
    this.busy = true;
    this.assetUploadProgress = { name, size, sent: 0, phase: 'connecting' };
    let session: UsbControlSession | undefined;
    let chunked = false;
    let awaitingBytes = false;
    try {
      const selected = (await this.listPorts()).find((port) => port.id === portId);
      if (!selected) throw new Error('device_not_found');
      session = await (this.options.openSession ?? ControlSession.open)(selected.path);
      await handshake(session, Date.now() + 8000);
      const status = await session.request('status');
      chunked = status.result?.usbFirmwareUpdate === true;
      if (firmware && !chunked) throw new Error('unsupported_firmware');
      await session.request(firmware ? 'firmware_begin' : 'asset_begin', { name, size, chunked }, 5000);
      this.assetUploadProgress.phase = 'transferring';
      let sent = 0;
      for await (const chunk of source) {
        for (let offset = 0; offset < chunk.byteLength; offset += 4096) {
          const part = chunk.subarray(offset, Math.min(offset + 4096, chunk.byteLength));
          const nextSent = sent + part.byteLength;
          if (nextSent > size) throw new Error('asset_size_mismatch');
          if (chunked) await session.request('update_chunk', { size: part.byteLength });
          awaitingBytes = true;
          await session.writeBytes(part);
          awaitingBytes = false;
          if (chunked) {
            const status = await session.request('update_status', {}, 10000);
            if (status.result?.updateReceived !== nextSent) throw new Error('update_size_mismatch');
          }
          sent = nextSent;
          this.assetUploadProgress.sent = sent;
        }
      }
      if (sent !== size) throw new Error('asset_size_mismatch');
      this.assetUploadProgress.phase = 'validating';
      await session.request(firmware ? 'firmware_commit' : 'asset_commit', { name }, 10000);
    } catch (error) {
      // Never send JSON into an incomplete raw chunk. The device timeout aborts it.
      if (session && chunked && !awaitingBytes) {
        try {
          await session.request('update_abort');
        } catch (abortError) {
          throw new AggregateError([error, abortError], 'upload_and_abort_failed');
        }
      }
      throw error;
    } finally {
      try {
        await session?.close();
      } finally {
        this.assetUploadProgress = null;
        this.busy = false;
      }
    }
  }

  async restart(portId: string): Promise<void> {
    if (this.busy) throw new Error('busy');
    const selected = (await this.listPorts()).find((port) => port.id === portId);
    if (!selected) throw new Error('device_not_found');
    this.busy = true;
    let session: ControlSession | undefined;
    try {
      session = await ControlSession.open(selected.path);
      await handshake(session, Date.now() + 8000);
      await session.request('restart');
    } finally {
      await session?.close();
      this.busy = false;
    }
  }
}
