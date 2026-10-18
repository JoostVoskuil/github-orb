# Get started

GitHub Orb runs on the Waveshare **ESP32-S3-Touch-LCD-2.1B** and can be managed with the local Orb Dashboard.

## Requirements

- Waveshare **ESP32-S3-Touch-LCD-2.1B**, a FAT32 microSD card, a USB data cable, and PlatformIO.
- Node.js 24 LTS on the host for the Copilot observer and animation tooling. The Docker dashboard runs in a Node 24 container.

The board driver is revision-specific. Verify the revision printed on the board before flashing. For firmware installation and recovery, see [firmware build and recovery](../firmware/README.md).

## Build and upload firmware

Install PlatformIO Core or the PlatformIO IDE extension, connect the Orb to USB, and run these commands from the repository root. Verify the hardware revision before flashing.

Build the firmware:

```sh
pio run -d firmware -e waveshare_s3_touch_lcd_21
```

Find the connected board's serial port:

```sh
pio device list
```

Upload the application, replacing `<PORT>` with the port reported for the Orb:

```sh
pio run -d firmware -e waveshare_s3_touch_lcd_21 --target upload --upload-port <PORT>
```

The upload command builds the application before flashing it. Close any serial monitor that is using the port. This uploads firmware only; it does not copy animation or sound assets to the microSD card. For asset preparation, OTA updates, diagnostics, and recovery details, see [firmware build and recovery](../firmware/README.md).

## Configure Wi-Fi with the dashboard

The recommended setup uses the host-native Orb Dashboard, which can access the Orb over USB. From the repository root, run:

```sh
npm run dashboard
```

Open <http://127.0.0.1:7420/dashboard/> and use the **Live Orb** tab:

1. Connect a USB data cable and select the Espressif USB device.
2. Open **Set up or change Wi-Fi**, enter a 2.4 GHz network and passphrase, and choose **Connect Orb to Wi-Fi**. The Orb restarts and rolls back to its previous credentials if the connection fails.
3. After a successful connection, the dashboard reads the Orb's IP address and API token over USB, saves the private, gitignored `observer/config.json`, and loads the device settings. An already configured Orb can load over Wi-Fi without USB.
4. Adjust sound, brightness, quiet hours, timezone, or optional GitHub notifications, then choose **Save to Orb**. Sound is off by default; enable physical sound and set a nonzero volume to use the buzzer.

Wi-Fi passphrases and GitHub PATs are cleared from their forms after submission and are not stored in browser storage. A failed settings load keeps editing disabled until the connection succeeds.

## Other provisioning options

The FAT32 microSD card and captive portal are available if dashboard USB provisioning is not suitable:

1. Copy `firmware/data/animations.orb`, `firmware/data/ATTRIBUTION.txt`, and `firmware/data/sounds.json` to the root of the card.
2. Optionally create `/config.json` on the card to pre-populate Wi-Fi, an API bearer token, and a GitHub PAT:

   ```json
   {
     "wifiSsid": "YourWiFi",
     "wifiPassword": "YourPassword",
     "hostname": "github-orb",
     "port": 7420,
     "token": "replace-with-your-secret-token",
     "githubPat": "",
     "githubPollSec": 60,
     "timezone": "CET-1CEST,M3.5.0,M10.5.0/3"
   }
   ```

3. If Wi-Fi is not configured or reachable, join the **`GitHub-Orb-Setup`** access point and open <http://192.168.4.1/>. Select a 2.4 GHz network and enter the token and any optional GitHub settings.
4. Once connected, the Orb advertises `http://github-orb.local:7420` via mDNS. Check connectivity with `curl -fsS http://github-orb.local:7420/health`.

## Next steps

- [Connect a Copilot host](../observer/README.md) to stream session activity to the Orb or dashboard.
- [Configure the dashboard](dashboard.md) for Docker, observer destinations, and service settings.
- [Set up Windows Docker USB forwarding](windows-docker-usb.md) if USB access from Docker is needed.
