---
name: copilot-observer-install
description: "Install, configure, test, or troubleshoot the GitHub Orb SDK observer for VS Code Copilot-harness sessions and Copilot CLI. Use for observer installation, extension discovery, dashboard testing, or changing the Orb destination."
---

# Install and test the GitHub Orb observer

## Boundaries

- This is a Copilot SDK observer extension, not a VS Code VSIX. With SDK pending-list/resolver support it can apply an explicit decision to a live pending permission; it installs no replacement permission handler or model tool. Only approve-once/reject are supported, never session-wide or persistent blanket grants.
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

Ensure the dashboard service is running (`docker compose up --build -d dashboard`) and healthy. The Live Dashboard install generates the dashboard observer token on first use and stores it in the dashboard's data volume and in the Copilot Orb configuration. No `ORB_TOKEN` is needed in `.env`. Never print or paste the token into logs or commands.

```sh
docker compose up --build -d dashboard
curl -fsS http://127.0.0.1:7421/health
```

Press **Install Extension for Live Dashboard** in the dashboard UI, or POST to `/setup/install-dashboard-observer` from the same origin. The response reports host paths only, never the token. Pressing it again reuses the existing token. Verify the entry without revealing secrets (compare hashes, not values) if delivery goes to the wrong destination.

For a physical board, first confirm observer-capable firmware is already deployed. Installation alone does not update the board.

See [`docs/dashboard.md`](../../../docs/dashboard.md) for dashboard configuration and [`docs/getting-started.md`](../../../docs/getting-started.md) for device setup.

## 3. Install or refresh for both hosts

```sh
ORB_CONFIG="$HOME/.copilot/orb/dashboard.json" npm run observer:install
```

This creates `$COPILOT_HOME/extensions/github-orb/extension.mjs`, falling back to `~/.copilot/extensions/github-orb/extension.mjs`. The host supplies the SDK; do not install a separate SDK or VSIX.

The entry loads this checkout's absolute `dist/observer/observer.js` and supplies the absolute configuration path when `ORB_CONFIG` is not already set. Inside Docker, `ORB_HOST_CHECKOUT` and `ORB_HOST_COPILOT_HOME` make the entry name host paths. `ORB_HOST`, `ORB_PORT`, and `ORB_TOKEN` still override configuration. Check overrides without revealing values if delivery goes to the wrong destination.

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

