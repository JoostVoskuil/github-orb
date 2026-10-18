#include "device_config.h"

#include <ArduinoJson.h>
#include <Preferences.h>
#include <SD_MMC.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <esp_system.h>

#include "board.h"
#include "serial_control.h"

namespace {
constexpr char kNamespace[] = "github-orb";
constexpr char kLegacyNamespace[] = "copilot-orb";
constexpr char kSdConfigPath[] = "/config.json";

bool validTimeString(const char *value) {
  if (!value || strlen(value) != 5 || value[2] != ':' ||
      value[0] < '0' || value[0] > '2' || value[1] < '0' || value[1] > '9' ||
      value[3] < '0' || value[3] > '5' || value[4] < '0' || value[4] > '9') return false;
  return (value[0] - '0') * 10 + value[1] - '0' <= 23;
}
}  // namespace

void DeviceConfigStore::ensureToken() {
  if (!config_.token.isEmpty()) return;
  char generated[33] = {};
  for (int i = 0; i < 4; i++) {
    snprintf(generated + i * 8, 9, "%08lx", static_cast<unsigned long>(esp_random()));
  }
  config_.token = generated;
}

void DeviceConfigStore::load() {
  Preferences prefs;
  prefs.begin(kNamespace, true);
  const bool hasCurrentConfig = prefs.isKey("ssid") || prefs.isKey("wifiPass") ||
      prefs.isKey("hostname") || prefs.isKey("port") || prefs.isKey("token") ||
      prefs.isKey("ghPat") || prefs.isKey("ghPoll") || prefs.isKey("tz") ||
      prefs.isKey("sound") || prefs.isKey("volume") || prefs.isKey("bright") ||
      prefs.isKey("qhOn") || prefs.isKey("qhStart") || prefs.isKey("qhEnd");
  prefs.end();
  prefs.begin(hasCurrentConfig ? kNamespace : kLegacyNamespace, true);
  config_.wifiSsid = prefs.getString("ssid", config_.wifiSsid);
  config_.wifiPassword = prefs.getString("wifiPass", config_.wifiPassword);
  config_.hostname = prefs.getString("hostname", config_.hostname);
  config_.port = prefs.getUShort("port", config_.port);
  config_.token = prefs.getString("token", config_.token);
  config_.githubPat = prefs.getString("ghPat", config_.githubPat);
  config_.githubPollSec = prefs.getUShort("ghPoll", config_.githubPollSec);
  config_.timezone = prefs.getString("tz", config_.timezone);
  config_.settings.sound = prefs.getBool("sound", config_.settings.sound);
  config_.settings.volume = prefs.getFloat("volume", config_.settings.volume);
  config_.settings.brightness = prefs.getFloat("bright", config_.settings.brightness);
  config_.settings.quietHoursEnabled = prefs.getBool("qhOn", config_.settings.quietHoursEnabled);
  const String qhStart = prefs.getString("qhStart", config_.settings.quietStart);
  const String qhEnd = prefs.getString("qhEnd", config_.settings.quietEnd);
  if (validTimeString(qhStart.c_str())) strlcpy(config_.settings.quietStart, qhStart.c_str(), sizeof(config_.settings.quietStart));
  if (validTimeString(qhEnd.c_str())) strlcpy(config_.settings.quietEnd, qhEnd.c_str(), sizeof(config_.settings.quietEnd));
  prefs.end();
  if (config_.hostname == "copilot-orb") config_.hostname = "github-orb";
  if (config_.port == 0) config_.port = 7420;
  config_.githubPollSec = constrain(config_.githubPollSec, 30, 3600);
  config_.settings.volume = constrain(config_.settings.volume, 0.0f, 1.0f);
  config_.settings.brightness = constrain(config_.settings.brightness, 0.05f, 1.0f);
}

