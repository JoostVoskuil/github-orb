# Copilot SDK observer (experimental)

The observer is a long-lived SDK extension. It subscribes through `joinSession()` and can apply an explicit Orb/dashboard decision to a live pending permission when the host SDK exposes the pending-permission resolver. It does not register model tools, read transcripts, answer questions, install a replacement permission handler, or replace the CLI/VS Code agent harness. One extension instance observes one session and aggregates all its subagents into that session's single Orb entry. Approval is once-only; denial rejects that request, with no session-wide or persistent blanket grant.

## Prerequisites

- Node.js 24 LTS on the host where the Copilot runtime runs.
- An observer-capable ESP32 at `http://github-orb.local:7420`, or the Docker dashboard at `http://127.0.0.1:7421`.
- Private `observer/config.json` with a destination `host`, `port`, and bearer `token`, or an `endpoints` array containing multiple destinations; environment overrides are also supported.

The host-native Orb Dashboard (`npm run dashboard`, then `http://127.0.0.1:7420/dashboard/`) creates `observer/config.json` after successful USB provisioning. **Live Orb → Install Extension for Live Orb** adds or updates the Orb's DHCP address, API port and token in the `endpoints` array in `~/.copilot/orb/config.json` (or under `$COPILOT_HOME`) and installs the user-level extension. **Live Dashboard → Install Extension for Live Dashboard** adds or updates the local service (port `7420` host-native or the published host port, normally `7421`, with Docker Compose). The observer posts to all configured endpoints concurrently. Start a fresh Copilot session after adding or updating destinations. Neither config stores the Wi-Fi passphrase.

The dashboard's shared **Copilot observer destinations** summary shows this saved configuration without tokens: destination type, host/port, authenticated API reachability, live session count, configuration path and matching user-level extension installation. Its local-only `GET /setup/observer` endpoint reads the saved destinations without applying the dashboard process's environment overrides. It does not inspect another Copilot process's environment, project/custom extension installations, or prove that any session loaded the latest configuration.

## Runtime support

| Host                       | Requirement and verification                                                                                                                                                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copilot CLI interactive    | Experimental extensions enabled (`copilot --experimental`). Confirm the extension is running with `/extensions manage`. CLI 1.0.96-2 was available during development, but prompt-mode probes did **not** load the extension; `copilot -p` is not a verified observer host.                                          |
| VS Code Copilot Agent Host | VS Code 1.142.0 source enables SDK extensions in fresh, non-ephemeral Copilot-harness sessions through the preview `chat.canvases.enabled` setting. Its source default is false; rollout may override it. Enable deliberately, then start a fresh Copilot-harness session. A canvas is not required by the observer. |
| Actual bundled SDK         | The opt-in integration tests verify project-extension discovery, session joining, a nine-second tool, question request/resolution and session-wide completion. They use a local mock model and real dashboard HTTP server; no external model service is used.                                                        |
| Other VS Code harnesses    | Local, Claude, Codex, cloud and ephemeral sessions are not covered. Do not assume changing the model changes the harness.                                                                                                                                                                                            |

Live VS Code 1.142.0 user-level discovery and dashboard delivery were verified on 2026-10-16 after enabling `chat.canvases.enabled` and starting a fresh Copilot-harness session. The session progressed through thinking, bash tool (approximately 9.4 seconds), thinking, then done; it did not falsely request input after eight seconds.

The SDK integration tests are separate from that live UI test. The local custom-tool test proves that the joined extension resolves the SDK pending request (`approve-once` executes the in-process tool; `reject` does not), without a creator permission callback answering it. It does **not** prove live user VS Code/CLI permission-dialog closure or real shell execution. Interactive CLI discovery, live host approve/deny, subagent concurrency, remote hosts, and cross-host continuation still need host-specific smoke testing. Unit/native tests cover reducer/protocol semantics. Extension/runtime APIs are experimental.

## Install

First build/restart the updated dashboard (`docker compose up --build -d dashboard`) or deploy observer-capable firmware separately. Old firmware does not understand observer messages. Do not point a test observer at a board that has not been updated.

