---
name: copilot-observer-install
description: "Install, configure, test, or troubleshoot the GitHub Orb SDK observer for VS Code Copilot-harness sessions and Copilot CLI. Use for observer installation, extension discovery, dashboard testing, or changing the Orb destination."
---

# Install and test the GitHub Orb observer

## Boundaries

- This is a passive Copilot SDK extension, not a VS Code VSIX.
- Do not flash firmware, provision Wi-Fi, reset credentials, or change the physical Orb destination merely to test installation.
- Ask whether to target the dashboard or an already observer-capable board. Prefer the dashboard for initial testing.
- Never print tokens, private configuration files, `.env`, SDK event payloads, or user conversation content.
- Do not claim a live VS Code or CLI test passed just because installation or the SDK integration test passed.

## 1. Inspect and build

Run from the checkout containing `package.json` and `observer/`:

```sh
node --version
code --version
copilot --version
npm run build
npm run check
```

Use Node 24 LTS. Reuse installed dependencies; restore them only if validation reports they are missing. Check for an existing user/project `github-orb/extension.mjs` before installing. Remove a previous `copilot-orb/extension.mjs` entry before installing to avoid duplicate observers. Never overwrite a differing extension automatically.

## 2. Choose the destination

The default private file is `observer/config.json`; USB provisioning writes that file. It contains `host`, `port`, and `token`. Preserve it when testing a different target.

For the dashboard:

```sh
docker compose up --build -d dashboard
curl -fsS http://127.0.0.1:7421/health
```

Prepare a separate private file, for example `~/.copilot/orb/dashboard.json`, with host `127.0.0.1`, port `7421`, and the dashboard's existing `ORB_TOKEN`. Transfer the token programmatically, without logging it. Reuse `saveOrbConfig` from `dist/observer/config-store.js` for atomic `0600` storage. Do not put secrets in shell arguments or tracked files. Preserve unrelated config keys.

For a physical board, first confirm observer-capable firmware is already deployed. Installation alone does not update the board.

## 3. Install or refresh for both hosts

```sh
ORB_CONFIG="$HOME/.copilot/orb/dashboard.json" npm run observer:install
```

This creates `$COPILOT_HOME/extensions/github-orb/extension.mjs`, falling back to `~/.copilot/extensions/github-orb/extension.mjs`. The host supplies the SDK; do not install a separate SDK or VSIX.

The entry loads this checkout's absolute `dist/observer/observer.js` and supplies the absolute configuration path when `ORB_CONFIG` is not already set. `ORB_HOST`, `ORB_PORT`, and `ORB_TOKEN` still override configuration. Check overrides without revealing values if delivery goes to the wrong destination.

After any observer source change, run `npm run build` and rerun `npm run observer:install` for the same user-level destination and `ORB_CONFIG`, then start a fresh host session. The home-directory entry is a bootstrap into this checkout's compiled observer, not a copy of the source; rebuilding updates the code it loads. Re-running the installer verifies the entry still targets the current checkout and config. If it reports a differing entry, inspect its ownership and paths without printing private config; remove and reinstall only when it is a known stale Orb entry. Never overwrite an unrelated extension.

For checkout-only installation, add `-- --project`; this instead creates `.github/extensions/github-orb/extension.mjs`. Do not install both copies. Keep the checkout/build available, rebuild after changes, and explicitly remove an old entry before moving the checkout or switching installation paths/configurations.

## 4. Enable the hosts

### VS Code

In verified VS Code 1.142.0, non-ephemeral Copilot Agent Host sessions request SDK extensions when the preview setting `chat.canvases.enabled` is true. Check the current setting without dumping all user settings. Explain that this enables a preview feature; preserve other settings if enabling it.

Start a **fresh Copilot-harness session** after installation, using the Agents window if needed (`code --agents`). Ordinary Local, Claude, Codex, cloud and ephemeral sessions are not verified hosts. Merely choosing a Copilot model does not establish which harness owns a session. No canvas needs to be created for the observer.

