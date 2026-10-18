---
name: esp32-firmware-upload
description: "Build, test, flash, and verify this project's USB-attached Waveshare ESP32-S3 firmware. Use when asked to flash, upload, deploy, or update the ESP32, and immediately after changing firmware source, headers, dependencies, or build configuration. Keep this workflow updated when upload steps change."
---

# ESP32 firmware upload

## Standing user preference

After a firmware-affecting change, build, test, and upload it directly to the attached board in the same task. Do not ask the user to request flashing again. Respect any explicit request not to flash. Documentation-only changes do not require a flash.

Update this skill immediately when a verified change to tooling, hardware configuration, upload procedure, or diagnostics makes it stale. Keep the quick compile/USB-upload steps in [`docs/getting-started.md`](../../../docs/getting-started.md) and the full build, flash, OTA, and recovery procedures in [`firmware/README.md`](../../../firmware/README.md) synchronized with verified changes. Do not turn an unverified hypothesis into a documented fact.

## Known working target

- Hardware: user's onboard-display/onboard-microSD Waveshare ESP32-S3-Touch-LCD-2.1B. Do not infer another board's wiring from its generic PlatformIO board name.
- Project root: the workspace containing `firmware/platformio.ini`; run commands there.
- PlatformIO environment: `waveshare_s3_touch_lcd_21`.
- Toolchain: PIOArduino stable platform, Arduino framework; use the project's configuration, not a newly scaffolded project.
- USB: native ESP32-S3 USB JTAG/serial CDC. Previously verified macOS port: `/dev/cu.usbmodem1101`, USB VID:PID `303A:1001` (decimal `12346:4097`). Detect it each time; the path can change.
- Assets: FAT32 microSD root contains `animations.orb`, `ATTRIBUTION.txt`, and `sounds.json`, copied from `firmware/data/`. Uploading the application does not copy those files. Run `npm run export:firmware --prefix tools` to publish assets to `dist/sdcard`. In **Device maintenance**, choose **Update through Wi-Fi** (default) or **Update through USB**, then **Upload animations and sounds** under **SD card assets**. Both transports were verified with the complete 12,245,081-byte animation pack and sound file. Press **Restart to load assets** afterwards; restart captures the upload target. Files commit individually, so report partial completion accurately. The dashboard never uploads `ATTRIBUTION.txt`.
- Storage setup: display initialization precedes 1-bit SDMMC initialization (CLK GPIO 2, CMD GPIO 1, D0 GPIO 42; D3 enabled through expander EXIO4). The RGB data pins 11–13 are **not** the SD pin mapping. See `firmware/src/board.cpp`.
- No automatic SD formatting, credential reset, full-chip erase, or `uploadfs`. There is no flash filesystem partition. Dual 3 MiB OTA slots are `app0` at `0x20000` and `app1` at `0x320000`, with `nvs` preserved at `0x9000`, `otadata` at `0xe000`, and `phy_init` at `0x10000`. Flash from `0x620000` onwards is unallocated.
- OTA support: once flashed with the dual-slot layout, firmware can be updated over authenticated HTTP `POST /ota`, the running firmware's USB serial update protocol, or SD `/firmware.bin`. Run `npm run firmware:build` to publish a timestamped application in `dist/firmware`; **Upload latest firmware** uses the newest binary through the shared transport selector. Both dashboard firmware paths were verified with a 1,552,048-byte image and post-restart HTTP health. Older firmware needs one initial developer USB flash to enable USB application updates and Wi-Fi asset uploads. First installation/recovery still use PlatformIO; for firmware development on the attached board, prefer the direct upload below.
- Serial update details: CDC RX buffering must exceed a 4096-byte chunk (currently 8192 bytes). New clients negotiate chunked mode, send `update_chunk`, write its payload, then require `update_status` byte-count acknowledgement before the next chunk. Preserve the `@ORB ` reply prefix: serialize JSON first, then prepend the prefix, because serialization into an Arduino `String` replaces its contents. On macOS use `vmin: 0`, `vtime: 1` for prompt delivery of short serial replies. Wi-Fi asset filenames are carried in `X-Orb-Asset`, because query arguments are not populated yet during the raw upload callback.

## 1. Reuse PlatformIO