Prepare a private JSON configuration. A single endpoint can retain the original shape:

```json
{
  "host": "127.0.0.1",
  "port": 7421,
  "token": "<the dashboard observer token>"
}
```

To send to both physical and local destinations, use:

```json
{
  "endpoints": [
    { "id": "orb", "host": "github-orb.local", "port": 7420, "token": "<the Orb token>" },
    { "id": "dashboard", "host": "127.0.0.1", "port": 7421, "token": "<the dashboard observer token>" }
  ]
}
```

Keep it outside version control and restrict its permissions to `0600`. The default location is `observer/config.json`. Set `ORB_CONFIG` to an absolute alternate file for dashboard tests without changing the physical Orb's configuration. `ORB_HOST`, `ORB_PORT` and `ORB_TOKEN` override the first configured endpoint; environment variables in a terminal might not reach VS Code launched from Finder/Dock.

Install at user level for all extension-enabled sessions:

```sh
ORB_CONFIG=/absolute/private/orb-config.json npm run observer:install
```

Or install only for this checkout:

```sh
ORB_CONFIG=/absolute/private/orb-config.json npm run observer:install -- --project
```

The installer writes a private JavaScript entry pointing to this checkout's compiled `dist/observer/observer.js` and the absolute configuration path. It installs under `$COPILOT_HOME/extensions/github-orb/` (otherwise `~/.copilot/extensions/github-orb/`) or the checkout's gitignored `.github/extensions/github-orb/`. It does not install another SDK package: the host supplies `@github/copilot-sdk/extension`. Keep this checkout and `dist/observer/` available; rerun the build after source changes. Relocating it requires explicitly removing/replacing the old entry. If you installed the previous `copilot-orb` extension, remove it before installing this one to avoid running both observers.

Use only one installation location. The installer refuses to overwrite a differing extension or install alongside another user/project copy in this checkout. Avoid separate manually installed copies in other repositories.

To load the pending-permission support after an observer update, run `npm run build`, refresh the same installation with `npm run observer:install` using its existing configuration and installation scope, then start a **fresh host session**. Existing sessions do not pick up the rebuilt observer automatically; installation alone also does not update dashboard service code or firmware.

Both supported SDK hosts use source `cli`, documented as **shared Copilot**, with the true SDK session ID. Newer observer instances take over that ID without adding another source-qualified session.

## Behavior and privacy