Use the [Copilot SDK streaming-events reference](https://github.com/github/copilot-sdk/blob/main/docs/features/streaming-events.md) when changing event names or payload interpretation. In particular, `session.title_changed.data.title` is the live session title; `assistant.intent.data.intent` is free-form and must be reduced locally to allowlisted activity labels rather than forwarded to the Orb. Pending permissions carry an allowlisted kind, bounded intention (80 UTF-8 bytes) and preview (60 UTF-8 bytes). Actionable requests additionally send the exact complete multiline shell command or complete supported non-shell structured JSON request in `attention.command` (up to 1,024 UTF-8 bytes) to **all authenticated configured destinations**. This includes full paths, URLs, tool arguments and any diffs or contents in the permission request; these may contain secrets, so never describe this as metadata-only or promise secret redaction. SDK permission request IDs never go on the wire. `assistant.turn_end` and `assistant.idle` do not mean the whole session is complete; use root `session.idle`.

In each real host, request:

> Run a shell command that waits for nine seconds. Make no file changes. Then report completion.

Verify a real session appears, stays in `tool` longer than eight seconds (not `needsInput`), and reaches `done` only after session-wide completion. Both hosts intentionally use source `cli`, meaning shared Copilot. Do not infer the host from this source alone; correlate session IDs and test timing.

Then test a genuine question/approval: confirm `needsInput` while waiting, answer/approve in the host, and confirm activity resumes. Check simultaneous sessions/subagents if that scope is required. Stopping the extension cleanly marks the entry closed; abrupt termination leaves it active until the Orb restarts. Closed and finished sessions stay dimmed for five minutes.

To test permission review, request a harmless command that genuinely needs approval (for example `ls` in an empty temporary directory; host policy may already allow it). The first click/tap on its yellow ring segment in **Live** must open the command/request card on both dashboard and firmware. Some hosts do not deliver `permission.requested` to extensions; the observer polls `rpc.permissions.pendingRequests()` once per second, so allow up to a second for the card to appear.

For an actionable request, **Approve** submits immediately from the command/request card on both dashboard and firmware; there is no separate review screen or checkbox. The physical Orb shows a compact preview and indicates when a longer command continues. **Deny** is direct on both surfaces. Test approve-once and deny with separate pending requests; verify the SDK pending request clears, the actual host dialog closes, and the permitted activity resumes (or the denied tool does not execute). Queue acceptance alone is not SDK confirmation. Do not flash a board merely for this installation test.

Actionability requires both `rpc.permissions.pendingRequests()` and `handlePendingPermissionRequest()`. Shell commands must be exact and complete; supported non-shell kinds (read/write, URL, MCP, memory and custom-tool) require the complete structured JSON request, not a summary. Either review representation must fit 1,024 UTF-8 bytes and be free of disallowed control characters (tabs and line breaks are allowed). Missing, oversized or unsafe details remain *Answer on computer*; truncated summaries never authorize approval. Questions, plan reviews, session limits and other/unknown permission kinds remain computer-only.

Actionable attention sends one-second heartbeats even without a state change. Verify stale updates disable decisions (dashboard freshness: 10 seconds; current firmware: 30 seconds—inspect its implementation if changed). A destination queues a decision for at most 30 seconds, bound to the session, observer owner and exact attention content. Authenticated `/event` replies carry `permissionDecision: { attentionId, decision }` using a random nonce and `approve`/`deny`, never the SDK request ID. The observer rechecks the live pending request and maps the decision to SDK `approve-once`/`reject`. Changed authoritative request details must rotate the nonce and require fresh review; resolved or superseded requests cannot reuse it. Conflicting choices across destinations permanently block remote resolution for that nonce, even after a choice expires; verify computer resolution is required. Never log review details or raw SDK payloads while diagnosing delivery.

For automated regression:

```sh
node --test dist/tst/observer/*.test.js dist/tst/dashboard/config-store.test.js dist/tst/dashboard/observer.test.js dist/tst/dashboard/serve.test.js
```

On the verified macOS ARM64 VS Code installation, exercise the actual bundled SDK with a local synthetic model:

```sh
ORB_SDK_ASSETS="/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules.asar.unpacked/@github/copilot-sdk-darwin-arm64" \
  node --test dist/tst/observer/observer-sdk.test.js
```

Current real-SDK tests pass, proving SDK extension loading and dashboard lifecycle delivery. They also prove that the joined extension applies approve/deny through the pending resolver for a local custom-tool request: approval executes the in-process tool once, denial does not, and no creator permission callback answers it. This does **not** prove real shell execution, live user VS Code/CLI discovery of the updated extension, or closure of those hosts' permission dialogs; no actual user dialog has been verified. USB hardware was absent, so no flash or physical touch verification occurred. Tests skip without `ORB_SDK_ASSETS`; report skipped tests explicitly. Read only sanitized diagnostics; never log raw SDK payloads. After observer changes, rebuild, refresh the same installation/configuration, then start a fresh host session before claiming updated live behavior.

## 6. Report and uninstall

Report the installation location, destination (without token), setting changes, automated results, actual live-host evidence, and remaining manual checks. State explicitly that no board flash occurred.

To uninstall, remove only the known Orb extension entry, leave other extensions/configuration intact, and start fresh sessions. Existing entries close on orderly shutdown; abrupt termination leaves them until the Orb restarts. Revert the preview setting only if requested and if it was enabled solely for this setup.
