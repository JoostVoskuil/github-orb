# GitHub notifications and Mona

GitHub Orb can poll unread GitHub notifications and present selected items with Mona on the physical Orb or dashboard. This feature is optional; without a configured GitHub PAT, polling is disabled.

## Configure GitHub access

The ESP32 polls notifications on a background FreeRTOS task when `githubPat` is configured through `/config.json` on the microSD card, the **`GitHub-Orb-Setup`** captive portal, or `PUT /settings`. The dashboard can use a separate PAT supplied through `.env`/Compose or saved in its **Live Dashboard** tab.

Use a **classic PAT** with the `notifications` scope. The integration calls only GitHub's notifications endpoint; it does not query user, pull-request, Actions, or Dependabot endpoints. The account must be able to see the repositories represented in its inbox, and organization SSO authorization may be required. Fine-grained PATs are unsupported by the notifications endpoint. See GitHub's [notifications API documentation](https://docs.github.com/en/rest/activity/notifications) and confirm current permission requirements before granting scopes.

Polling accepts intervals from **30–3600 seconds**, defaults to 60, and honors GitHub `X-Poll-Interval` and rate-limit headers.

## What is displayed

The integration makes authenticated **GET** requests only to:

```text
/notifications?all=false&participating=false&per_page=30&page=1
```

It never marks notifications read, modifies threads, or changes repositories. Only unread notification threads are processed; repositories are discovered only from those threads.

| GitHub reason | Display |
| --- | --- |
| `security_alert` | Mona's security animation |
| `ci_activity` | Mona's workflow-failed animation and label. GitHub's reason means CI activity completed and does not necessarily mean it failed; the display does not fetch or verify the run result. |
| `approval_requested`, `review_requested`, or `assign` | Mona's PR-attention pose. GitHub defines `approval_requested` for deployment approvals; when the subject is not a PR, the display links to the repository. |
| `agent_session_finished` | Copilot's Done animation for 10 seconds, then the latest event-driven Copilot state. New Copilot activity cancels the completion display. |
| Other reasons | Mona's attention pose |

This is not comprehensive workflow or security monitoring. Delivery depends on GitHub notification settings and the unread inbox; the integration does not scan arbitrary repositories, code-scanning alerts, or workflow run results.

## Delivery, priority, and acknowledgement

At startup, unread inbox threads updated at or before the Orb boot time (or dashboard start time) are ignored. Only threads updated afterward can be displayed. Firmware waits for a valid system clock and records ignored thread timestamps for deduplication. If an ignored thread receives a newer update after startup, that revision is eligible.

Each poll deduplicates notifications and displays the highest-priority, newest **fresh** item: **security > workflow failure > PR attention > Copilot done > other notification**. Lower-priority items are not queued. Mona is sticky latest news: she holds her final pose until another fresh notification takes over or the user acknowledges her locally.

Tap Mona once to see the type, organization (or personal repository owner), repository, and title. Tap the details card again to dismiss the alert and return to the latest Copilot state; tapping outside closes the details without dismissing the alert. The dashboard's **Live Dashboard** tab acknowledges through the authenticated API. Acknowledging locally does not mark the GitHub notification read. Copilot events continue updating sessions under Mona without dismissing her.

The current alert presentation and its acknowledgement are memory-only, so a restart clears them. Deduplication is persisted: on the Orb in `/github-state.json` (written atomically via `/github-state.tmp`) and in the dashboard's data volume.

## Diagnostics and assets

Use authenticated `GET /github/status` with the **ESP32 bearer token, not the PAT**, to inspect enabled/status/last-success and sanitized errors. The dashboard also reports safe GitHub status details in its Messages panel. Public `/health` does not expose GitHub status or secrets.

Mona clips are `mona-pr`, `mona-workflow`, and `mona-security`. Dashboard previews use 3D frame sequences and mascot/clip previews. Missing Copilot frames fall back to available image artwork and then a drawn face; Mona uses a procedural cat-eared fallback rather than Copilot artwork. News links accept only safe HTTPS `github.com` URLs.

For implementation details, see [architecture and protocol](architecture.md). To prepare, render, and verify mascot assets, see the [Mona tooling guide](../tools/MONA.md).
