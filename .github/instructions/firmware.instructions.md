---
description: "Firmware build, immediate USB upload, runtime verification, and upload-skill maintenance for the Waveshare ESP32-S3."
applyTo: "firmware/**"
---

# Firmware changes

- Use the [ESP32 firmware upload skill](../skills/esp32-firmware-upload/SKILL.md) when changing firmware source, headers, dependencies, or build configuration, or when asked to flash the board.
- Standing user preference: after a firmware-affecting change, build, run relevant tests, and **immediately upload to the attached ESP32 in the same task**, without waiting for another flash request. Respect an explicit no-upload instruction; documentation-only changes do not require flashing.
- Detect the current USB port and verify upload and runtime results. If the board is absent or ambiguous, report the blocker rather than claim success.
- Upload the application only. Preserve SD assets and provisioning; do not routinely use `uploadfs`, format, erase, or reset credentials.
- When verified tooling, hardware, or upload steps change, update the upload skill directly in that same task so it remains accurate.