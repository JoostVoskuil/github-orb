# GitHub Orb firmware

Target: Waveshare **ESP32-S3-Touch-LCD-2.1B**, with a 480×480 ST7701S panel, CST820 touch controller, 16 MB flash, and 8 MB octal PSRAM.

> [!WARNING]
> GPIO assignments, panel initialization, expander outputs, touch reset, and buzzer control are revision-specific. Do not flash this firmware onto a similarly named board or another hardware revision without comparing its official schematic and demo.

The ESP32 runs completely standalone: it hosts the HTTP REST server (`:7420`), aggregates Copilot sessions, polls GitHub notifications over HTTPS, manages dual-slot OTA and SD-card firmware updates, and owns animation playback, JPEG/alpha decoding, mood ring split into up to three per-session arcs, a status/title caption, tap-to-open session and read-only approval cards, labels, brightness, quiet hours, and buzzer notifications.

## Memory and storage design

| Region      |      Size | Purpose                                                            |
| ----------- | --------: | ------------------------------------------------------------------ |
| `app0`      |     3 MiB | OTA application slot 0 (`0x20000`); verified binary ~1.45 MiB      |
| `app1`      |     3 MiB | OTA application slot 1 (`0x320000`)                                |
| microSD     |         — | Animation pack, attribution, `/sounds.json`, optional `/config.json` & `/firmware.bin` |
| Unallocated | 9.875 MiB | Unused flash (`0x620000`–`0x1000000`); no flash filesystem         |
| NVS/OTA/PHY |    32 KiB | Wi-Fi, API token, GitHub PAT, settings, and OTA boot state         |
| PSRAM       |     8 MiB | Two RGB565 framebuffers, alpha plane, and current compressed frame |

The layout provides dual 3 MiB OTA slots (`app0` and `app1`). Firmware updates can be applied over USB, via `POST /ota`, or by placing `/firmware.bin` on the microSD card root. The animation pack is stored on the microSD card, not in flash.

### Display timing experiment

The RGB pixel clock is 12 MHz with two internal 10-line bounce buffers. This
configuration stopped the reported whole-screen shifts during data transfers,
but flickering was still reported. A follow-up at 16 MHz with 20-line bounce
buffers made the glitches worse and was reverted.

With the configured porches, 12 MHz targets approximately 44 Hz panel refresh
instead of 59 Hz at 16 MHz. The two PSRAM framebuffers, 20 kHz backlight PWM, and
asset-defined animation frame rates are unchanged. The cause of the remaining
flicker has not been established; this is a diagnostic mitigation, not a complete
display fix.

## Generate animation assets

The atlases under `media/animations/` are browser assets. The exporter crops them into independently decodable JPEG frames plus 4-bit RLE alpha, adds per-frame CRCs, and writes one seekable pack.

From the repository root:

```sh
npm ci
npm ci --prefix tools
npm run export:firmware --prefix tools
```

Output: `firmware/data/animations.orb`—currently **7,837,791 bytes**, containing **10 clips and 624 frames at 320×320/12 fps**. ORBA version 1 uses a 16-byte clip-name field; names must fit 15 characters plus NUL. `mona-pr`, `mona-workflow`, and `mona-security` fit without a format change.

Copy `firmware/data/animations.orb`, `firmware/data/ATTRIBUTION.txt`, and `firmware/data/sounds.json` to the **root** of a FAT32-formatted microSD card. The firmware mounts the card at `/sdcard` and requires `/animations.orb`; it does not format the card. There is no flash filesystem or fallback asset store if the card or pack is missing. `/sounds.json` defines short onboard-buzzer pulse patterns; sound playback stays unavailable and reports the asset error if the file is absent or invalid.

Alternatively, use **Device maintenance** in the dashboard. Select **Update through Wi-Fi** or **Update through USB**, then **Upload animations and sounds** under **SD card assets**. Wi-Fi uses the saved Orb connection; USB requires a selected device accessible to the dashboard host. Both send the published files from `dist/sdcard`. Each file is validated and replaced separately; a failed second upload does not undo a successful first upload. Press **Restart to load assets** afterwards.

