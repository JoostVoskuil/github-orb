# Orb Dashboard

The Orb Dashboard configures the physical ESP32, displays observer activity, and can receive Copilot events independently of the physical Orb.

## Run the dashboard

### Docker Compose

From the repository root:

```sh
cp -n .env.example .env
# Set ORB_TOKEN to a unique secret; optionally set ORB_GITHUB_PAT.
docker compose up --build -d
```

Open <http://127.0.0.1:7421/dashboard/>. Compose binds to localhost port `7421` and forwards to the service's internal port `7420`. Set `ORB_TOKEN` before starting the service; optionally set `ORB_GITHUB_PAT` for dashboard GitHub polling. GitHub deduplication data and a UI-saved PAT are persisted in the `dashboard-data` volume. Stop the container with `docker compose down`; the volume is retained.

### Host-native

Install the repository dependencies and run `npm run dashboard` with Node.js 24 LTS. The dashboard is available at <http://127.0.0.1:7420/dashboard/> and USB access is enabled.

Set a stable `ORB_TOKEN` in the dashboard process environment if you plan to add Live Dashboard as an observer destination. The host-native npm script does not load `.env` automatically; keep the same token across restarts so the installed observer configuration continues to authenticate.

Docker disables USB setup by default. On Windows, forward the Orb into WSL 2 with [`usbipd-win`](windows-docker-usb.md). USB provisioning on macOS should use the host-native dashboard.

## Dashboard tabs

- **Live Orb** configures the physical device: Wi-Fi, GitHub PAT and polling interval, sound, volume, brightness, quiet hours, and timezone. Settings load from the saved Orb connection. **Save to Orb** persists settings on the ESP32. Only Wi-Fi changes require USB; other settings use the authenticated Wi-Fi API. **Test Orb sound** reports mute, active quiet hours, or missing SD sound assets without changing any sessions.
- **Live Dashboard** shows the local service state and browser preview. **Enable audio in browser** unlocks preview chimes only; it does not enable or test the physical buzzer. A GitHub PAT saved here belongs to the dashboard service, not the ESP32. If `ORB_GITHUB_PAT` is configured, it takes precedence and the UI identifies it as environment-managed.
- **Animations** runs local scenarios without changing live service state.

The dashboard's Orb preview is not a screen feed from the physical device. Sound, brightness, and quiet-hours edits update the dashboard's in-memory preview; they reach the physical Orb only after saving.

## Observer destinations

The **Copilot observer destinations** summary is visible on every tab. It lists configured destination types, host and port, authenticated API reachability, live session count, configuration path, and matching user-level extension installation. Tokens are never displayed. Reachability confirms the API responds; it does not prove an observer is running. Existing Copilot sessions keep the configuration they started with, and host environment overrides may differ.

Choose **Install Extension for Live Dashboard** to add the local service to the shared observer configuration, or **Install Extension for Live Orb** to add the physical device. The observer sends to all configured destinations concurrently. Start a fresh Copilot session after changing destinations. The dashboard refreshes the summary periodically; use **Refresh status** to check immediately.

For the supported Copilot hosts and observer installation details, see [Copilot SDK observer setup](../observer/README.md).

## Device maintenance

The **Device management** section includes asset upload and firmware update controls. Choose **Update through Wi-Fi** (default) or **Update through USB** from the shared selector; it never switches connections automatically. Wi-Fi uses the saved Orb connection, while USB uses the selected device and does not require Wi-Fi.

To upload animations and sounds, first publish assets with `npm run export:firmware --prefix tools`, then choose **Upload animations and sounds**. The dashboard sends both published files from `dist/sdcard`. Each is validated before replacing its previous copy, but the pair is not transactional. Choose **Restart to load assets** afterwards; the restart uses the same target captured for the upload.

To build and publish firmware, run `npm run firmware:build`. **Upload latest firmware** sends the newest binary from `dist/firmware`. Firmware updates restart automatically and must fit the inactive 3 MiB OTA slot. Older firmware needs one initial developer USB flash to enable USB updates and Wi-Fi asset uploads. Initial installation and recovery remain PlatformIO operations; see [firmware build and recovery](../firmware/README.md).

## Dashboard behavior

Recent observer events and dashboard actions appear in the **Messages** panel below the Orb. It shows bounded field/value summaries, omits unknown fields such as credentials, and retains at most 40 messages in memory.

The session carousel keeps a single Copilot avatar in front and indicates up to three sessions with ring arcs. Thinking, tool use, and waiting for input count as working. Completed sessions can remain as arcs for up to two minutes while work continues. Tapping an arc focuses it briefly; tapping the front avatar or focused arc opens details. Input requests hold the front position. With no working sessions, avatars disappear and the default sleeping Copilot is shown. Mona and GitHub completion notifications can take over while session activity continues underneath.

## Related guides

- [Getting started and provisioning](getting-started.md)
- [GitHub notifications and Mona](github-notifications.md)
- [Security and privacy](security-and-privacy.md)
- [Architecture and protocol](architecture.md)