Do not assume an already running session will discover a newly installed extension. If the setting or host behavior changes in a newer VS Code, verify its current implementation before updating this workflow.

Verified on 2026-10-16 with VS Code 1.142.0: user-level installation, this preview setting, and a fresh Copilot-harness session delivered thinking → bash tool (approximately 9.4 seconds) → thinking → done to the Docker dashboard. No false attention state appeared after eight seconds. This verifies live VS Code discovery and tool completion, not CLI discovery or approval/subagent flows.

### Copilot CLI

Start a fresh interactive session in a trusted checkout:

```sh
copilot --experimental
```

Use `/extensions manage` to confirm the Orb extension is discovered/running. Earlier CLI 1.0.96-2 prompt-mode probes did not load it; do not substitute `copilot -p` for an interactive discovery test without re-verifying the installed version.

## 5. Test

Open `http://127.0.0.1:7421/dashboard/` and select **Live**, not Preview.

Use the [Copilot SDK streaming-events reference](https://github.com/github/copilot-sdk/blob/main/docs/features/streaming-events.md) when changing event names or payload interpretation. In particular, `session.title_changed.data.title` is the live session title; `assistant.intent.data.intent` is free-form and must be reduced locally to allowlisted activity labels rather than forwarded to the Orb. Permission prompts are reduced to an allowlisted kind, the bounded intention and a short preview (never arguments, diffs or the SDK request ID). `assistant.turn_end` and `assistant.idle` do not mean the whole session is complete; use root `session.idle`.

In each real host, request:

> Run a shell command that waits for nine seconds. Make no file changes. Then report completion.

Verify a real session appears, stays in `tool` longer than eight seconds (not `needsInput`), and reaches `done` only after session-wide completion. Both hosts intentionally use source `cli`, meaning shared Copilot. Do not infer the host from this source alone; correlate session IDs and test timing.

Then test a genuine question/approval: confirm `needsInput` while waiting, answer/approve in the host, and confirm activity resumes. Check simultaneous sessions/subagents if that scope is required. Stopping the extension cleanly marks the entry closed; abrupt termination leaves it active until the Orb restarts. Closed and finished sessions stay dimmed for five minutes.

To test the attention display, ask for a harmless command that needs a permission prompt (for example `ls` in an empty temporary directory). Tap the Orb (or the dashboard canvas in **Live**) and confirm the card shows the kind, intention and short preview with *Answer on computer*; answer the prompt on the computer. Some hosts do not deliver `permission.requested` to extensions; the observer then relies on polling `rpc.permissions.pendingRequests()`, so allow up to a second for the card to appear.

For automated regression:

```sh
node --test dist/tst/observer/*.test.js dist/tst/dashboard/config-store.test.js dist/tst/dashboard/observer.test.js dist/tst/dashboard/serve.test.js
```

On the verified macOS ARM64 VS Code installation, exercise the actual bundled SDK with a local synthetic model:

```sh
ORB_SDK_ASSETS="/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules.asar.unpacked/@github/copilot-sdk-darwin-arm64" \
  node --test dist/tst/observer/observer-sdk.test.js
```

These integration tests prove SDK extension loading and dashboard lifecycle delivery. They do not prove live UI discovery or that a specific host's permission dialog closes. It skips without `ORB_SDK_ASSETS`. Report skipped tests explicitly. Read only sanitized diagnostics; never log raw SDK payloads.

## 6. Report and uninstall

Report the installation location, destination (without token), setting changes, automated results, actual live-host evidence, and remaining manual checks. State explicitly that no board flash occurred.

To uninstall, remove only the known Orb extension entry, leave other extensions/configuration intact, and start fresh sessions. Existing entries close on orderly shutdown; abrupt termination leaves them until the Orb restarts. Revert the preview setting only if requested and if it was enabled solely for this setup.