void DeviceConfigStore::save() {
  Preferences prefs;
  prefs.begin(kNamespace, false);
  prefs.putString("ssid", config_.wifiSsid);
  prefs.putString("wifiPass", config_.wifiPassword);
  prefs.putString("hostname", config_.hostname);
  prefs.putUShort("port", config_.port);
  prefs.putString("token", config_.token);
  prefs.putString("ghPat", config_.githubPat);
  prefs.putUShort("ghPoll", config_.githubPollSec);
  prefs.putString("tz", config_.timezone);
  prefs.putBool("sound", config_.settings.sound);
  prefs.putFloat("volume", config_.settings.volume);
  prefs.putFloat("bright", config_.settings.brightness);
  prefs.putBool("qhOn", config_.settings.quietHoursEnabled);
  prefs.putString("qhStart", config_.settings.quietStart);
  prefs.putString("qhEnd", config_.settings.quietEnd);
  prefs.end();
}

void DeviceConfigStore::clear() {
  Preferences prefs;
  prefs.begin(kNamespace, false);
  prefs.clear();
  prefs.end();
  prefs.begin(kLegacyNamespace, false);
  prefs.clear();
  prefs.end();
  config_ = DeviceConfig{};
  UsbProvisioningStore::clear();
  WiFiManager().resetSettings();
}

bool DeviceConfigStore::importFromSdCard() {
  if (!Board::sdMounted()) return false;
  Board::SdLock lock;
  if (!SD_MMC.exists(kSdConfigPath)) return false;
  File file = SD_MMC.open(kSdConfigPath, FILE_READ);
  if (!file || file.size() == 0 || file.size() > 8192) {
    if (file) file.close();
    return false;
  }
  JsonDocument doc;
  const DeserializationError err = deserializeJson(doc, file);
  file.close();
  if (err) return false;

  bool changed = false;
  const char *ssid = doc["wifiSsid"] | doc["ssid"] | nullptr;
  if (ssid && ssid[0] && config_.wifiSsid != ssid) {
    config_.wifiSsid = ssid;
    changed = true;
  }
  const char *wifiPass = doc["wifiPassword"] | doc["password"] | nullptr;
  if (wifiPass && config_.wifiPassword != wifiPass) {
    config_.wifiPassword = wifiPass;
    changed = true;
  }
  const char *hostname = doc["hostname"] | nullptr;
  if (hostname && hostname[0] && config_.hostname != hostname) {
    config_.hostname = strcmp(hostname, "copilot-orb") == 0 ? "github-orb" : hostname;
    changed = true;
  }
  if (doc["port"].is<uint16_t>()) {
    const uint16_t port = constrain(doc["port"].as<int>(), 1, 65535);
    if (config_.port != port) {
      config_.port = port;
      changed = true;
    }
  }
  const char *token = doc["token"] | nullptr;
  if (token && token[0] && config_.token != token) {
    config_.token = token;
    changed = true;
  }
  const char *pat = doc["githubPat"] | doc["githubToken"] | nullptr;
  if (pat && config_.githubPat != pat) {
    config_.githubPat = pat;
    changed = true;
  }
  if (doc["githubPollSec"].is<int>()) {
    const uint16_t poll = constrain(doc["githubPollSec"].as<int>(), 30, 3600);
    if (config_.githubPollSec != poll) {
      config_.githubPollSec = poll;
      changed = true;
    }
  }
  const char *tz = doc["timezone"] | nullptr;
  if (tz && tz[0] && config_.timezone != tz) {
    config_.timezone = tz;
    changed = true;
  }
  JsonObject settings = doc["settings"];
  if (!settings.isNull()) {
    if (settings["sound"].is<bool>()) {
      config_.settings.sound = settings["sound"].as<bool>();
      changed = true;
    }
    if (settings["volume"].is<float>()) {
      config_.settings.volume = constrain(settings["volume"].as<float>(), 0.0f, 1.0f);
      changed = true;
    }
    if (settings["brightness"].is<float>()) {
      config_.settings.brightness = constrain(settings["brightness"].as<float>(), 0.05f, 1.0f);
      changed = true;
    }
    JsonObject qh = settings["quietHours"];
    if (!qh.isNull()) {
      if (qh["enabled"].is<bool>()) config_.settings.quietHoursEnabled = qh["enabled"].as<bool>();
      const char *start = qh["start"] | nullptr;
      const char *end = qh["end"] | nullptr;
      if (validTimeString(start)) strlcpy(config_.settings.quietStart, start, sizeof(config_.settings.quietStart));
      if (validTimeString(end)) strlcpy(config_.settings.quietEnd, end, sizeof(config_.settings.quietEnd));
      changed = true;
    }
  }
  if (changed) save();
  return changed;
}