The same selector controls **Upload latest firmware**, using the newest published binary from `dist/firmware` (`npm run firmware:build`). USB application updates use acknowledged serial chunks and the inactive OTA partition, not an external flashing utility. Older firmware needs an initial developer USB flash to enable the new transport paths; initial installation and recovery remain PlatformIO operations.

Exporter options:

- `ORB_JPEG_QUALITY`: JPEG quality, default `0.82`.
- `ORB_ASSET_MAX_BYTES`: safety limit, default 12 MiB.
- `--output <path>`: alternate output path; copy the selected pack and attribution file to the SD-card root.

If animation source changes, run:

```sh
npm run render --prefix tools
npm run render:mona --prefix tools
npm run export:firmware --prefix tools
npm test --prefix tools
npm run verify:mona --prefix tools
```

When acquiring Mona for the first time, run `npm run prepare:mona --prefix tools` before rendering. It is pinned to octoprints revision `981a85f0bec9d1a9c280fd5719d0d797852229c4`, the same retained revision as Copilot, and does not refresh Copilot's source. The render commands preserve the other mascot's clips and provenance. See [`../tools/MONA.md`](../tools/MONA.md) for source/adapter details. `verify:mona` checks decoded browser pixels, not visual quality or device performance.

On macOS the renderer uses installed Google Chrome. Elsewhere set `CHROME_PATH` or install Playwright Chromium. Never load a complete WebP atlas into ESP32 RAM.

Preparation, rendering and export **never upload automatically**. Copy the generated pack and attribution file to the SD card, then upload the firmware over USB (commands below). Keep `data/ATTRIBUTION.txt` with the pack.

## Build and flash

Install PlatformIO Core or the VS Code PlatformIO extension. From `firmware/`:

```sh
pio device list
pio run -e waveshare_s3_touch_lcd_21
pio run -e waveshare_s3_touch_lcd_21 --target upload --upload-port <port>
pio device monitor --port <port> --baud 115200
```

Insert the SD card before powering on. The firmware initializes the display first, then mounts the card in 1-bit SDMMC mode (CLK GPIO 2, CMD GPIO 1, D0 GPIO 42; card D3 enable via expander EXIO4). Close the serial monitor before uploads. On macOS the device path can change after reset or bootloader entry. If uploads are unreliable, lower `upload_speed` in `platformio.ini` from `921600`.

Build outputs are under `.pio/build/waveshare_s3_touch_lcd_21/`. The platform uses PIOArduino's floating stable channel and compatible library ranges; initial builds require network access and are not bit-for-bit reproducible over time.

## Provisioning

The recommended path is the host-native Orb Dashboard: connect the flashed Orb over USB, run `npm start --prefix dashboard` from the repository root, open `http://127.0.0.1:7420/dashboard/`, select the Espressif device, and enter the 2.4 GHz Wi-Fi details. Firmware stages the credentials in a separate NVS namespace, restarts, and commits them only after DHCP succeeds. A failed attempt restores the previous credentials. The dashboard then retrieves the station IP, port, and token over USB and writes `observer/config.json` without storing the Wi-Fi passphrase.

The dashboard must run on the host for USB access; Docker cannot provision USB on macOS. You can alternatively provision through `/config.json` on the SD card root or the **`GitHub-Orb-Setup`** captive portal:

1. Power the display. On first boot (if `/config.json` does not supply reachable Wi-Fi credentials) it creates the **`GitHub-Orb-Setup`** access point.
2. Join that network from a phone or computer.
3. Open the captive portal. If it does not appear, browse to `http://192.168.4.1/`.
4. Select a 2.4 GHz Wi-Fi network and enter its password.
5. Enter:
   - mDNS hostname (default `github-orb` for `github-orb.local`).
   - HTTP API port `7420`.
   - API bearer token (pre-filled with an auto-generated random token if none was set).
   - Optional GitHub classic PAT for notification polling, and poll interval in seconds (default `60`).
   - A POSIX timezone such as `UTC0` or `CET-1CEST,M3.5.0,M10.5.0/3`.
6. Save and reconnect the phone/computer to its normal network.

The portal times out after five minutes. Wi-Fi connection attempts time out after 20 seconds. Once connected, the ESP32 advertises `http://github-orb.local:7420` via mDNS.

## OTA updates

With dual 3 MiB OTA slots (`app0` and `app1`), you can update firmware without USB in two ways:

