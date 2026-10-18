# Security and privacy

- The ESP32 API and dashboard use unencrypted HTTP. Keep them on trusted networks.
- The dashboard binds to `127.0.0.1` by default. Do not expose its port to a LAN or the internet without suitable transport security and access controls.
- Authenticated API routes require the configured Orb token; `/health` and static dashboard/media files are public.
- The observer forwards aggregate mood, source, session and instance identifiers, ordering metadata, bounded working-folder name, and tool name. It does not send prompts, chat content, reasoning, questions, answers, tool arguments, or results. See [observer behavior and privacy](../observer/README.md#behavior-and-privacy).
- Physical-device state and settings remain on the ESP32. Dashboard state is held in the service process; GitHub deduplication data and a UI-saved dashboard PAT are stored in the Compose volume.
- A dashboard GitHub PAT may be supplied through `.env`/Compose or saved from the local UI. UI-managed credentials are stored privately and are never returned to the browser or diagnostics. Authenticated state includes alert titles, repository names, and links, so protect `ORB_TOKEN` and the ESP32 token. Never expose credentials through public diagnostics.

For service configuration and supported deployment options, see [Orb Dashboard](dashboard.md). For device credential provisioning, see [getting started](getting-started.md).
