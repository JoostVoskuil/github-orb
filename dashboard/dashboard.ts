import { Face } from './face.js';
import { Artwork } from './artwork.js';
import { Frames } from './frames.js';
import { Chime, inQuietHours } from './audio.js';
import { presentation, renderNews } from './presentation.js';
import { OrbEngine } from './orb-engine.js';
import type { DeviceSettings, DeviceSettingsUpdate } from './device-settings.js';
import type { ObserverConfiguration, ObserverDestination } from './observer-status.js';
interface ElementMap {
    display: HTMLCanvasElement;
    log: HTMLOListElement;
    sound: HTMLInputElement;
    volume: HTMLInputElement;
    brightness: HTMLInputElement;
    'qh-enabled': HTMLInputElement;
    'qh-start': HTMLInputElement;
    'qh-end': HTMLInputElement;
    'mode-tabs': HTMLDivElement;
    'orb-panel': HTMLElement;
    'orb-sidebar': HTMLDivElement;
    'activity-log': HTMLFieldSetElement;
    'dashboard-panel': HTMLElement;
    'animations-panel': HTMLElement;
    'preview-controls': HTMLFieldSetElement;
    'scenario-buttons': HTMLDivElement;
    'scenario-status': HTMLParagraphElement;
    'github-status': HTMLParagraphElement;
    'dashboard-extension-status': HTMLParagraphElement;
    'dashboard-install-observer': HTMLButtonElement;
    'dashboard-github-form': HTMLFormElement;
    'dashboard-github-token': HTMLInputElement;
    'dashboard-github-save': HTMLButtonElement;
    'dashboard-github-clear': HTMLButtonElement;
    'dashboard-github-status': HTMLParagraphElement;
    'live-settings': HTMLFieldSetElement;
    'quiet-now': HTMLParagraphElement;
    status: HTMLSpanElement;
    'mood-now': HTMLSpanElement;
    news: HTMLAnchorElement;
    fps: HTMLSpanElement;
    'audio-unlock': HTMLButtonElement;
    'orb-audio-test': HTMLButtonElement;
    'orb-audio-status': HTMLParagraphElement;
    'usb-port': HTMLSelectElement;
    'usb-refresh': HTMLButtonElement;
    'orb-settings-form': HTMLFormElement;
    'orb-settings-save': HTMLButtonElement;
    'orb-settings-load': HTMLButtonElement;
    'orb-settings-status': HTMLParagraphElement;
    'github-token': HTMLInputElement;
    'github-token-clear': HTMLInputElement;
    'github-poll-sec': HTMLInputElement;
    'device-github-status': HTMLParagraphElement;
    'orb-timezone': HTMLInputElement;
    'usb-install-observer': HTMLButtonElement;
    'usb-status': HTMLParagraphElement;
    'orb-connection-status': HTMLParagraphElement;
    'orb-extension-status': HTMLParagraphElement;
    'wifi-form': HTMLFormElement;
    'wifi-fields': HTMLFieldSetElement;
    'wifi-connect': HTMLButtonElement;
    'wifi-connection': HTMLDetailsElement;
    'wifi-status': HTMLParagraphElement;
    'observer-summary': HTMLElement;
    'observer-refresh': HTMLButtonElement;
    'observer-destinations': HTMLUListElement;
    'observer-installation': HTMLParagraphElement;
    'observer-config-path': HTMLParagraphElement;
    'observer-action-status': HTMLParagraphElement;
    'wifi-ssid': HTMLInputElement;
    'wifi-password': HTMLInputElement;
    'asset-upload-button': HTMLButtonElement;
    'asset-restart-button': HTMLButtonElement;
    'asset-status': HTMLParagraphElement;
    'asset-progress': HTMLProgressElement;
    'firmware-upload-button': HTMLButtonElement;
    'firmware-progress': HTMLProgressElement;
    'firmware-status': HTMLParagraphElement;
    'update-transport': HTMLFieldSetElement;
    'update-transport-hint': HTMLParagraphElement;
    'demo-start': HTMLButtonElement;
    'demo-stop': HTMLButtonElement;
    'demo-progress': HTMLProgressElement;
    'demo-steps': HTMLOListElement;
    'demo-status': HTMLParagraphElement;
}
function $<K extends keyof ElementMap>(id: K): ElementMap[K] {
    const element = document.getElementById(id);
    if (!element)
        throw new Error(`Missing dashboard element: ${id}`);
    return element as ElementMap[K];
}
const canvas = $('display');
const ctx = canvas.getContext('2d');
const chime = new Chime();
const STALE_MS = 45_000;
let face;
let previewEngine;
let pollTimer;
let liveOnline = false;
let live = { mood: 'disconnected', tool: null, source: null, sessions: [] };
let lastDebugMessageId = 0;
let debugFeedWarned = false;
let settings = { sound: false, volume: 0.5, brightness: 1, quietHours: { enabled: false, start: '22:00', end: '08:00' } };
let mode: 'orb' | 'dashboard' | 'animations' = 'orb';
let previewOffline = false;
let previewTimers = [];
let lastMessageAt = 0;
let retryMs = 1000;
let lastSound = { key: '', at: 0 };
let lastGitHubIssue = '';
let acknowledgingAlert = false;
let physicalSettingsLoaded = false;
let settingsDirty = false;
let settingsBusy = false;
async function submitPermissionDecision(target: string, decision: 'approve' | 'deny', alreadyPending = false) {
    // Never route a preview/demo click to a real observer.
    const session = mode === 'dashboard' && connected() && face.currentPermission(target);
    if (!session || (!alreadyPending && !face.markDecisionPending(target))) return;
    try {
        await settingsResponse('/permission-decision', 'POST', {
            sessionId: session.sessionId, attentionId: session.attention.id, decision
        });
    } catch (error) {
        const message = `Permission decision not confirmed: ${error instanceof Error ? error.message : 'unknown error'}. Check the computer before retrying.`;
        face.decisionStatus = { target, message: 'Decision failed — check activity log' };
        log(message);
        // Keep one-shot controls disabled: a lost response may still have queued the decision.
    }
}
async function loadEmotions() {
    const res = await fetch('/protocol/emotions.json', { cache: 'no-store' });
    return res.json();
}
function log(text) {
    const li = document.createElement('li');
    li.textContent = `${new Date().toLocaleTimeString()} ${text}`;
    $('log').prepend(li);
    while ($('log').children.length > 40)
        $('log').lastChild.remove();
}
async function refreshDebugMessages() {
    try {
        const response = await api('/messages');
        if (!response.ok)
            throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        const messages = body.messages ?? [];
        if (messages.length && messages[messages.length - 1].id < lastDebugMessageId)
            lastDebugMessageId = 0;
        for (const message of messages) {
            if (message.id <= lastDebugMessageId)
                continue;
            lastDebugMessageId = message.id;
            const summary = `POST /event ${message.accepted ? 'accepted' : 'rejected'}`;
            const fields = message.fields.map(({ field, value }) => `${field}: ${value}`);
            if (message.error)
                fields.push(`error: ${message.error}`);
            log([summary, ...fields].join('\n'));
        }
        debugFeedWarned = false;
    }
    catch {
        if (!debugFeedWarned)
            log('debug message feed unavailable');
        debugFeedWarned = true;
    }
}
function api(path: string, method = 'GET', body?: unknown) {
    return fetch(path, {
        method,
        headers: {
            ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store'
    });
}
let observerRefreshing = false;
let observerRemoving = false;
async function removeObserverDestination(destination: ObserverDestination) {
    if (observerRemoving || observerRefreshing) return;
    observerRemoving = true;
    $('observer-refresh').disabled = true;
    for (const button of $('observer-destinations').querySelectorAll('button')) button.disabled = true;
    $('observer-action-status').textContent = `Removing ${destination.host}:${destination.port}…`;
    try {
        await settingsResponse('/setup/observer', 'DELETE', {
            id: destination.id, host: destination.host, port: destination.port
        });
        $('observer-action-status').textContent = 'Destination removed. Start a fresh Copilot session to apply the change; existing sessions keep sending to their original destinations.';
    } catch (error) {
        $('observer-action-status').textContent = `Could not remove destination: ${error instanceof Error ? error.message : 'unknown error'}`;
    } finally {
        observerRemoving = false;
        await refreshObserverConfiguration();
    }
}
async function refreshObserverConfiguration() {
    if (observerRefreshing || observerRemoving) return;
    observerRefreshing = true;
    $('observer-refresh').disabled = true;
    try {
        const body: ObserverConfiguration = await settingsResponse('/setup/observer');
        const labels = { orb: 'Live Orb (ESP32)', dashboard: 'Live Dashboard', other: 'Other destination' };
        const statuses = {
            reachable: 'API reachable',
            unauthorized: 'Authentication failed — reinstall for this destination',
            unreachable: 'API unreachable — check its connection',
            invalid_response: 'Unexpected API response'
        };
        $('observer-destinations').replaceChildren();
        for (const destination of body.destinations) {
            const item = document.createElement('li');
            item.dataset.status = destination.status;
            const title = document.createElement('strong');
            title.textContent = labels[destination.kind];
            const detail = document.createElement('div');
            detail.textContent = `${destination.host}:${destination.port} · ${statuses[destination.status]}` +
                (destination.activeSessions === null ? '' : ` · ${destination.activeSessions} live session(s)`);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = 'Remove';
            remove.setAttribute('aria-label', `Remove ${labels[destination.kind]} at ${destination.host}:${destination.port}`);
            remove.onclick = () => void removeObserverDestination(destination);
            item.append(title, detail, remove);
            $('observer-destinations').append(item);
        }
        const kinds = new Set(body.destinations.map(destination => destination.kind));
        $('observer-summary').textContent = body.error
            ? body.error === 'config_not_found' ? 'No observer destinations configured'
                : `Could not read observer configuration: ${body.error}`
            : kinds.has('orb') && kinds.has('dashboard') ? 'Configured for both ESP32 and dashboard'
                : kinds.has('orb') ? 'Configured for Live Orb (ESP32)'
                    : kinds.has('dashboard') ? 'Configured for Live Dashboard'
                        : body.destinations.length ? `Configured for ${body.destinations.length} destination(s)`
                            : 'No observer destinations configured';
        $('observer-installation').textContent = body.installed
            ? 'User-level extension installed for this configuration. Start a fresh Copilot session after changing destinations.'
            : 'No matching user-level extension found for this configuration. Use an install button below; project or custom installations are not checked here.';
        $('observer-config-path').textContent = `Configuration file: ${body.configPath}`;
    } catch (error) {
        $('observer-summary').textContent = `Observer status unavailable: ${error instanceof Error ? error.message : 'unknown error'}`;
        $('observer-destinations').replaceChildren();
        $('observer-installation').textContent = '';
        $('observer-config-path').textContent = '';
    } finally {
        observerRefreshing = false;
        $('observer-refresh').disabled = false;
    }
}
async function refreshUsbPorts() {
    const select = $('usb-port');
    const previous = select.value;
    $('usb-refresh').disabled = true;
    $('usb-status').textContent = 'Scanning USB devices…';
    try {
        const response = await api('/setup/ports');
        const body = await response.json();
        if (!response.ok)
            throw new Error(body.error || `HTTP ${response.status}`);
        select.replaceChildren();
        const placeholder = new Option('Select a connected Orb…', '');
        placeholder.disabled = true;
        placeholder.selected = true;
        select.append(placeholder);
        for (const port of body.ports ?? []) {
            const option = document.createElement('option');
            option.value = port.id;
            option.textContent = port.label;
            select.append(option);
        }
        if (previous && [...select.options].some((option) => option.value === previous))
            select.value = previous;
        $('usb-status').textContent = select.options.length > 1
            ? select.value ? 'USB device selected. Continue with Wi-Fi setup or connect Copilot below.'
                : 'Select your Orb above to enable Wi-Fi setup and extension installation.'
            : 'No USB Orb found. Connect a USB data cable and rescan. An already configured Orb can still be managed over Wi-Fi.';
    }
    catch (error) {
        select.replaceChildren(new Option('USB setup unavailable', ''));
        $('usb-status').textContent = `USB setup unavailable: ${error instanceof Error ? error.message : 'unknown error'}`;
    }
    finally {
        $('usb-refresh').disabled = false;
        updateSetupControls();
    }
}
function updateSetupControls() {
    const busy = settingsBusy || maintenanceBusy;
    const selected = !!$('usb-port').value;
    $('wifi-fields').disabled = busy || !selected;
    $('usb-install-observer').disabled = busy || !selected;
    $('live-settings').disabled = busy || !physicalSettingsLoaded;
    $('usb-port').disabled = busy;
    $('usb-refresh').disabled = busy;
    $('orb-settings-load').disabled = busy;
}
function setSettingsBusy(busy: boolean) {
    settingsBusy = busy;
    updateSetupControls();
}
function applyDeviceSettings(next: DeviceSettings) {
    applySettings(next);
    $('github-poll-sec').value = String(next.githubPollSec);
    $('orb-timezone').value = next.timezone;
    $('github-token').value = '';
    $('github-token-clear').checked = false;
    $('github-token').disabled = false;
    $('device-github-status').textContent = next.githubConfigured
        ? 'Orb: GitHub PAT saved.'
        : 'Orb: no GitHub PAT saved; polling is disabled.';
    physicalSettingsLoaded = true;
    settingsDirty = false;
}
async function settingsResponse(path: string, method = 'GET', body?: unknown) {
    const response = await api(path, method, body);
    const result = await response.json();
    if (!response.ok)
        throw new Error(result.error || `HTTP ${response.status}`);
    return result;
}
async function loadPhysicalSettings() {
    if (settingsBusy)
        return;
    setSettingsBusy(true);
    $('orb-settings-status').textContent = 'Loading saved Orb settings…';
    try {
        const next: DeviceSettings = await settingsResponse('/setup/settings');
        applyDeviceSettings(next);
        await syncPreviewSettings(next);
        $('orb-settings-status').textContent = 'Settings loaded from the physical Orb.';
        $('orb-connection-status').textContent = 'Connected to the physical Orb over Wi-Fi. No network setup is needed; continue below.';
    }
    catch (error) {
        $('orb-settings-status').textContent = `Could not load Orb settings: ${error instanceof Error ? error.message : 'unknown error'}. Retry the connection before saving.`;
        $('orb-connection-status').textContent = 'The saved Orb connection is unavailable. Check that the Orb is powered on and on the same network, or select it over USB and set up Wi-Fi.';
        if (!physicalSettingsLoaded) $('wifi-connection').open = true;
    }
    finally {
        setSettingsBusy(false);
    }
}
async function connectOrbWifi() {
    if (settingsBusy || maintenanceBusy || !$('wifi-form').reportValidity()) return;
    const portId = $('usb-port').value;
    if (!portId) {
        $('wifi-status').textContent = 'Select a USB device in step 1 first.';
        return;
    }
    setSettingsBusy(true);
    $('wifi-status').textContent = 'Saving Wi-Fi over USB. Keep the Orb connected while it restarts and reconnects…';
    let connected = false;
    try {
        const body = await settingsResponse('/setup/provision', 'POST', {
            portId, wifiSsid: $('wifi-ssid').value, wifiPassword: $('wifi-password').value
        });
        connected = true;
        physicalSettingsLoaded = false;
        $('wifi-ssid').value = '';
        $('github-token').value = '';
        $('wifi-status').textContent = `Wi-Fi connected at ${body.host}:${body.port}. Loading the Orb settings…`;
        $('orb-connection-status').textContent = `Wi-Fi connected at ${body.host}:${body.port}.`;
        log(`physical Orb configured at ${body.host}:${body.port}`);
    } catch (error) {
        $('wifi-status').textContent = `Could not connect the Orb: ${error instanceof Error ? error.message : 'unknown error'}. Check the USB cable and Wi-Fi details, then retry.`;
    } finally {
        $('wifi-password').value = '';
        setSettingsBusy(false);
    }
    if (connected) {
        await loadPhysicalSettings();
        $('wifi-status').textContent = physicalSettingsLoaded
            ? 'Wi-Fi connected and settings loaded. Continue with Copilot and your preferences below.'
            : 'Wi-Fi connected, but settings could not be loaded. Retry the connection above.';
        if (physicalSettingsLoaded) $('wifi-connection').open = false;
        void refreshObserverConfiguration();
    }
}
async function savePhysicalSettings() {
    if (settingsBusy || !physicalSettingsLoaded || !$('orb-settings-form').reportValidity())
        return;
    const update: DeviceSettingsUpdate = {
        sound: $('sound').checked,
        volume: Number($('volume').value),
        brightness: Number($('brightness').value),
        quietHours: { enabled: $('qh-enabled').checked, start: $('qh-start').value, end: $('qh-end').value },
        timezone: $('orb-timezone').value.trim(),
        githubPollSec: Number($('github-poll-sec').value),
        ...($('github-token-clear').checked ? { githubPat: '' } :
            $('github-token').value ? { githubPat: $('github-token').value } : {})
    };
    setSettingsBusy(true);
    try {
        $('orb-settings-status').textContent = 'Saving settings to the physical Orb…';
        const next: DeviceSettings = await settingsResponse('/setup/settings', 'PUT', update);
        applyDeviceSettings(next);
        await syncPreviewSettings(next);
        $('orb-settings-status').textContent = 'All settings saved to the physical Orb.';
        log('physical Orb settings saved');
    }
    catch (error) {
        $('orb-settings-status').textContent = `Orb settings were not saved: ${error instanceof Error ? error.message : 'unknown error'}. Check the Orb connection and retry.`;
    }
    finally {
        $('github-token').value = '';
        setSettingsBusy(false);
    }
}
async function testOrbSound() {
    if (settingsBusy || maintenanceBusy || !physicalSettingsLoaded) return;
    if (settingsDirty) {
        $('orb-audio-status').textContent = 'Save to Orb before testing so the buzzer uses your new settings.';
        return;
    }
    setSettingsBusy(true);
    $('orb-audio-status').textContent = 'Requesting a sound from the physical Orb…';
    try {
        await settingsResponse('/setup/audio/test', 'POST', {});
        $('orb-audio-status').textContent = 'Sound scheduled on the physical Orb. Listen for a brief buzzer notification.';
    } catch (error) {
        const code = error instanceof Error ? error.message : 'unknown_error';
        const messages: Record<string, string> = {
            sound_muted: 'Enable sound and set volume above zero, then Save to Orb.',
            quiet_hours_active: 'Quiet hours are active on the Orb. Change and save them before testing.',
            sound_assets_unavailable: 'Upload animations and sounds to the SD card, then restart the Orb.',
            audio_busy: 'The Orb is already playing a notification. Try again.',
            audio_test_unsupported: 'Update the Orb firmware to use the physical sound test.'
        };
        $('orb-audio-status').textContent = `Could not test Orb sound: ${messages[code] ?? code}`;
    } finally {
        setSettingsBusy(false);
    }
}
interface DemoStatus {
    running: boolean;
    finished: boolean;
    step: string | null;
    stepIndex: number;
    steps: string[];
    elapsedMs: number;
    durationMs: number;
    otherSessions: number;
    error: string | null;
}
let demoTimer: ReturnType<typeof setTimeout> | undefined;
const DEMO_ERRORS: Record<string, string> = {
    mona_simulation_unsupported: 'Update the Orb firmware first; it cannot show a demo Mona alert yet.',
    destination_is_dashboard: 'The saved Orb connection points at this dashboard. Connect the physical Orb first.',
    invalid_orb_config: 'No Orb connection is saved. Set up Wi-Fi and the extension first.',
    no_observer_destinations: 'No Orb connection is saved. Connect the Orb over USB, or install the extension for the Live Orb.',
    device_not_found: 'No Orb connection is saved and no Orb is connected over USB. Plug in the Orb with USB.',
    multiple_devices: 'More than one Orb is connected over USB. Leave only the one to film connected.',
    orb_not_connected: 'The USB Orb is not on Wi-Fi yet. Connect it to Wi-Fi first.',
    busy: 'The USB connection is busy with another task. Try again in a moment.',
    orb_unreachable: 'The Orb is unreachable. Check that it is powered on and on the same network.',
    orb_timeout: 'The Orb did not respond in time.',
    orb_unauthorized: 'The Orb rejected the saved token. Reinstall the extension for the Live Orb.',
    demo_running: 'A demo is already playing.'
};
function renderDemo(status: DemoStatus) {
    const steps = $('demo-steps');
    if (steps.children.length !== status.steps.length) {
        steps.replaceChildren(...status.steps.map((label) => {
            const item = document.createElement('li');
            item.textContent = label;
            return item;
        }));
    }
    [...steps.children].forEach((item, index) => {
        if (index === status.stepIndex && (status.running || status.finished)) item.setAttribute('aria-current', 'step');
        else item.removeAttribute('aria-current');
    });
    $('demo-start').disabled = status.running;
    $('demo-stop').disabled = !status.running && !status.finished;
    $('demo-progress').hidden = !status.running && !status.finished;
    $('demo-progress').value = status.durationMs ? Math.min(1, status.elapsedMs / status.durationMs) : 0;
    const others = status.otherSessions
        ? ` ${status.otherSessions} other Copilot session${status.otherSessions === 1 ? ' is' : 's are'} also on the Orb.` : '';
    $('demo-status').textContent = status.error
        ? `Demo stopped: ${DEMO_ERRORS[status.error] ?? status.error}`
        : status.running
            ? `${status.step ?? 'Starting'} · ${Math.floor(status.elapsedMs / 1000)}s / ${Math.round(status.durationMs / 1000)}s.${others}`
            : status.finished
                ? 'Demo complete. Mona\'s alert stays on screen; tap the Orb or press Stop demo to dismiss it.'
                : status.step ?? 'Ready. Mona\'s alert stays on screen at the end; tap the Orb to dismiss it.';
}
async function pollDemo() {
    clearTimeout(demoTimer);
    try {
        const status: DemoStatus = await settingsResponse('/setup/demo');
        renderDemo(status);
        if (status.running) demoTimer = setTimeout(() => void pollDemo(), 500);
    } catch (error) {
        $('demo-status').textContent = `Demo status unavailable: ${error instanceof Error ? error.message : 'unknown error'}`;
    }
}
async function startDemo() {
    $('demo-start').disabled = true;
    $('demo-status').textContent = 'Preparing the Orb for the demo…';
    try {
        renderDemo(await settingsResponse('/setup/demo', 'POST', {}));
        log('demo started on the physical Orb');
        void pollDemo();
    } catch (error) {
        const code = error instanceof Error ? error.message : 'unknown_error';
        $('demo-status').textContent = `Could not start the demo: ${DEMO_ERRORS[code] ?? code}`;
        $('demo-start').disabled = false;
    }
}
async function stopDemo() {
    $('demo-stop').disabled = true;
    try {
        renderDemo(await settingsResponse('/setup/demo', 'DELETE'));
        clearTimeout(demoTimer);
        $('demo-status').textContent = 'Demo stopped and cleared from the Orb.';
    } catch (error) {
        $('demo-status').textContent = `Could not stop the demo: ${error instanceof Error ? error.message : 'unknown error'}`;
        $('demo-stop').disabled = false;
    }
}
async function installCopilotExtension() {
    if (settingsBusy) return;
    const portId = $('usb-port').value;
    if (!portId) {
        $('orb-extension-status').textContent = 'Select the connected Orb in step 1 first.';
        return;
    }
    setSettingsBusy(true);
    $('orb-extension-status').textContent = 'Reading the connected Orb, saving its private config, and installing the Copilot extension…';
    try {
        const response = await api('/setup/install-observer', 'POST', { portId });
        const body = await response.json();
        if (!response.ok)
            throw new Error(body.error || `HTTP ${response.status}`);
        $('orb-extension-status').textContent = 'Live Orb added as an observer destination. Start a fresh Copilot session to use the updated configuration.';
        log(`Copilot extension installed for Orb at ${body.host}:${body.port}`);
        void refreshObserverConfiguration();
    }
    catch (error) {
        $('orb-extension-status').textContent = `Could not install Copilot extension: ${error instanceof Error ? error.message : 'unknown error'}`;
    }
    finally {
        setSettingsBusy(false);
    }
}
async function installDashboardExtension() {
    const button = $('dashboard-install-observer');
    button.disabled = true;
    $('dashboard-extension-status').textContent = 'Adding the local dashboard as an observer destination…';
    try {
        const response = await api('/setup/install-dashboard-observer', 'POST', {});
        const body = await response.json();
        if (!response.ok)
            throw new Error(body.error || `HTTP ${response.status}`);
        $('dashboard-extension-status').textContent =
            `Copilot events now go to this dashboard (${body.host}:${body.port}) and any other configured destinations. Start a fresh Copilot session.`;
        log(`Copilot observer endpoint added for local dashboard at ${body.host}:${body.port}`);
        void refreshObserverConfiguration();
    }
    catch (error) {
        $('dashboard-extension-status').textContent =
            `Could not install the Live Dashboard extension: ${error instanceof Error ? error.message : 'unknown error'}`;
    }
    finally {
        button.disabled = false;
    }
}
async function saveDashboardGitHubToken(token: string) {
    $('dashboard-github-save').disabled = true;
    $('dashboard-github-clear').disabled = true;
    $('dashboard-github-status').textContent = token
        ? 'Saving the private dashboard GitHub token…'
        : 'Removing the saved dashboard GitHub token…';
    try {
        const response = await api('/github/token', 'PUT', { token });
        const body = await response.json();
        if (!response.ok)
            throw new Error(body.error || `HTTP ${response.status}`);
        $('dashboard-github-token').value = '';
        $('dashboard-github-status').textContent = body.enabled
            ? `GitHub notifications enabled. Polling: ${body.status}.`
            : 'GitHub notifications disabled; the saved token was removed.';
        $('github-status').textContent = body.enabled
            ? `GitHub notifications: ${body.status} (saved on dashboard)`
            : 'GitHub notifications are disabled.';
        $('dashboard-github-clear').disabled = !body.enabled;
        log(body.enabled ? 'local dashboard GitHub token saved' : 'local dashboard GitHub token removed');
    }
    catch (error) {
        $('dashboard-github-status').textContent =
            `Could not update GitHub notification setup: ${error instanceof Error ? error.message : 'unknown error'}`;
        $('dashboard-github-save').disabled = false;
        $('dashboard-github-clear').disabled = false;
    }
}
let maintenanceBusy = false;
let assetTargetId: string | null = null;
function updateTransport() {
    const selected = document.querySelector<HTMLInputElement>('input[name="update-transport"]:checked');
    if (!selected || (selected.value !== 'wifi' && selected.value !== 'usb'))
        throw new Error('Select an update connection.');
    return selected.value;
}
function updateTransportHint() {
    $('update-transport-hint').textContent = updateTransport() === 'wifi'
        ? 'Uses the saved Orb Wi-Fi connection. No USB cable is needed.'
        : 'Uses the USB Orb selected in settings above. Wi-Fi is not required.';
}
$('update-transport').addEventListener('change', updateTransportHint);
async function updateRequest(path: string, body?: unknown) {
    const response = await fetch(`/setup/updates/${path}`, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: path === 'progress' ? AbortSignal.timeout(5000) : undefined
    });
    const result = await response.json();
    if (!response.ok) {
        const messages: Record<string, string> = {
            unsupported_firmware: 'This Orb needs an initial developer USB flash to support this update connection',
            invalid_orb_config: 'No saved Orb Wi-Fi connection. Connect and configure the Orb first',
            serial_unavailable: 'USB is unavailable on this dashboard host',
            device_not_found: 'Select a connected USB Orb in settings above',
            orb_unreachable: 'Could not reach the saved Orb over Wi-Fi',
            orb_unauthorized: 'The saved Orb credentials were rejected',
            update_target_expired: 'The captured update target expired. Upload the assets again before restarting'
        };
        throw new Error(messages[result.error] || result.error || `HTTP ${response.status}`);
    }
    return result;
}
async function captureUpdateTarget() {
    const transport = updateTransport();
    if (transport === 'usb' && !$('usb-port').value)
        throw new Error('Select a connected USB Orb in settings above');
    const result = await updateRequest('target', { transport, portId: $('usb-port').value });
    if (typeof result.targetId !== 'string' || !result.targetId) throw new Error('Invalid update target response');
    return result.targetId;
}
async function runUpdate<T>(kind: 'asset' | 'firmware', operation: () => Promise<T>): Promise<T> {
    if (maintenanceBusy || settingsBusy) throw new Error('Another device operation is in progress');
    maintenanceBusy = true;
    setSettingsBusy(true);
    const controls = [$('update-transport'), $('usb-port'), $('usb-refresh'), $('asset-upload-button'),
        $('asset-restart-button'), $('firmware-upload-button')];
    const previous = controls.map(control => control.disabled);
    for (const control of controls) control.disabled = true;
    const bar = kind === 'asset' ? $('asset-progress') : $('firmware-progress');
    const status = kind === 'asset' ? $('asset-status') : $('firmware-status');
    bar.hidden = false;
    bar.max = 100;
    bar.value = 0;
    let monitoring = true;
    let progressWarningLogged = false;
    const progressMonitor = (async () => {
        while (monitoring) {
            try {
                const body = await updateRequest('progress');
                const progress = body.progress;
                if (monitoring && progress) {
                    bar.value = progress.size ? Math.floor(progress.sent / progress.size * 100) : 0;
                    const sent = `${(progress.sent / 1024 / 1024).toFixed(2)} MiB`;
                    const total = `${(progress.size / 1024 / 1024).toFixed(2)} MiB`;
                    status.textContent = progress.phase === 'validating'
                        ? `Bytes sent. Waiting for the Orb to validate ${progress.name}…`
                        : progress.phase === 'connecting'
                            ? `Connecting to the Orb to upload ${progress.name}…`
                            : `Sending ${progress.name} to the Orb… ${sent} / ${total} (${bar.value}%).`;
                }
            }
            catch (error) {
                if (monitoring) {
                    const message = error instanceof Error ? error.message : 'unknown error';
                    status.textContent = `Upload continues; progress unavailable: ${message}.`;
                    if (!progressWarningLogged) {
                        log(`update progress unavailable: ${message}`);
                        progressWarningLogged = true;
                    }
                }
            }
            if (!monitoring)
                return;
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    })();
    try {
        return await operation();
    }
    finally {
        monitoring = false;
        await progressMonitor;
        bar.hidden = true;
        controls.forEach((control, index) => control.disabled = previous[index]);
        $('asset-restart-button').disabled = !assetTargetId;
        $('firmware-upload-button').disabled = !latestFirmwareReady;
        setSettingsBusy(false);
        maintenanceBusy = false;
        updateSetupControls();
    }
}
async function uploadAssets() {
    const assets = ['animations.orb', 'sounds.json'];
    const uploaded: string[] = [];
    try {
        await runUpdate('asset', async () => {
            $('asset-status').textContent = 'Connecting through the selected update connection…';
            const targetId = await captureUpdateTarget();
            for (const [index, name] of assets.entries()) {
                $('asset-status').textContent = `Uploading ${name} (${index + 1}/${assets.length}) from dist/sdcard… Keep the Orb connected.`;
                $('asset-progress').value = 0;
                log(`uploading ${name} (${index + 1}/${assets.length})`);
                const result = await updateRequest('assets', { targetId, name });
                if (result.uploaded !== name) throw new Error('Invalid asset upload response');
                uploaded.push(name);
                assetTargetId = targetId;
                log(`uploaded ${name} to the Orb SD card (${index + 1}/${assets.length})`);
            }
        });
        $('asset-status').textContent = 'Asset upload complete. Restart the Orb to load the new files.';
        log('asset upload complete; restart the Orb to load the new files');
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        $('asset-status').textContent = `Asset upload failed: ${message}.${uploaded.length ? ` Already updated: ${uploaded.join(', ')}. Restart loads those files; retry to finish the remaining upload.` : ' No files confirmed updated; an interrupted response may need a retry.'}`;
        log(`asset upload failed: ${message}`);
    }
}
async function restartAfterAssetUpload() {
    const targetId = assetTargetId;
    if (!targetId) return;
    try {
        await runUpdate('asset', async () => {
            $('asset-status').textContent = 'Restarting the Orb used for the asset upload…';
            const result = await updateRequest('restart', { targetId });
            if (result.restarting !== true) throw new Error('Invalid restart response');
            assetTargetId = null;
        });
        $('asset-status').textContent = 'Orb restarting. The new animation and sound assets will be loaded at startup.';
        log('Orb restart requested');
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        $('asset-status').textContent = `Restart failed: ${message}. The uploaded files remain on the SD card.`;
        log(`Orb restart failed: ${message}`);
    }
}
document.getElementById('asset-upload-button')?.addEventListener('click', uploadAssets);
document.getElementById('asset-restart-button')?.addEventListener('click', restartAfterAssetUpload);
const MAX_FIRMWARE_BYTES = 3 * 1024 * 1024;
let latestFirmwareReady = false;
async function refreshLatestFirmware() {
    const button = $('firmware-upload-button');
    button.disabled = true;
    latestFirmwareReady = false;
    try {
        const response = await fetch('/firmware/latest', { method: 'HEAD', cache: 'no-store' });
        if (response.status === 404)
            throw new Error('No firmware binary found in dist/firmware. Run npm run firmware:build.');
        if (response.status === 413)
            throw new Error('The latest firmware binary is larger than the 3 MiB OTA limit.');
        if (!response.ok)
            throw new Error(`Could not find the latest firmware (HTTP ${response.status}).`);
        const name = response.headers.get('X-Firmware-Name') || 'latest firmware';
        const size = Number(response.headers.get('Content-Length'));
        if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FIRMWARE_BYTES)
            throw new Error('The latest firmware binary has an invalid size.');
        latestFirmwareReady = true;
        button.disabled = maintenanceBusy;
        $('firmware-status').textContent = `${name} · ${(size / 1024 / 1024).toFixed(2)} MiB · ready to upload`;
    }
    catch (error) {
        $('firmware-status').textContent = error instanceof Error ? error.message : 'Could not find the latest firmware.';
    }
}
function finishFirmwareUpload(message, error = false) {
    $('firmware-progress').hidden = true;
    $('firmware-upload-button').disabled = !latestFirmwareReady;
    $('firmware-status').textContent = message;
    if (error)
        log(`firmware upload failed: ${message}`);
    else
        log(message);
}
async function uploadLatestFirmware() {
    if (!latestFirmwareReady) {
        void refreshLatestFirmware();
        return;
    }
    try {
        await runUpdate('firmware', async () => {
            $('firmware-status').textContent = `Sending the latest firmware through ${updateTransport() === 'wifi' ? 'Wi-Fi' : 'USB'}… Keep the Orb powered on.`;
            const targetId = await captureUpdateTarget();
            const result = await updateRequest('firmware', { targetId });
            if (result.ok !== true || result.restarting !== true) throw new Error('Invalid firmware update response');
        });
        finishFirmwareUpload('Firmware verified and uploaded. The Orb is restarting to apply the update.');
    } catch (error) {
        finishFirmwareUpload(`Firmware update failed: ${error instanceof Error ? error.message : 'unknown error'}. Update completion was not confirmed.`, true);
    }
}
document.getElementById('firmware-upload-button')?.addEventListener('click', uploadLatestFirmware);
void refreshLatestFirmware();
function connected() {
    if (mode === 'animations')
        return !previewOffline;
    return liveOnline && Date.now() - lastMessageAt < STALE_MS;
}
async function pollState() {
    if (mode === 'animations')
        return;
    clearTimeout(pollTimer);
    try {
        const res = await api('/state');
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const msg = await res.json();
        if (msg.type === 'state') {
            if (!liveOnline)
                log('connected');
            liveOnline = true;
            retryMs = 1000;
            lastMessageAt = Date.now();
            if (msg.mood !== live.mood || (msg.sessions?.length ?? 0) !== live.sessions.length) {
                log(`${msg.mood}${msg.tool ? ` (${msg.tool})` : ''} · ${msg.sessions?.length ?? 0} session(s)`);
            }
            await refreshDebugMessages();
            live = presentation(msg, face.emotions.presentations);
            if (msg.settings)
                applySettings(msg.settings, !physicalSettingsLoaded && !settingsDirty && !settingsBusy);
            const github = await api('/github/status');
            if (github.ok) {
                const status = await github.json();
                const issue = status.status === 'degraded' || status.status === 'error'
                    ? `${status.status}: ${status.error || 'GitHub polling needs attention'}`
                    : '';
                const sourceText = status.source === 'environment'
                    ? ' (server-configured)'
                    : status.source === 'saved' ? ' (saved on dashboard)' : '';
                $('github-status').textContent = status.configurationError
                    ? status.configurationError
                    : status.enabled
                        ? `GitHub notifications: ${status.status}${sourceText}${status.error ? ` — ${status.error}` : ''}`
                        : 'GitHub notifications are disabled.';
                $('dashboard-github-status').textContent = status.configurationError
                    ? status.configurationError
                    : status.source === 'environment'
                        ? `Using server-configured ORB_GITHUB_PAT. ${status.enabled ? `Polling: ${status.status}.` : 'The configured token is empty.'}`
                        : status.source === 'saved'
                            ? `A private dashboard token is saved. Polling: ${status.status}${status.error ? ` — ${status.error}` : ''}`
                            : 'No dashboard GitHub token is saved.';
                const environmentManaged = status.source === 'environment';
                $('dashboard-github-token').disabled = environmentManaged;
                $('dashboard-github-save').disabled = environmentManaged;
                $('dashboard-github-clear').disabled = environmentManaged || (!status.configurationError && status.source !== 'saved');
                if (issue && issue !== lastGitHubIssue)
                    log(`GitHub ${issue}`);
                if (!issue && lastGitHubIssue)
                    log('GitHub polling recovered');
                lastGitHubIssue = issue;
            }
            renderStatus(effectiveState());
        }
        pollTimer = setTimeout(pollState, 1500);
    }
    catch {
        if (liveOnline)
            log('disconnected');
        liveOnline = false;
        pollTimer = setTimeout(pollState, retryMs);
        retryMs = Math.min(10_000, retryMs * 2);
    }
}
function connect() {
    if (mode === 'animations')
        return;
    void pollState();
}
function applySettings(next, updateControls = true) {
    settings = next;
    previewEngine?.setSettings(next);
    if (!updateControls)
        return;
    $('sound').checked = next.sound;
    $('volume').value = next.volume;
    $('brightness').value = next.brightness;
    $('qh-enabled').checked = next.quietHours.enabled;
    $('qh-start').value = next.quietHours.start;
    $('qh-end').value = next.quietHours.end;
}
let settingsTimer;
async function syncPreviewSettings(next) {
    clearTimeout(settingsTimer);
    try {
        const response = await api('/settings', 'PUT', next);
        if (!response.ok)
            throw new Error(`HTTP ${response.status}`);
    }
    catch {
        log('dashboard preview settings not saved');
    }
}
function pushSettings() {
    settingsDirty = true;
    $('orb-settings-status').textContent = 'Unsaved changes. Save to Orb to apply them to the device.';
    const time24h = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!time24h.test($('qh-start').value) || !time24h.test($('qh-end').value))
        return;
    settings = {
        sound: $('sound').checked,
        volume: Number($('volume').value),
        brightness: Number($('brightness').value),
        quietHours: { enabled: $('qh-enabled').checked, start: $('qh-start').value, end: $('qh-end').value }
    };
    if (mode === 'animations') {
        previewEngine.setSettings(settings);
        return;
    }
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => void syncPreviewSettings(settings), 250);
}
function effectiveState() {
    if (mode === 'animations') {
        const state = previewEngine.state();
        if (previewOffline)
            return presentation({ ...state, mood: 'disconnected' }, face.emotions.presentations);
        return presentation(state, face.emotions.presentations);
    }
    return connected() ? live : presentation({ ...live, mood: 'disconnected' });
}
function maybePlaySound(state, now) {
    const isMona = state.mascot === 'mona';
    const sound = isMona
        ? face.emotions.alertSounds?.[state.alert?.kind]
        : ['done', 'needsInput'].includes(state.mood) ? face.emotions.moods[state.mood]?.sound : null;
    const quiet = inQuietHours(settings.quietHours);
    $('quiet-now').textContent = settings.quietHours.enabled ? (quiet ? 'Quiet hours active: muted' : 'Outside quiet hours') : '';
    const key = isMona ? `${state.alert?.kind ?? ''}:${state.alert?.id ?? ''}` : `${state.mascot}:${state.mood}`;
    const entered = lastSound.key !== key;
    const repeat = !isMona && sound?.repeatSec > 0 && now - lastSound.at > sound.repeatSec * 1000;
    if (!entered && !repeat)
        return;
    lastSound = { key, at: now };
    if (sound && settings.sound && !quiet)
        chime.play(sound, settings.volume);
}
function renderStatus(state) {
    const on = connected();
    $('status').textContent = mode === 'animations' ? (on ? 'preview' : 'offline') : on ? 'live' : 'offline';
    $('status').className = `pill ${on ? 'on' : 'off'}`;
    $('mood-now').textContent = mode === 'animations' && !state.sessions.length && !state.alert
        ? `${state.mood} (local)` : `${state.mascot}: ${state.mood}`;
    renderNews($('news'), state);
}
async function acknowledgeAlert(id) {
    if (acknowledgingAlert)
        return;
    if (mode === 'animations') {
        if (!previewEngine.acknowledgeAlert(id))
            log('Notification changed before it could be dismissed');
        renderStatus(effectiveState());
        return;
    }
    acknowledgingAlert = true;
    try {
        const response = await api('/github/acknowledge', 'POST', { id });
        if (!response.ok) {
            const body = await response.json();
            throw new Error(body.error || `HTTP ${response.status}`);
        }
        log('Notification dismissed locally');
        await pollState();
    }
    catch (error) {
        log(`Could not dismiss notification: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    finally {
        acknowledgingAlert = false;
    }
}
let frames = 0;
let fpsAt = 0;
function frame(now) {
    requestAnimationFrame(frame);
    const state = effectiveState();
    face.permissionsEnabled = mode === 'dashboard' && connected();
    face.setState(state, now);
    maybePlaySound(state, now);
    face.draw(ctx, now, settings.brightness);
    frames++;
    if (now - fpsAt > 1000) {
        $('fps').textContent = String(frames);
        frames = 0;
        fpsAt = now;
        renderStatus(face.state);
    }
}
function clearPreviewTimers() {
    for (const timer of previewTimers)
        clearTimeout(timer);
    previewTimers = [];
}
function runScenario(name) {
    clearPreviewTimers();
    previewEngine.reset();
    previewOffline = false;
    if (name === 'workingSecurity') {
        const sessionId = `dashboard-security-${Date.now()}`;
        previewEngine.handleEvent({ source: 'sim', sessionId, event: 'UserPromptSubmit',
            title: 'Fix login flow', project: 'orb-demo' });
        $('scenario-status').textContent = 'Copilot starts working; security news interrupts. Tap Mona for details, then tap the card to return to Copilot.';
        previewTimers.push(setTimeout(() => {
            previewEngine.setAlert({ id: `dashboard-security-${Date.now()}`, kind: 'criticalSecurity',
                title: 'Critical dependency vulnerability',
                url: 'https://github.com/octo-org/example/security/dependabot/42', repository: 'octo-org/example' });
            renderStatus(effectiveState());
        }, 1_200));
        previewTimers.push(setTimeout(() => previewEngine.handleEvent({
            source: 'sim', sessionId, event: 'PreToolUse', tool: 'npm test'
        }), 2_400));
        previewTimers.push(setTimeout(() => previewEngine.handleEvent({
            source: 'sim', sessionId, event: 'Stop'
        }), 5_000));
        renderStatus(effectiveState());
        log(`preview ${name}`);
        return;
    }
    if (name === 'resting') {
        $('scenario-status').textContent = 'Copilot is resting.';
        renderStatus(effectiveState());
        return;
    }
    if (name === 'offline') {
        previewOffline = true;
        $('scenario-status').textContent = 'No connection to the service.';
        log(`preview ${name}`);
        renderStatus(effectiveState());
        return;
    }
    const monaScenarios = {
        monaIdle: ['Mona is resting', 'https://github.com/octo-org/example'],
        monaThinking: ['Mona is thinking', 'https://github.com/octo-org/example'],
        monaTool: ['Mona is working', 'https://github.com/octo-org/example'],
        prAssigned: ['PR assigned to you', 'https://github.com/octo-org/example/pull/42'],
        monaDone: ['Mona completed task', 'https://github.com/octo-org/example/pull/42'],
        workflowFailure: ['Build failed on main', 'https://github.com/octo-org/example/actions/runs/42'],
        criticalSecurity: ['Critical dependency vulnerability', 'https://github.com/octo-org/example/security/dependabot/42'],
        monaScared: ['Mona is scared!', 'https://github.com/octo-org/example/security/dependabot/42'],
        monaOffline: ['Mona is offline', 'https://github.com/octo-org/example']
    };
    if (name in monaScenarios) {
        const [title, url] = monaScenarios[name];
        previewEngine.setAlert({
            id: `dashboard-${name}-${Date.now()}`,
            kind: name,
            title,
            url,
            repository: 'octo-org/example',
            owner: 'octo-org',
            organization: 'octo-org',
            repositoryName: 'example'
        });
        $('scenario-status').textContent = `Local Mona scenario: ${title}.`;
        log(`preview ${name}`);
        renderStatus(effectiveState());
        return;
    }
    if (name === 'approval' || name === 'sessions' || name === 'carousel') {
        runObserverScenario(name);
        log(`preview ${name}`);
        return;
    }
    const sessionId = `dashboard-${Date.now()}`;
    const title = { activity: 'Refactor login flow', done: 'Fix failing build', error: 'Deploy to staging' }[name];
    const send = (event, tool = null) => {
        previewEngine.handleEvent({ source: 'sim', sessionId, event, tool, title, project: 'orb-demo' });
        renderStatus(effectiveState());
    };
    if (name === 'done') {
        send('UserPromptSubmit');
        send('Stop');
        $('scenario-status').textContent = 'Copilot completed; Done holds briefly, then returns to idle.';
    }
    else if (name === 'error') {
        send('ErrorOccurred');
        $('scenario-status').textContent = 'Copilot error; Error holds briefly, then returns to idle.';
    }
    else {
        send('UserPromptSubmit');
        $('scenario-status').textContent = 'Copilot is thinking, then uses a tool and completes.';
        previewTimers.push(setTimeout(() => send('PreToolUse', 'npm test'), 1_200));
        previewTimers.push(setTimeout(() => send('PostToolUse', 'npm test'), 3_000));
        previewTimers.push(setTimeout(() => send('Stop'), 4_500));
    }
    log(`preview ${name}`);
}
// Preview SDK observer sessions for the carousel and read-only approval card.
function runObserverScenario(name) {
    const startedAt = Date.now();
    const observer = (sessionId, sessionName) => {
        const instanceId = crypto.randomUUID();
        let sequence = 0;
        return (state) => previewEngine.handleObserver({
            source: 'cli', event: 'observerState', observerVersion: 1, sessionId, instanceId, startedAt,
            sequence: ++sequence, project: 'orb-demo', sessionName, model: 'GPT-5.4', ...state
        });
    };
    const nonce = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const approval = observer(`dashboard-approval-${startedAt}`, 'Fix failing login test');
    const attention = { id: nonce(), kind: 'shell', reason: 'Run the unit tests to verify the login fix', preview: 'npm test -- --watch=false', pending: 1 };
    if (name === 'carousel') {
        const review = observer(`dashboard-review-${startedAt}`, 'Review API changes');
        const docs = observer(`dashboard-docs-${startedAt}`, 'Update README');
        for (const send of [approval, review, docs])
            send({ state: 'thinking', tool: null });
        previewTimers.push(setTimeout(() => review({ state: 'tool', tool: 'bash' }), 1200));
        previewTimers.push(setTimeout(() => docs({ state: 'done', tool: null }), 1800));
        previewTimers.push(setTimeout(() => approval({ state: 'needsInput', tool: null, attention }), 12_000));
        $('scenario-status').textContent = 'Activity rotates the single Copilot between sessions with four-second viewing times. An approval takes the front after twelve seconds. Tap a ring arc to focus a session.';
        renderStatus(effectiveState());
        return;
    }
    approval({ state: 'needsInput', tool: null, inputTokens: 18_240, outputTokens: 1_460, contextPercent: 37, busyForMs: 42_000, attention });
    if (name === 'sessions') {
        observer(`dashboard-review-${startedAt}`, 'Review API changes')({ state: 'thinking', tool: null, activity: 'analysing',
            agent: 'Code reviewer', subagent: 'explore', inputTokens: 6_400, outputTokens: 820, contextPercent: 12, busyForMs: 95_000 });
        const done = observer(`dashboard-docs-${startedAt}`, 'Update README');
        done({ state: 'thinking', tool: null, activity: 'thinking', inputTokens: 2_100, outputTokens: 300 });
        done({ state: 'tool', tool: 'edit', inputTokens: 2_100, outputTokens: 300 });
    }
    $('scenario-status').textContent = name === 'sessions'
        ? 'One Copilot follows the selected session. Tap an arc to switch; tap the avatar for details. Approval holds the front automatically.'
        : 'Tap the Orb to see why Copilot needs approval.';
    renderStatus(effectiveState());
}
function setupUi(emotions) {
    const tabs = [...$('mode-tabs').querySelectorAll<HTMLButtonElement>('[data-mode]')];
    const activateTab = (next) => {
        const logContainer = next === 'orb' ? $('orb-sidebar') : document.querySelector('.stage');
        if (next === 'orb') logContainer?.prepend($('activity-log'));
        else logContainer?.append($('activity-log'));
        document.querySelector('main')?.setAttribute('data-mode', next);
        for (const tab of tabs) {
            const active = tab.dataset.mode === next;
            tab.classList.toggle('active', active);
            tab.setAttribute('aria-selected', String(active));
            tab.tabIndex = active ? 0 : -1;
        }
        $('orb-panel').hidden = next !== 'orb';
        $('dashboard-panel').hidden = next !== 'dashboard';
        $('animations-panel').hidden = next !== 'animations';
    };
    const updateMode = (next) => {
        activateTab(next);
        if (mode === next)
            return;
        clearPreviewTimers();
        face.overlay = null;
        face.press = null;
        mode = next;
        previewOffline = false;
        if (mode === 'animations') {
            clearTimeout(pollTimer);
            pollTimer = undefined;
            previewEngine.reset();
        }
        else {
            connect();
        }
        renderStatus(effectiveState());
    };
    activateTab(mode);
    $('mode-tabs').onclick = (event) => {
        if (!(event.target instanceof Element))
            return;
        const button = event.target.closest<HTMLButtonElement>('[data-mode]');
        if (button?.dataset.mode === 'orb' || button?.dataset.mode === 'dashboard' || button?.dataset.mode === 'animations')
            updateMode(button.dataset.mode);
    };
    $('mode-tabs').onkeydown = (event) => {
        const current = event.target instanceof HTMLButtonElement ? tabs.indexOf(event.target) : -1;
        if (current < 0)
            return;
        let next = current;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
            next = (current + 1) % tabs.length;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
            next = (current + tabs.length - 1) % tabs.length;
        else if (event.key === 'Home')
            next = 0;
        else if (event.key === 'End')
            next = tabs.length - 1;
        else
            return;
        event.preventDefault();
        tabs[next].focus();
        updateMode(tabs[next].dataset.mode);
    };
    canvas.style.cursor = 'pointer';
    canvas.style.touchAction = 'none';
    const point = (event) => {
        const bounds = canvas.getBoundingClientRect();
        return [(event.clientX - bounds.left) * canvas.width / bounds.width, (event.clientY - bounds.top) * canvas.height / bounds.height];
    };
    canvas.onpointerdown = (event) => {
        canvas.setPointerCapture(event.pointerId);
        const [x, y] = point(event);
        face.pointerDown(performance.now(), x, y);
    };
    canvas.onpointerup = (event) => {
        const [x, y] = point(event);
        const action = face.pointerUp(performance.now(), x, y);
        if (typeof action === 'string') void acknowledgeAlert(action);
        else if (action && mode === 'dashboard' && connected()) {
            void submitPermissionDecision(action.target, action.action, true);
        }
    };
    canvas.onpointercancel = () => { face.press = null; };
    $('scenario-buttons').onclick = (event) => {
        if (!(event.target instanceof Element))
            return;
        const button = event.target.closest<HTMLButtonElement>('[data-scenario]');
        if (button?.dataset.scenario)
            runScenario(button.dataset.scenario);
    };
    for (const id of ['sound', 'volume', 'brightness', 'qh-enabled', 'qh-start', 'qh-end'] as const)
        $(id).oninput = pushSettings;
    $('audio-unlock').onclick = async () => {
        try {
            await chime.enable();
            $('audio-unlock').textContent = 'Browser audio enabled';
            $('audio-unlock').disabled = true;
        } catch (error) {
            log(`Browser audio could not be enabled: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
    };
    $('orb-audio-test').onclick = () => void testOrbSound();
    $('demo-start').onclick = () => void startDemo();
    $('demo-stop').onclick = () => void stopDemo();
    $('usb-refresh').onclick = () => void refreshUsbPorts();
    $('usb-port').onchange = () => {
        updateSetupControls();
        $('usb-status').textContent = $('usb-port').value
            ? 'USB device selected. Continue with Wi-Fi setup or connect Copilot below.'
            : 'Select a USB device to enable Wi-Fi setup and extension installation.';
    };
    $('wifi-form').onsubmit = (event) => {
        event.preventDefault();
        void connectOrbWifi();
    };
    $('observer-refresh').onclick = () => void refreshObserverConfiguration();
    $('orb-settings-form').onsubmit = (event) => {
        event.preventDefault();
        void savePhysicalSettings();
    };
    $('orb-settings-form').addEventListener('input', () => {
        settingsDirty = true;
        $('orb-settings-status').textContent = 'Unsaved changes. Save to Orb to apply them to the device.';
    });
    $('github-token-clear').onchange = () => {
        $('github-token').disabled = $('github-token-clear').checked;
    };
    $('orb-settings-load').onclick = () => void loadPhysicalSettings();
    $('usb-install-observer').onclick = () => void installCopilotExtension();
    $('dashboard-install-observer').onclick = () => void installDashboardExtension();
    $('dashboard-github-form').onsubmit = (event) => {
        event.preventDefault();
        void saveDashboardGitHubToken($('dashboard-github-token').value);
    };
    $('dashboard-github-clear').onclick = () => void saveDashboardGitHubToken('');
    void refreshUsbPorts();
}
const emotions = await loadEmotions();
const artwork = new Artwork();
const sequences = new Frames();
try {
    const failedClips = await sequences.load();
    if (failedClips)
        log(`${failedClips} frame sequence(s) unavailable; mascot fallback active`);
}
catch (error) {
    log(`3D frames unavailable: ${error.message}; image fallback active`);
}
const failedAssets = await artwork.load();
if (failedAssets)
    log(`${failedAssets} artwork file(s) unavailable; using available poses or drawn face`);
face = new Face(emotions, artwork, sequences);
previewEngine = new OrbEngine(emotions);
setupUi(emotions);
applySettings(settings);
void loadPhysicalSettings();
void refreshObserverConfiguration();
void pollDemo();
setInterval(() => { if (!document.hidden) void refreshObserverConfiguration(); }, 10_000);
connect();
requestAnimationFrame(frame);
//# sourceMappingURL=dashboard.js.map