void DeviceConfigStore::applyTimezone() const {
  setenv("TZ", config_.timezone.c_str(), 1);
  tzset();
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
}

bool DeviceConfigStore::connect(const String &ssid, const String &password) {
  if (ssid.isEmpty()) return false;
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(config_.hostname.c_str());
  WiFi.begin(ssid.c_str(), password.c_str());
  const uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 20000) delay(100);
  return WiFi.status() == WL_CONNECTED;
}

bool DeviceConfigStore::begin(bool forcePortal) {
  load();
  importFromSdCard();
  ensureToken();
  save();

  UsbWifiRequest pending;
  const bool hasPending = !forcePortal && UsbProvisioningStore::pending(pending);
  const String previousSsid = config_.wifiSsid;
  const String previousPassword = config_.wifiPassword;
  if (hasPending) {
    config_.wifiSsid = pending.ssid;
    config_.wifiPassword = pending.password;
  }

  if (!forcePortal && connect(config_.wifiSsid, config_.wifiPassword)) {
    if (hasPending) UsbProvisioningStore::complete(pending.operationId, true);
    save();
    applyTimezone();
    return !config_.token.isEmpty();
  }

  if (hasPending) {
    config_.wifiSsid = previousSsid;
    config_.wifiPassword = previousPassword;
    UsbProvisioningStore::complete(pending.operationId, false, "wifi_failed");
    if (connect(config_.wifiSsid, config_.wifiPassword)) {
      save();
      applyTimezone();
      return !config_.token.isEmpty();
    }
  }

  char hostname[33];
  char port[6];
  char token[65];
  char githubPat[129];
  char githubPoll[6];
  char timezone[65];
  strlcpy(hostname, config_.hostname.c_str(), sizeof(hostname));
  snprintf(port, sizeof(port), "%u", config_.port);
  strlcpy(token, config_.token.c_str(), sizeof(token));
  strlcpy(githubPat, config_.githubPat.c_str(), sizeof(githubPat));
  snprintf(githubPoll, sizeof(githubPoll), "%u", config_.githubPollSec);
  strlcpy(timezone, config_.timezone.c_str(), sizeof(timezone));

  WiFiManager manager;
  WiFiManagerParameter hostnameField("hostname", "mDNS hostname (without .local)", hostname, sizeof(hostname));
  WiFiManagerParameter portField("port", "HTTP API port", port, sizeof(port));
  WiFiManagerParameter tokenField("token", "API bearer token", token, sizeof(token));
  WiFiManagerParameter patField("ghPat", "GitHub PAT (optional, notifications)", githubPat, sizeof(githubPat));
  WiFiManagerParameter pollField("ghPoll", "GitHub poll interval sec (min 30)", githubPoll, sizeof(githubPoll));
  WiFiManagerParameter timezoneField("tz", "POSIX timezone", timezone, sizeof(timezone));
  manager.addParameter(&hostnameField);
  manager.addParameter(&portField);
  manager.addParameter(&tokenField);
  manager.addParameter(&patField);
  manager.addParameter(&pollField);
  manager.addParameter(&timezoneField);
  manager.setConnectTimeout(20);
  manager.setConfigPortalTimeout(300);

  const bool configured = forcePortal
    ? manager.startConfigPortal("GitHub-Orb-Setup")
    : manager.autoConnect("GitHub-Orb-Setup");
  if (!configured) return false;

  config_.wifiSsid = WiFi.SSID();
  config_.wifiPassword = WiFi.psk();
  config_.hostname = hostnameField.getValue();
  config_.port = constrain(atoi(portField.getValue()), 1, 65535);
  config_.token = tokenField.getValue();
  config_.githubPat = patField.getValue();
  config_.githubPollSec = constrain(atoi(pollField.getValue()), 30, 3600);
  config_.timezone = timezoneField.getValue();
  if (config_.hostname.isEmpty()) config_.hostname = "github-orb";
  if (config_.timezone.isEmpty()) config_.timezone = "UTC0";
  ensureToken();
  save();
  applyTimezone();
  return !config_.token.isEmpty();
}