- Tracks correlated tool calls, subagents, permission requests, legacy questions, structured elicitation, plan-mode reviews (`exit_plan_mode.requested`) and session-limit prompts (`session_limits_exhausted.requested`). Finishing one tool cannot hide another tool or an outstanding question.
- Some hosts do not deliver `permission.requested` to extensions (verified with the VS Code 1.142 bundled SDK). While the session is busy the observer therefore polls `session.rpc.permissions.pendingRequests()` once per second and reconciles it with events; this also surfaces prompts raised before the extension joined.
- Maps root-agent intent descriptions to the bounded activity labels `Working`, `Evaluating` or `Analysing` while keeping the Orb in its thinking mood. Matching works when the activity word appears within a sentence; intent text and reasoning content are never transmitted. The same activity label appears in each session's detail overlay.
- Each event is posted concurrently to all configured destinations. A failed destination is reported without preventing delivery to healthy ones; each HTTP attempt has a 350 ms timeout and does not retry the whole fan-out.
- Each session card shows the selected custom agent (`subagent.selected`, otherwise _Copilot_), a running subagent's display name, the session model, input/output token totals from `assistant.usage`, context-window use from `session.usage_info`, and how long the current request has been running (sent as a relative `busyForMs`, so host and Orb clocks need not agree). Totals aggregate only events observed by this extension instance; prior session history is not replayed. Prompts, reasoning and raw event payloads are not sent.
- The Orb shows at most three sessions as arcs of its outer ring, each coloured and animated by its own state; arcs keep their position. A more urgent session (needs input > error > tool > thinking > done > idle) takes the slot of an ended one, and `+N more` appears at the top. The mascot and the bottom caption (status, then session title) follow the most urgent session. Sessions that finished (done → idle) or closed stay dimmed for five minutes ("Done 3m ago", "Closed 1m ago"), then disappear.
- The first click/tap on a yellow ring segment opens its command/request card on both dashboard and firmware. For actionable live permissions, **Approve** submits immediately; there is no separate review screen or checkbox. **Deny** is also direct. The physical Orb shows a compact command preview and indicates when a longer command continues beyond the visible text. Approval controls do not cycle session cards. Questions, plan reviews, session limits and non-actionable permissions remain read-only with _Answer on computer_.
- Actionability requires both SDK `session.rpc.permissions.pendingRequests()` and `handlePendingPermissionRequest()`. Only the displayed live pending permission can be decided, after rechecking it against the SDK pending list. Shell review uses the exact complete multiline command; supported non-shell kinds (read/write, URL, MCP, memory and custom-tool) use the complete structured JSON request, including full paths, URLs and tool arguments. Both use `attention.command`, limited to 1,024 UTF-8 bytes with no disallowed control characters (tabs and line breaks are allowed). Missing, oversized or unsafe review details remain computer-only; truncated summaries never authorize approval. Other/unknown kinds remain computer-only.
- Actionable attention sends one-second heartbeats, including when otherwise unchanged. Controls require a fresh observer update (dashboard: 10 seconds; firmware: 30 seconds). A destination queues an explicit decision for at most 30 seconds, bound to the session, observer owner and exact attention content. Authenticated `/event` replies return the nonce and `approve`/`deny`; the observer maps them locally to SDK `approve-once`/`reject`. Changed authoritative request details rotate the nonce and require fresh review; resolved or superseded requests cannot reuse a decision. Conflicting choices across destinations permanently block remote resolution for that nonce, even after a choice expires; resolve it on the computer. Queue acceptance is not proof of SDK resolution; check the host if completion is not confirmed.
- The dashboard Messages panel displays values for its allowlisted payload fields, including titles and labels, so those fields are visible in local debug history. Unknown fields such as API tokens are never included.
- Uses `session.title_changed` as the live session title, with SDK `initialName`/`summary` metadata and then the project folder as fallbacks. Later title changes update the displayed session name.
- Shows `done` only on normal root `session.idle` after observed work. The [SDK event reference](https://github.com/github/copilot-sdk/blob/main/docs/features/streaming-events.md) defines this as session-wide idle with no background agents or attached shell commands, and marks it ephemeral (not persisted or recoverable through `getMessages`). `assistant.turn_end` ends a turn; `assistant.idle` means only the main agent loop is idle and can occur while background work remains. Neither means the session is done.
- Tool/subagent failures alone do not set error; `session.error` does. A session error remains through immediate idle until a new user request or the engine's error hold expires. Cancellation does not display successful completion.
- Observer sessions have no inactivity timeout. They remain active until an `observerEnd` event or an Orb restart; abrupt host termination can leave a stale session visible until the Orb restarts.
- Done holds for 10 seconds; error for 30 seconds. Repeated identical state does not reset these holds, replay animation, change equal-priority selection, or dismiss Mona news.
- Sends session ID, instance ownership/sequence metadata, bounded project-folder and session-name labels, mood, an allowlisted activity label, tool name, bounded agent/subagent/model labels, and numeric token, context and duration values, plus pending-permission review data below. A session name may be generated from conversation content; only that display title is sent. Free-form activity intent is reduced to one of three labels.
- **Only while a permission prompt is pending**, an `attention` object adds an allowlisted kind, the request's stated intention (at most 80 bytes) and a preview of at most 60 bytes: the first line of a shell command, a file _basename_, a URL _host_, `server/tool` for MCP, a memory subject or a custom tool name. Actionable requests additionally send the **exact full shell command or complete non-shell structured JSON request, up to 1,024 UTF-8 bytes**, in `attention.command` to every authenticated configured destination for review. This includes full paths, URLs (potentially credentials/query strings) and tool arguments, and any diffs or contents present in the permission request. Review details, intentions and previews can contain secrets; this is not a metadata-only channel or secret-redaction guarantee. The SDK request ID never leaves the host; the Orb sees a random 16-hex nonce. Questions, plan summaries and limit details are not sent. Conversation prompts, reasoning, user answers and tool results are not independently forwarded; SDK payloads are not logged. Protect all destinations and their tokens, and remember HTTP is unencrypted.
- HTTP delivery is asynchronous with one coalesced pending state, a 1200 ms timeout, bounded retries, status checks, no redirects and rate-limited sanitized warnings through `session.log`. It never blocks tool execution.
- Starts with unknown state until live lifecycle evidence. The SDK warns that events can arrive before session creation or resume returns; this extension attaches its listener after `joinSession()`, so activity that predates the subscription may be missed. Ephemeral events such as `session.idle` cannot be recovered from saved messages. Reload while idle and start a new request, or use a fresh session; do not claim accurate mid-work resynchronization from saved transcripts.
- End/shutdown marks the session closed when delivery succeeds. After an Orb restart, active work is restored by the next observer state update; historical done/error one-shots are not replayed.
- In SSH, WSL, Dev Containers or remote Agent Hosts, the extension runs on that host. The installed files/configuration and network route to the Orb must exist there; `127.0.0.1` is relative to that host. Those topologies are not automatically provisioned.

## Verify

```sh
npm run build
node --test dist/tst/observer/*.test.js dist/tst/dashboard/observer.test.js dist/tst/firmware/orb-engine.test.js
```

To exercise an existing macOS SDK installation without installing dependencies or contacting a model provider:

```sh
ORB_SDK_ASSETS="/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules.asar.unpacked/@github/copilot-sdk-darwin-arm64" \
  node --test dist/tst/observer/observer-sdk.test.js
```

Without `ORB_SDK_ASSETS` that integration test explicitly skips; a skipped test is not runtime verification. The test uses temporary configuration, isolated SDK state, loopback servers, and synthetic model responses, and cleans them up afterwards. The default executable path inside those assets is macOS ARM64.

For permission smoke testing, use a harmless genuinely pending request in a fresh host session after rebuilding and refreshing installation. The first yellow-segment tap must open its command/request card; approve once from that card, then test direct denial on a separate request. Confirm the SDK pending request clears and the actual host dialog closes/activity resumes; report each host separately. Stale heartbeats must disable decisions; changed details must require a new nonce; conflicting destination choices must require computer resolution. Questions, plans, limits, missing resolver support and incomplete/oversized requests must stay computer-only. Current real-SDK tests pass, but no actual user permission dialog has been verified; USB hardware was absent, so no flash or physical touch verification occurred. Do not report a queued decision or the local custom-tool integration test as live UI verification.

For real-host testing, confirm extension status, open the dashboard's **Live** view, start two sessions in the same directory, run a tool longer than eight seconds, and trigger approval/input and background subagent work. Verify one entry per session, immediate attention state and no early done. Stop the extension cleanly and verify the entry closes. Check sanitized runtime warnings for delivery errors.

If events reach Live Dashboard but the physical Orb stays idle, check the physical endpoint separately. A successful `/health` response confirms reachability, not observer compatibility. Firmware returning `400 invalid_observer_event` for valid observer messages needs the HTTP parsing fix: nullable strings must use ArduinoJson's `.as<const char *>()`, not `| nullptr`, which discards string values. The native HTTP regression test (`dist/tst/firmware/observer-http.test.js`) exercises the actual handler with the firmware's ArduinoJson dependency. Reinstalling the extension alone does not update firmware.

## Uninstall

Disable/remove only the installed `github-orb/extension.mjs` entry and start fresh sessions. Existing observer entries close when orderly shutdown delivers `observerEnd`; abrupt termination can leave an entry until the Orb restarts. No Wi-Fi settings, tokens, SD assets or firmware are reset by installation or removal.
