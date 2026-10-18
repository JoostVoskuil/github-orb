import { randomUUID } from "node:crypto"
import { constants, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export interface OrbConnectionConfig {
  host: string
  port: number
  token: string
  id?: string
  [key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)))

export function orbConfigPath(): string {
  const configured = process.env.ORB_CONFIG
  if (!configured) return join(root, "observer", "config.json")
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured)
}

export function copilotOrbConfigPath(): string {
  const home = resolve(process.env.COPILOT_HOME || join(homedir(), ".copilot"))
  return join(home, "orb", "config.json")
}

function validHost(host: string): boolean {
  return host.length > 0 && host.length <= 253 && !/[\s/:?#\\]/.test(host)
}

function validConnection(value: unknown): value is OrbConnectionConfig {
  if (!isRecord(value)) return false
  return typeof value.host === "string" && validHost(value.host) &&
    Number.isInteger(value.port) && Number(value.port) >= 1 && Number(value.port) <= 65535 &&
    typeof value.token === "string" && value.token.length > 0 &&
    (value.id === undefined || (typeof value.id === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value.id)))
}

function withEnvironmentOverrides(endpoint: OrbConnectionConfig): OrbConnectionConfig {
  const host = process.env.ORB_HOST || endpoint.host
  const port = Number(process.env.ORB_PORT || endpoint.port)
  const token = process.env.ORB_TOKEN || endpoint.token
  if (!validHost(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !token) {
    throw new Error("invalid_orb_config")
  }
  return { ...endpoint, host, port, token }
}

export async function loadOrbEndpoints(path = orbConfigPath()): Promise<OrbConnectionConfig[]> {
  const endpoints = await loadSavedOrbEndpoints(path)
  if (!endpoints.length) throw new Error("no_observer_destinations")
  return endpoints.map((endpoint, index) =>
    index === 0 ? withEnvironmentOverrides(endpoint) : endpoint)
}

export async function loadSavedOrbEndpoints(path = orbConfigPath()): Promise<OrbConnectionConfig[]> {
  let parsed: unknown = {}
  try {
    parsed = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (!isRecord(parsed)) throw new Error("invalid_orb_config")
  const file = parsed
  let endpoints: OrbConnectionConfig[]
  if (file.endpoints !== undefined) {
    if (!Array.isArray(file.endpoints) || !file.endpoints.every(validConnection)) {
      throw new Error("invalid_orb_config")
    }
    endpoints = file.endpoints
  } else {
    const legacy = {
      host: file.host || "github-orb.local",
      port: Number(file.port || 7420),
      token: file.token
    }
    if (!validConnection(legacy)) throw new Error("invalid_orb_config")
    endpoints = [legacy]
  }
  return endpoints
}

export async function loadOrbConfig(path = orbConfigPath()): Promise<OrbConnectionConfig> {
  return (await loadOrbEndpoints(path))[0]
}

export async function saveOrbConfig(connection: OrbConnectionConfig, path = orbConfigPath()): Promise<void> {
  if (!validHost(connection.host) || !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535 || !connection.token) {
    throw new Error("invalid_orb_config")
  }

  await mkdir(dirname(path), { recursive: true })
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("unsafe_config_path")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  let previous: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    if (!isRecord(parsed)) throw new Error("invalid_orb_config")
    previous = parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  const next = { ...previous, host: connection.host, port: connection.port, token: connection.token }
  await writeOrbConfig(next, path)
}

async function writeOrbConfig(next: Record<string, unknown>, path: string): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.config.tmp`)
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Could not replace Orb config or remove its temporary file")
    }
    throw error
  }
  const directory = await open(dirname(path), constants.O_RDONLY)
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

export async function saveOrbEndpoint(
  connection: OrbConnectionConfig & { id: string },
  path = orbConfigPath()
): Promise<void> {
  if (!validConnection(connection)) throw new Error("invalid_orb_config")
  await mkdir(dirname(path), { recursive: true })
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("unsafe_config_path")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  let previous: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    if (!isRecord(parsed)) throw new Error("invalid_orb_config")
    previous = parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  let endpoints: OrbConnectionConfig[] = []
  if (previous.endpoints !== undefined) {
    if (!Array.isArray(previous.endpoints) || !previous.endpoints.every(validConnection)) {
      throw new Error("invalid_orb_config")
    }
    endpoints = previous.endpoints
  } else if (validConnection(previous)) {
    endpoints = [{ id: "orb", host: previous.host, port: Number(previous.port), token: previous.token }]
  }
  let index = endpoints.findIndex((item) => item.id === connection.id)
  if (index < 0) {
    index = endpoints.findIndex((item) =>
      item.id === undefined && item.host === connection.host && item.port === connection.port)
  }
  if (index >= 0) endpoints[index] = { ...endpoints[index], ...connection }
  else endpoints.push(connection)
  const next = { ...previous, host: connection.host, port: connection.port, token: connection.token, endpoints }
  await writeOrbConfig(next, path)
}

export async function removeOrbEndpoint(
  destination: { id?: string; host: string; port: number },
  path = copilotOrbConfigPath()
): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("unsafe_config_path")
  const previous: unknown = JSON.parse(await readFile(path, "utf8"))
  if (!isRecord(previous)) throw new Error("invalid_orb_config")
  const endpoints = await loadSavedOrbEndpoints(path)
  const index = endpoints.findIndex(endpoint => endpoint.id === destination.id &&
    endpoint.host === destination.host && endpoint.port === destination.port)
  if (index < 0) throw new Error("observer_destination_not_found")
  endpoints.splice(index, 1)
  const next: Record<string, unknown> = { ...previous, endpoints }
  // Keep legacy readers from using credentials belonging to the removed destination.
  delete next.host
  delete next.port
  delete next.token
  if (endpoints.length) Object.assign(next, {
    host: endpoints[0].host, port: endpoints[0].port, token: endpoints[0].token
  })
  await writeOrbConfig(next, path)
}
