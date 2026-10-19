#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { hostCopilotPath, loadOrbEndpoints, orbConfigPath } from "./config-store.js"

export async function installObserver(configPath = orbConfigPath(), project = false): Promise<string> {
  await loadOrbEndpoints(configPath)
  const home = resolve(process.env.COPILOT_HOME || join(homedir(), ".copilot"))
  const directory = project ? fileURLToPath(new URL("../../.github/extensions/github-orb/", import.meta.url)) : join(home, "extensions", "github-orb")
  const alternate = project
  ? join(home, "extensions", "github-orb", "extension.mjs")
  : fileURLToPath(new URL("../../.github/extensions/github-orb/extension.mjs", import.meta.url))
const legacyPaths = [
  join(home, "extensions", "copilot-orb", "extension.mjs"),
  fileURLToPath(new URL("../../.github/extensions/copilot-orb/extension.mjs", import.meta.url)),
]
for (const legacyPath of legacyPaths) {
  try {
    await readFile(legacyPath)
    throw new Error(`A legacy copilot-orb observer is installed at ${legacyPath}; remove it before installing the GitHub Orb observer.`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}
try {
  await readFile(alternate)
  throw new Error("Another user/project GitHub Orb installation exists; use only one to avoid competing observers.")
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
}
// Docker runs this installer against a container checkout; ORB_HOST_CHECKOUT maps it to the host path the Copilot host loads.
const appRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const observerFile = fileURLToPath(new URL("./observer.js", import.meta.url))
const hostCheckout = process.env.ORB_HOST_CHECKOUT ? resolve(process.env.ORB_HOST_CHECKOUT) : appRoot
const runtime = pathToFileURL(join(hostCheckout, relative(appRoot, observerFile))).href
const entry = `import { joinSession } from '@github/copilot-sdk/extension';
import { observeSession } from ${JSON.stringify(runtime)};
process.env.ORB_CONFIG ??= ${JSON.stringify(hostCopilotPath(resolve(configPath)))};
await observeSession(await joinSession());
`
await mkdir(directory, { recursive: true })
const path = join(directory, "extension.mjs")
try {
  const existing = await readFile(path, "utf8")
  if (existing !== entry) throw new Error("An existing GitHub Orb extension differs; remove or relocate it explicitly before installing.")
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  await writeFile(path, entry, { flag: "wx", mode: 0o600 })
}
return path
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg !== "--project")) {
    throw new Error("Usage: npm run observer:install -- [--project]")
  }
  const path = await installObserver(orbConfigPath(), args.includes("--project"))
  console.log(`Installed ${path}. Start a fresh extension-enabled Copilot session.`)
}
