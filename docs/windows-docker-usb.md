# Windows Docker USB setup

Docker disables USB setup by default. On Windows, `usbipd-win` can forward the Orb to WSL 2, and a Compose override can pass its Linux serial device into the dashboard container.

## Attach the Orb to WSL 2

Install or update WSL 2 and install `usbipd-win` from an elevated PowerShell prompt:

```powershell
winget install --interactive --exact dorssel.usbipd-win
wsl --update
```

Open the WSL 2 distribution that will use Docker and keep it running. In elevated PowerShell, find and share the Orb:

```powershell
usbipd list
usbipd bind --busid <BUSID>
```

Then attach it from PowerShell (administrator privileges are not required for this command):

```powershell
usbipd attach --wsl --busid <BUSID>
```

The device is now owned by WSL rather than Windows. In the same WSL distribution, find the serial device and its group ID:

```bash
ls -l /dev/ttyACM*
stat -c '%g' /dev/ttyACM0
```

Use the actual path shown by `ls` if it is not `/dev/ttyACM0`.

## Start the dashboard with USB access

Run these commands from the repository root in the WSL distribution whose Docker Engine can access that device:

```bash
export ORB_USB_DEVICE=/dev/ttyACM0
export ORB_USB_GID="$(stat -c '%g' "$ORB_USB_DEVICE")"
docker compose -f compose.yaml -f compose.windows-usb.yaml up --build -d --force-recreate
```

The override enables the serial setup service and grants the container read/write access only to the selected serial device and its group. Open <http://127.0.0.1:7421/dashboard/>.

In **Device maintenance**, **Update through Wi-Fi** is the default and supports both firmware and asset uploads without USB forwarding. To use the forwarded device, select it in settings and choose **Update through USB**. Firmware and assets remain separate actions, both using the selected connection. USB application updates need current Orb firmware, not PlatformIO inside the container; older firmware needs one developer USB flash first. Firmware restarts automatically, while assets use **Restart to load assets**. Copilot extension installation remains USB-only.

Compose resolves device paths on the Docker daemon host. If the dashboard still reports `serial_unavailable`, confirm that the `docker` daemon used by Compose can see the same `/dev/ttyACM*` path. A device attached only to another WSL distribution is not automatically available to a separate Docker daemon. You can also check the container's serial-port list:

```bash
docker compose exec dashboard node -e "import('./dist/dashboard/usb-setup.js').then(async ({ listLinuxSerialPorts }) => console.log(await listLinuxSerialPorts()))"
```

Attach the Orb before starting or recreating the container. If its `/dev/ttyACM*` path changes, update `ORB_USB_DEVICE` and `ORB_USB_GID`, then rerun the Compose command. To return to the default USB-disabled configuration, run `docker compose up -d --force-recreate` without the override.

See Microsoft's [Connect USB devices to WSL](https://learn.microsoft.com/windows/wsl/connect-usb) guide for WSL prerequisites and `usbipd-win` details.