1. **HTTP `POST /ota`**:
   ```sh
   curl -fsS -X POST \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/octet-stream" \
     --data-binary @firmware/.pio/build/waveshare_s3_touch_lcd_21/firmware.bin \
     http://github-orb.local:7420/ota
   ```
2. **SD-card `/firmware.bin`**:
   Copy `.pio/build/waveshare_s3_touch_lcd_21/firmware.bin` to `/firmware.bin` on the microSD card root. On next boot, the ESP32 flashes the image to the inactive OTA slot, renames `/firmware.bin` to `/firmware.bak`, and restarts.

Wi-Fi asset updates use authenticated `POST /assets` with `Content-Type: application/octet-stream`, an exact `Content-Length`, and `X-Orb-Asset: animations.orb` or `sounds.json`. Limits are 32 MiB and 4096 bytes respectively. Authenticated `POST /restart` loads the updated assets after an explicit restart. Firmware and asset writes share exclusive ownership across HTTP and serial; conflicting operations return `busy`. Raw HTTP bodies stream in bounded chunks rather than being buffered in RAM.

Serial `status` advertises `usbFirmwareUpdate`. New clients use `firmware_begin` or `asset_begin` with `size` and `chunked: true`, then `update_chunk` (at most 4096 bytes), raw bytes, and `update_status` to acknowledge the received byte count. `firmware_commit` validates the application and restarts; `asset_commit` validates and replaces the named file without restarting. `update_abort` cancels between chunks; incomplete raw chunks time out after 30 seconds. The legacy continuous-byte asset protocol is retained. CDC receive buffering is 8192 bytes; control replies retain their `@ORB ` prefix.

## Normal behavior