Use an existing working executable first. In this workspace the verified installation (PlatformIO Core 6.2.0, 2026-10-17) is:

```sh
PIO="$HOME/.platformio/penv/bin/platformio"
"$PIO" --version
```

If it is missing, check `pio`/`platformio` on PATH and any earlier temporary environment such as `/tmp/copilot-platformio-venv/bin/pio`. Do not repeatedly rediscover or reinstall a working toolchain.

If none exists, create an isolated environment outside the repository, without sudo or system-Python modifications:

```sh
python3 -m venv "$HOME/.cache/copilot-esp32/platformio"
"$HOME/.cache/copilot-esp32/platformio/bin/python" -m pip install platformio
PIO="$HOME/.cache/copilot-esp32/platformio/bin/pio"
```

## 2. Build and test

Inspect current changes and `firmware/platformio.ini`; preserve unrelated user changes. Run:

```sh
"$PIO" run -d firmware -e waveshare_s3_touch_lcd_21
npm run build
node --test dist/tst/firmware/*.test.js
npm test --prefix dashboard
git diff --check
```

The native decoder tests need JPEGDEC sources downloaded by the firmware build, and a native C++ compiler. Run `npm test --prefix tools` when animation or asset-generation behavior changes; use root `npm test` for the complete repository suite. If validation fails, fix relevant failures before uploading. A successful build alone is not a successful flash.

## 3. Detect the connected board

```sh
"$PIO" device list
```

On macOS, inspect `/dev/cu.usbmodem*` and `/dev/cu.usbserial*` if needed. With zsh use null-glob qualifiers (`/dev/cu.usbmodem*(N)`) or Python serial enumeration; unmatched bare globs fail.

Select the USB device matching the ESP32-S3 identity above. Do not select Bluetooth or `/dev/cu.debug-console`. If multiple plausible boards are connected, ask which one. If none is present, stop and ask the user to reconnect USB; do not claim to have uploaded. Close any monitor holding the port.

## 4. Upload application only

Assign `PORT` to the currently detected device; do not blindly reuse the old path.

```sh
"$PIO" run -d firmware -e waveshare_s3_touch_lcd_21 --target upload --upload-port "$PORT"
```

This exact workflow has successfully built, verified flash hashes, and hard-reset the connected ESP32-S3. No BOOT-button action was needed in the verified uploads. Wait for completion and require a successful exit and upload output (hash verification / reset / PlatformIO success). Do not infer success from a build-only run.

If upload fails, inspect the actual error. Re-enumerate after bootloader entry or reset because the device path may change. Do not retry against an unrelated device. Ask for physical BOOT/RESET assistance only when the observed failure requires it. Never erase flash or clear provisioning as a routine recovery step.

## 5. Verify runtime, not just upload

After upload, capture serial output at **115200 baud** for a bounded approximately 12 seconds using pyserial from the same Python environment. Use a monotonic deadline and a serial timeout; close the connection afterwards. Re-enumerate if necessary. Do not leave an indefinite monitor running, poll with shell sleeps, or clear credentials to force startup messages.

Relevant messages:

- `GitHub Orb starting`
- `Animation assets: SD card ready` and `Animation assets: ready`
- `Animation SD card mount failed`
- `Animation assets: missing or invalid on SD card`
- `Notification sounds: SD card ready` or `Notification sounds: missing or invalid on SD card`
- `Animation clip missing: ...`
- `Animation frame read/decode failed: ...`
- `ERROR: PSRAM was not detected` or display initialization failure
- Provisioning/restart messages and repeated boot loops

Missing NVS preferences can be expected on an unprovisioned unit; it does not prove SD failure. Offline animation and the slashed Wi-Fi indicator should continue while Wi-FiManager is connecting or serving its portal. Rendering/SD access stays on the main task while network provisioning runs separately.

Serial silence does not establish runtime success. Report which messages were actually captured, and distinguish firmware upload, asset loading, network connection, and visual playback. Never expose Orb API tokens, Wi-Fi passwords, or other secrets from serial output.

## Completion

Briefly report the detected port, upload outcome, tests, and observed asset status. If blocked, state the specific action needed. Do not claim the SD files were copied, Wi-Fi connected, or animation/sound playback visually or audibly verified unless evidence establishes it.