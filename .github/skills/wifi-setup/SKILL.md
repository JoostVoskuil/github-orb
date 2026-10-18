---
name: wifi-setup
description: "Provision and troubleshoot Wi-Fi on the standalone Waveshare ESP32-S3 GitHub Orb. Use when Wi-Fi setup is unavailable, the board starts its setup access point, credentials need to be configured, or the device cannot connect to the local network."
---

# ESP32 Wi-Fi setup

Use this workflow for the standalone firmware in `firmware/`.

## Expected provisioning behavior

The firmware stores Wi-Fi credentials in NVS under the `github-orb` namespace and migrates settings from older firmware automatically.
During boot, `DeviceConfigStore::begin()`:

1. Loads the saved SSID and password from NVS.
2. Attempts a station connection for up to 20 seconds when an SSID exists.
3. Starts the `GitHub-Orb-Setup` access point when credentials are missing or the connection fails.
4. Runs the setup portal at `http://192.168.4.1/`.
5. Saves the submitted Wi-Fi and device settings back to NVS, then reconnects.

Therefore, an AP at `192.168.4.1` is normally evidence that provisioning is working—not that the Wi-Fi radio is unavailable.

## Normal setup procedure

1. Power the board and wait for the `GitHub-Orb-Setup` network.
2. Connect a phone or computer to that network.
3. Open `http://192.168.4.1/` manually if the captive portal does not appear.
4. Select a **2.4 GHz** Wi-Fi network and enter its password.
5. Keep or set the device hostname, API token, optional GitHub PAT, poll interval, and timezone.
6. Save the form and wait for the board to reboot or return to station mode.
7. Reconnect the client device to the normal LAN and verify the mDNS/API address, normally `http://github-orb.local:7420/`.

The ESP32-S3 does not connect to 5 GHz-only networks. For troubleshooting, use a visible 2.4 GHz WPA/WPA2 network with a simple SSID and password.

## Diagnosis from serial output

Capture serial at 115200 baud after boot and classify the result:

- `GitHub Orb starting` followed by `GitHub-Orb-Setup` / `192.168.4.1`: no saved credentials, or the saved network was unreachable; use the setup portal.
- `Wi-Fi: <ssid> (<ip>)`: station connection succeeded.
- `Provisioning failed or token is empty; restarting`: the portal timed out, connection failed, or the API token was empty; retry the portal and save all required fields.
- Repeated station failures: verify 2.4 GHz availability, signal, password, router access control, and DHCP.
- Missing SD or display errors: diagnose storage/display separately; they are not Wi-Fi provisioning failures.

Do not expose Wi-Fi passwords, API tokens, or GitHub PATs in logs or reports.

## Safe recovery rules

- Do not run `uploadfs`, format the SD card, erase flash, or reset credentials merely because the setup AP appears.
- An application-only PlatformIO upload preserves NVS and SD contents.
- Do not hold the display touch input during boot unless the user explicitly wants to clear provisioning. In this firmware, a touch held for approximately 2.5 seconds clears saved provisioning and starts a fresh portal.
- If the AP does not appear, verify power, USB stability, serial boot output, and that the firmware reached provisioning. Do not claim Wi-Fi success from a build or flash result alone.
- After a successful setup, confirm the station IP and HTTP/mDNS availability on the same LAN.

## Firmware references

- Wi-Fi provisioning: `firmware/src/device_config.cpp`
- Boot orchestration: `firmware/src/main.cpp`
- Device settings model: `firmware/include/device_config.h`
- User setup documentation: [`docs/getting-started.md`](../../../docs/getting-started.md), [`docs/dashboard.md`](../../../docs/dashboard.md), and [`firmware/README.md`](../../../firmware/README.md).