- The ESP32 HTTP server listens on port `7420` (`GET /health`, `POST /event`, `GET /state`, `GET/PUT /settings`, `GET /github/status`, `POST /ota`).
- The additive [SDK observer protocol](../docs/architecture.md#explicit-sdk-observer-protocol-version-1) accepts explicit aggregate Copilot session states without the legacy eight-second approval guess. Observer sessions remain active until explicitly ended or the Orb restarts. The legacy event API retains its behavior for older clients. Observer-capable firmware must be deployed before targeting the physical device; testing the updated dashboard does not update the board.
- When Wi-Fi is disconnected, the local mood is **OFFLINE** with a slashed Wi-Fi indicator.
- Looping clips wrap; Done and Error hold their final frame.
- Copilot sounds only when done or waiting for user input. Mona uses distinct brief rhythms for PR, review, workflow, security, and general GitHub notifications. Sound patterns are loaded from `/sounds.json` on the SD card; quiet hours use local device time and strict 24-hour `HH:MM` values.
- Sound is disabled by default. Enable it in the dashboard's **Live Orb** settings and **Save to Orb**. The onboard active buzzer (expander EXIO8) has fixed loudness; volume zero mutes it. Authenticated `POST /audio/test` schedules the completion rhythm without creating a session or alert (`202 {"scheduled":true}`). It returns `409` with `sound_muted`, `quiet_hours_active`, `sound_assets_unavailable`, or `audio_busy` when unavailable. The dashboard exposes this as **Test Orb sound**. Browser audio permission is unrelated. Muting also stops an in-progress rhythm.
- Three fixed groups of session dots replace the moving ring colors. Working dots are steady blue; finished/inactive sessions are green; Ask dots blink amber with a question mark over that session's group. After two minutes inactive, a session disappears and its dots fade; when none remain, Copilot sleeps with faded dots. Tap a group to select its animation, then tap it again (or the centre) for details or a read-only approval card. Activity appears above Copilot, the tool in smaller text underneath, and the session title below Copilot. No overflow counter is shown.
- Mona is selected by `mascot` and explicit `clip`, not mood alone: PR assignment/review uses `mona-pr`/`needsInput`; workflow failure uses `mona-workflow`/`error`; critical Dependabot news uses `mona-security`/`error`. Each Mona clip has 24 frames over two seconds, settles at 1.5 seconds, then holds the last frame. New `presentationId` revisions replay even the same clip.
- The ESP32 uses only `GET /notifications` for GitHub polling; it does not request user, PR, Actions, or Dependabot details. Workflow notifications are not interpreted as failures, and security notifications are not assigned a severity unless the inbox provides it. Mona stays as sticky latest news while underlying Copilot sessions continue; Copilot events cannot dismiss her. Tap once for notification details (type, organization or owner, repository, and title), then tap the card to acknowledge locally and return to Copilot (or tap outside to close details). This does not mark the notification read on GitHub. The active alert is memory-only and clears on restart. The background GitHub poller runs on a separate FreeRTOS task and persists deduplication state to `/github-state.json` on the SD card.
- Missing Mona frames use a procedural cat-eared octopus silhouette with news labels; missing Copilot frames leave procedural rings/labels. Offline handling retains mascot identity but shows **OFFLINE**.
- Each frame is read from the SD card (guarded by a mutex shared with config/dedup SD access), CRC-checked, decoded, and alpha-composited into the display back buffer.
- Brightness, sound enable, and quiet hours follow stored settings (`PUT /settings`)sioned POSIX timezone.

## Reset and recovery

### Reopen provisioning

Touch and hold the display continuously while powering on for at least 2.5 seconds. Serial output should show `Touch held at boot; clearing saved provisioning`.

This clears Wi-Fi and the `github-orb` preferences namespace, including settings migrated from earlier firmware. It does not erase firmware or animation assets. The gesture is checked only during boot.

### USB recovery

If display or touch initialization fails, use the board's BOOT/RESET bootloader procedure and re-upload over USB. As a destructive last resort:

```sh
pio run -e waveshare_s3_touch_lcd_21 --target erase
```

After erasing, upload the firmware, insert the SD card, then repeat provisioning. The usual ESP32 BOOT-while-reset sequence has not yet been physically validated for this unit.

## Diagnostics

| Symptom                                           | Check                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Blank display                                     | Confirm the 2.1B revision, PSRAM, firmware upload, serial initialization output, and USB power quality.             |
| **OFFLINE** forever                               | Check `http://github-orb.local:7420/health` (or the device IP) from another LAN device; verify Wi-Fi, host, port, firewall, VPN, and guest/client isolation. |
| `Animation SD card mount failed`                  | Insert a FAT32 microSD card and check its contacts.                                                                 |
| `Animation assets: missing or invalid on SD card` | Copy `animations.orb` to the card root and verify it is a valid exported pack.                                      |
| Character absent but ring/label works             | Animation pack missing, CRC-invalid, or incompatible; rebuild the pack and copy it to the SD card.                  |
| Quiet hours ignored                               | Verify internet/NTP access and POSIX timezone syntax.                                                               |
| Provisioning AP loops                             | Verify 2.4 GHz credentials and provide a non-empty token within five minutes.                                       |
| Upload cannot open port                           | Close serial monitor, re-list devices, and retry with the new port path.                                            |

## Hardware sources

The driver and SD-card pin setup are matched to Waveshare's official 2.1/2.1B resources:

- [Waveshare wiki](https://www.waveshare.com/wiki/ESP32-S3-Touch-LCD-2.1)
- [Official demo archive](https://files.waveshare.com/wiki/ESP32-S3-Touch-LCD-2.1/ESP32-S3-Touch-LCD-2.1-Demo.zip)
- [Schematic](https://files.waveshare.com/wiki/ESP32-S3-Touch-LCD-2.1/ESP32-S3-Touch-LCD-2.1_schematic_diagram.pdf)
- [ESP32-S3-Touch-LCD-2.1B project drawing](https://files.waveshare.com/wiki/ESP32-S3-Touch-LCD-2.1/ESP32-S3-Touch-LCD-2.1B-Drawing.zip)

Pin/timing setup was source-verified and firmware compilation passed. Display, touch, buzzer, Wi-Fi, and sustained 12 fps playback still require physical hardware validation.

## Artwork license

The Copilot and Mona model-derived assets by Martin Woodward and octoprints contributors are **CC BY-NC 4.0**; retain `data/ATTRIBUTION.txt`, `../media/copilot/LICENSE.txt` and `../media/mona/LICENSE.txt`. Both `source.json` files record provenance/adaptations. Commercial use requires separate permission; this copyright license grants no GitHub trademark permission or affiliation.
