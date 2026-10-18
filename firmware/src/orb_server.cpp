#include "orb_server.h"

#include <ArduinoJson.h>
#include <ESPmDNS.h>
#include <Update.h>
#include <WiFi.h>
#include <math.h>
#include "device_update.h"
#include "renderer.h"

namespace {

bool constantTimeEquals(const char *a, const char *b) {
  if (!a || !b) return false;
  const size_t lenA = strlen(a);
  const size_t lenB = strlen(b);
  if (lenA == 0 || lenA != lenB) return false;
  uint8_t diff = 0;
  for (size_t i = 0; i < lenA; i++) {
    diff |= static_cast<uint8_t>(a[i] ^ b[i]);
  }
  return diff == 0;
}

const char *ringModeName(RingMode mode) {
  return mode == RingMode::Animated ? "animated" : "solid";
}

const char *ringAnimName(RingAnimation anim) {
  switch (anim) {
    case RingAnimation::Chase: return "chase";
    case RingAnimation::Solid: return "solid";
  }
  return "solid";
}

bool validTimeString(const char *value) {
  if (!value || strlen(value) != 5 || value[2] != ':' ||
      value[0] < '0' || value[0] > '2' || value[1] < '0' || value[1] > '9' ||
      value[3] < '0' || value[3] > '5' || value[4] < '0' || value[4] > '9') return false;
  return (value[0] - '0') * 10 + value[1] - '0' <= 23;
}
}  // namespace

void OrbServer::onGitHubAlert(const OrbState::Alert &alert, void *context) {
  auto *self = static_cast<OrbServer *>(context);
  if (!self || !self->engine_) return;
  if (self->engineMutex_) xSemaphoreTake(self->engineMutex_, portMAX_DELAY);
  self->engine_->handleGitHubAlert(alert, millis());
  if (self->engineMutex_) xSemaphoreGive(self->engineMutex_);
}

void OrbServer::begin(DeviceConfigStore &configStore, OrbEngine &engine, GitHubPoller &githubPoller, Renderer &renderer) {
  if (!engineMutex_) engineMutex_ = xSemaphoreCreateMutex();
  configStore_ = &configStore;
  engine_ = &engine;
  githubPoller_ = &githubPoller;

  const DeviceConfig &cfg = configStore.get();
  xSemaphoreTake(engineMutex_, portMAX_DELAY);
  engine_->setSettings(cfg.settings);
  engine_->setOnline(WiFi.status() == WL_CONNECTED);
  xSemaphoreGive(engineMutex_);

  if (MDNS.begin(cfg.hostname.c_str())) {
    MDNS.addService("http", "tcp", cfg.port);
    Serial.printf("mDNS: http://%s.local:%u\n", cfg.hostname.c_str(), cfg.port);
  }

  server_.stop();
  server_.begin(cfg.port);
  const char *headerKeys[] = {"Authorization", "X-Orb-Token", "Content-Type", "X-Orb-Size", "X-Orb-Asset"};
  server_.collectHeaders(headerKeys, 5);

  server_.on("/health", HTTP_GET, [this]() { handleHealth(); });
  server_.on("/event", HTTP_OPTIONS, [this]() { addCorsHeaders(); server_.send(204); });
  server_.on("/event", HTTP_POST, [this]() { handleEvent(); });
  server_.on("/state", HTTP_OPTIONS, [this]() { addCorsHeaders(); server_.send(204); });
  server_.on("/state", HTTP_GET, [this]() { handleGetState(); });
  server_.on("/settings", HTTP_OPTIONS, [this]() { addCorsHeaders(); server_.send(204); });
  server_.on("/settings", HTTP_GET, [this]() { handleGetSettings(); });
  server_.on("/settings", HTTP_PUT, [this]() { handlePutSettings(); });
  server_.on("/audio/test", HTTP_OPTIONS, [this]() { addCorsHeaders(); server_.send(204); });
  server_.on("/audio/test", HTTP_POST, [this, &renderer]() {
    if (!authorized()) return;
    JsonDocument doc;
    const char *error = renderer.testSound();
    if (error) {
      doc["error"] = error;
      sendJson(409, doc);
    } else {
      doc["scheduled"] = true;
      sendJson(202, doc);
    }
  });
  server_.on("/github/status", HTTP_OPTIONS, [this]() { addCorsHeaders(); server_.send(204); });
  server_.on("/github/status", HTTP_GET, [this]() { handleGitHubStatus(); });
  server_.on("/github/acknowledge", HTTP_OPTIONS, [this]() { addCorsHeaders(); server_.send(204); });
  server_.on("/github/acknowledge", HTTP_POST, [this]() { handleAcknowledgeAlert(); });
  server_.on("/github/simulate", HTTP_OPTIONS, [this]() { addCorsHeaders(); server_.send(204); });
  server_.on("/github/simulate", HTTP_POST, [this]() { handleSimulateAlert(); });
  server_.on("/ota", HTTP_OPTIONS, [this]() { addCorsHeaders(); server_.send(204); });
  server_.on("/ota", HTTP_POST, [this]() { handleOtaPost(); }, [this]() { handleOtaUpload(); });
  server_.on("/assets", HTTP_POST, [this]() { handleUpdatePost(false); }, [this]() { handleUpdateUpload(false); });
  server_.on("/restart", HTTP_POST, [this]() { handleRestart(); });
  server_.onNotFound([this]() {
    if (server_.method() == HTTP_OPTIONS) {
      addCorsHeaders();
      server_.send(204);
      return;
    }
    JsonDocument doc;
    doc["error"] = "not_found";
    sendJson(404, doc);
  });

  githubPoller_->begin(cfg.githubPat.c_str(), cfg.githubPollSec, &OrbServer::onGitHubAlert, this);
  started_ = true;
}

void OrbServer::loop() {
  if (!started_ || !engine_) return;
  server_.handleClient();
  const uint32_t now = millis();
  xSemaphoreTake(engineMutex_, portMAX_DELAY);
  engine_->setOnline(WiFi.status() == WL_CONNECTED);
  engine_->tick(now);
  xSemaphoreGive(engineMutex_);
}

bool OrbServer::takeState(OrbState &state) {
  if (!engine_) return false;
  xSemaphoreTake(engineMutex_, portMAX_DELAY);
  const bool taken = engine_->takeStateIfDirty(state, millis());
  xSemaphoreGive(engineMutex_);
  return taken;
}

bool OrbServer::acknowledgeAlert(const char *id) {
  if (!engine_) return false;
  xSemaphoreTake(engineMutex_, portMAX_DELAY);
  const bool acknowledged = engine_->acknowledgeAlert(id);
  xSemaphoreGive(engineMutex_);
  return acknowledged;
}

void OrbServer::handleAcknowledgeAlert() {
  if (!authorized()) return;
  JsonDocument doc;
  const String body = server_.arg("plain");
  if (body.length() > 256) {
    doc["error"] = "payload_too_large";
    sendJson(413, doc);
    return;
  }
  if (deserializeJson(doc, body) || !doc["id"].is<const char *>() ||
      !doc["id"].as<const char *>()[0] || doc["id"].as<JsonString>().size() > 47) {
    doc.clear();
    doc["error"] = "invalid_alert_id";
    sendJson(400, doc);
    return;
  }
  const bool acknowledged = acknowledgeAlert(doc["id"].as<const char *>());
  doc.clear();
  if (!acknowledged) doc["error"] = "alert_changed";
  else doc["acknowledged"] = true;
  sendJson(acknowledged ? 200 : 409, doc);
}

// Shows a Mona alert without GitHub, for demos; it is acknowledged like a polled alert.
void OrbServer::handleSimulateAlert() {
  if (!authorized()) return;
  JsonDocument doc;
  const String body = server_.arg("plain");
  if (body.length() > 1024) {
    doc["error"] = "payload_too_large";
    sendJson(413, doc);
    return;
  }
  if (deserializeJson(doc, body)) {
    doc.clear();
    doc["error"] = "invalid_json";
    sendJson(400, doc);
    return;
  }
  auto text = [](JsonVariantConst value, size_t max, bool required) {
    if (value.isUnbound() || value.isNull()) return !required;
    if (!value.is<const char *>()) return false;
    const size_t length = value.as<JsonString>().size();
    if (length != strlen(value.as<const char *>()) || length > max || (required && !length)) return false;
    for (const char *c = value.as<const char *>(); *c; c++) {
      if (static_cast<unsigned char>(*c) < 0x20 || *c == 0x7f) return false;
    }
    return true;
  };
  OrbState::Alert alert;
  if (!text(doc["kind"], sizeof(alert.kind) - 1, true) || !text(doc["title"], sizeof(alert.title) - 1, true) ||
      !text(doc["repository"], sizeof(alert.repository) - 1, true) || !text(doc["url"], sizeof(alert.url) - 1, false) ||
      (!doc["organization"].isUnbound() && !doc["organization"].is<bool>())) {
    doc.clear();
    doc["error"] = "invalid_alert";
    sendJson(400, doc);
    return;
  }
  snprintf(alert.id, sizeof(alert.id), "demo-%lu", static_cast<unsigned long>(millis()));
  strlcpy(alert.kind, doc["kind"].as<const char *>(), sizeof(alert.kind));
  strlcpy(alert.title, doc["title"].as<const char *>(), sizeof(alert.title));
  strlcpy(alert.repository, doc["repository"].as<const char *>(), sizeof(alert.repository));
  strlcpy(alert.url, doc["url"] | "", sizeof(alert.url));
  alert.ownerIsOrganization = doc["organization"] | false;
  xSemaphoreTake(engineMutex_, portMAX_DELAY);
  const bool shown = !strcmp(alert.kind, "agentSessionFinished") ? false : engine_->handleGitHubAlert(alert, millis());
  xSemaphoreGive(engineMutex_);
  doc.clear();
  if (!shown) {
    doc["error"] = "invalid_alert_kind";
    sendJson(400, doc);
    return;
  }
  doc["id"] = alert.id;
  sendJson(202, doc);
}

void OrbServer::addCorsHeaders() {
  server_.sendHeader("Access-Control-Allow-Origin", "*");
  server_.sendHeader("Access-Control-Allow-Headers", "Authorization, X-Orb-Token, Content-Type");
  server_.sendHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  server_.sendHeader("Cache-Control", "no-store");
}

void OrbServer::sendJson(int code, const JsonDocument &doc) {
  addCorsHeaders();
  String out;
  serializeJson(doc, out);
  server_.send(code, "application/json; charset=utf-8", out);
}

bool OrbServer::authorized() {
  if (!configStore_) return false;
  const String &expected = configStore_->get().token;
  String candidate;
  if (server_.hasHeader("Authorization")) {
    const String auth = server_.header("Authorization");
    if (auth.startsWith("Bearer ")) candidate = auth.substring(7);
  }
  if (candidate.isEmpty() && server_.hasHeader("X-Orb-Token")) {
    candidate = server_.header("X-Orb-Token");
  }
  if (candidate.isEmpty() && server_.hasArg("token")) {
    candidate = server_.arg("token");
  }
  if (constantTimeEquals(candidate.c_str(), expected.c_str())) return true;

  JsonDocument doc;
  doc["error"] = "unauthorized";
  sendJson(401, doc);
  return false;
}

void OrbServer::handleHealth() {
  JsonDocument doc;
  doc["status"] = "ok";
  doc["uptimeSec"] = millis() / 1000UL;
  doc["wifiConnected"] = WiFi.status() == WL_CONNECTED;
  doc["ip"] = WiFi.localIP().toString();
  if (configStore_) {
    doc["hostname"] = configStore_->get().hostname + ".local";
  }
  doc["rssi"] = WiFi.RSSI();
  doc["alertSimulation"] = true;
  sendJson(200, doc);
}

void OrbServer::handleEvent() {
  if (!authorized()) return;
  const String body = server_.arg("plain");
  if (body.length() > 4096) {
    JsonDocument err;
    err["error"] = "payload_too_large";
    sendJson(413, err);
    return;
  }
  JsonDocument doc;
  if (deserializeJson(doc, body)) {
    JsonDocument err;
    err["error"] = "invalid_json";
    sendJson(400, err);
    return;
  }

  const char *source = doc["source"] | "";
  const char *event = doc["event"] | "";
  const char *sessionId = doc["sessionId"] | "default";
  const char *state = doc["state"].as<const char *>();
  const char *tool = doc["tool"].as<const char *>();
  const char *activity = doc["activity"].as<const char *>();
  const char *sessionName = doc["sessionName"].as<const char *>();
  const char *agent = doc["agent"].as<const char *>();
  const char *model = doc["model"].as<const char *>();
  const char *title = doc["title"].as<const char *>();
  const char *project = doc["project"].as<const char *>();
  const char *chat = doc["chat"].as<const char *>();

  xSemaphoreTake(engineMutex_, portMAX_DELAY);
  if (!strncmp(event, "observer", 8)) {
    auto intactString = [](JsonVariantConst value) {
      return !value.is<const char *>() || value.as<JsonString>().size() == strlen(value.as<const char *>());
    };
    auto integer = [](JsonVariantConst value, double max) {
      if (!value.is<double>()) return false;
      const double number = value.as<double>();
      return number >= 1 && number <= max && floor(number) == number;
    };
    auto tokenCount = [](JsonVariantConst value) {
      if (!value.is<double>()) return false;
      const double number = value.as<double>();
      return number >= 0 && number <= 4294967295.0 && floor(number) == number;
    };
    const bool hasInputTokens = !doc["inputTokens"].isUnbound();
    const bool hasOutputTokens = !doc["outputTokens"].isUnbound();
    const bool hasTokens = hasInputTokens && hasOutputTokens;
    auto optionalString = [](JsonVariantConst value) { return value.isUnbound() || value.is<const char *>(); };
    auto optionalCount = [&tokenCount](JsonVariantConst value, double max) {
      return value.isUnbound() || (tokenCount(value) && value.as<double>() <= max);
    };
    OrbEngine::ObserverExtras extras;
    JsonVariantConst attention = doc["attention"];
    bool validAttention = attention.isUnbound();
    if (attention.is<JsonObjectConst>()) {
      JsonObjectConst object = attention.as<JsonObjectConst>();
      validAttention = object["id"].is<const char *>() && object["kind"].is<const char *>() &&
        optionalString(object["reason"]) && optionalString(object["preview"]) &&
        integer(object["pending"], 255) &&
        intactString(object["id"]) && intactString(object["kind"]) &&
        intactString(object["reason"]) && intactString(object["preview"]);
      for (JsonPairConst pair : object) {
        const char *key = pair.key().c_str();
        if (strcmp(key, "id") && strcmp(key, "kind") && strcmp(key, "reason") && strcmp(key, "preview") &&
            strcmp(key, "pending")) validAttention = false;
      }
      if (validAttention) {
        extras.hasAttention = true;
        extras.attentionId = object["id"];
        extras.attentionKind = object["kind"];
        extras.reason = object["reason"].as<const char *>();
        extras.preview = object["preview"].as<const char *>();
        extras.pending = object["pending"].as<uint32_t>();
      }
    }
    extras.subagent = doc["subagent"].as<const char *>();
    if (!doc["contextPercent"].isUnbound() && optionalCount(doc["contextPercent"], 100)) {
      extras.contextPercent = doc["contextPercent"].as<int>();
    }
    if (!doc["busyForMs"].isUnbound() && optionalCount(doc["busyForMs"], 4294967295.0)) {
      extras.hasBusy = true;
      extras.busyForMs = doc["busyForMs"].as<uint32_t>();
    }
    const bool valid = doc["source"].is<const char *>() && !strcmp(source, "cli") &&
      integer(doc["observerVersion"], 1) &&
      doc["sessionId"].is<const char *>() && doc["instanceId"].is<const char *>() &&
      integer(doc["startedAt"], 9007199254740991.0) && integer(doc["sequence"], 4294967295.0) &&
      (!strcmp(event, "observerState") ? doc["state"].is<const char *>() : true) &&
      (doc["tool"].isNull() || doc["tool"].is<const char *>()) &&
      (doc["activity"].isUnbound() || doc["activity"].isNull() || doc["activity"].is<const char *>()) &&
      (doc["sessionName"].isUnbound() || doc["sessionName"].isNull() || doc["sessionName"].is<const char *>()) &&
      optionalString(doc["agent"]) && optionalString(doc["model"]) && optionalString(doc["subagent"]) &&
      optionalCount(doc["contextPercent"], 100) && optionalCount(doc["busyForMs"], 4294967295.0) && validAttention &&
      (hasInputTokens == hasOutputTokens) &&
      (!hasTokens || (tokenCount(doc["inputTokens"]) && tokenCount(doc["outputTokens"]))) &&
      (doc["project"].isUnbound() || doc["project"].is<const char *>()) &&
      (!activity || (state && !strcmp(state, "thinking") &&
        (!strcmp(activity, "thinking") || !strcmp(activity, "evaluating") ||
         !strcmp(activity, "analysing")))) &&
      intactString(doc["source"]) && intactString(doc["event"]) && intactString(doc["sessionId"]) &&
      intactString(doc["instanceId"]) && intactString(doc["state"]) &&
      intactString(doc["tool"]) && intactString(doc["activity"]) &&
      intactString(doc["project"]) && intactString(doc["sessionName"]) &&
      intactString(doc["agent"]) && intactString(doc["model"]) && intactString(doc["subagent"]);
    const uint32_t now = millis();
    const char *error = valid ? engine_->handleObserver(sessionId, event, doc["instanceId"],
      static_cast<uint64_t>(doc["startedAt"].as<double>()), static_cast<uint32_t>(doc["sequence"].as<double>()),
      state, tool, activity, project, sessionName, now, agent, model,
      hasTokens ? doc["inputTokens"].as<uint32_t>() : 0,
      hasTokens ? doc["outputTokens"].as<uint32_t>() : 0, hasTokens, &extras) : "invalid_observer_event";
    xSemaphoreGive(engineMutex_);
    JsonDocument response;
    if (error) {
      response["error"] = error;
    } else {
      response["accepted"] = true;
    }
    sendJson(error ? !strcmp(error, "invalid_observer_event") ? 400 : 409 : 202, response);
    return;
  }
  const bool accepted = engine_->handleEvent(source, sessionId, event, tool, millis(), title, project, chat);
  xSemaphoreGive(engineMutex_);

  JsonDocument res;
  res["ok"] = true;
  res["accepted"] = accepted;
  sendJson(202, res);
}

void OrbServer::handleGetState() {
  if (!authorized()) return;
  const uint32_t now = millis();
  OrbState state;
  const char *source = nullptr;

  xSemaphoreTake(engineMutex_, portMAX_DELAY);
  engine_->tick(now);
  state = engine_->snapshot(now);
  source = engine_->activeSource(now);
  xSemaphoreGive(engineMutex_);

  JsonDocument doc;
  doc["type"] = "state";
  doc["mood"] = moodName(state.mood);
  doc["clip"] = stateClip(state);
  doc["task"] = state.task;
  if (state.agent[0]) doc["agent"] = state.agent;
  if (state.model[0]) doc["model"] = state.model;
  if (state.hasTokenUsage) {
    doc["inputTokens"] = state.inputTokens;
    doc["outputTokens"] = state.outputTokens;
  }
  JsonObject ring = doc["ring"].to<JsonObject>();
  ring["mode"] = ringModeName(state.ringMode);
  ring["anim"] = ringAnimName(state.ringAnimation);
  char colorHex[8];
  snprintf(colorHex, sizeof(colorHex), "#%06lx", static_cast<unsigned long>(state.ringColor & 0xffffff));
  ring["color"] = colorHex;
  ring["speed"] = state.ringSpeed;
  ring["width"] = state.ringWidth;

  if (state.tool[0]) doc["tool"] = state.tool;
  else doc["tool"] = nullptr;

  if (source) doc["source"] = source;
  else doc["source"] = nullptr;

  doc["mascot"] = state.mona ? "mona" : "copilot";
  doc["presentationId"] = state.presentationId;
  doc["copilotNotification"] = state.copilotNotification;

  if (state.mona && state.alert.kind[0]) {
    JsonObject alert = doc["alert"].to<JsonObject>();
    alert["id"] = state.alert.id;
    alert["kind"] = state.alert.kind;
    alert["title"] = state.alert.title;
    alert["url"] = state.alert.url;
    alert["repository"] = state.alert.repository;
    const char *separator = strchr(state.alert.repository, '/');
    char owner[48];
    char repositoryName[48];
    if (separator) {
      const size_t ownerLength = min<size_t>(separator - state.alert.repository, sizeof(owner) - 1);
      memcpy(owner, state.alert.repository, ownerLength);
      owner[ownerLength] = '\0';
      strlcpy(repositoryName, separator + 1, sizeof(repositoryName));
    } else {
      strlcpy(owner, state.alert.repository, sizeof(owner));
      repositoryName[0] = '\0';
    }
    alert["owner"] = owner;
    if (state.alert.ownerIsOrganization) alert["organization"] = owner;
    alert["repositoryName"] = repositoryName;
  }

  JsonArray sessions = doc["sessions"].to<JsonArray>();
  for (uint8_t i = 0; i < state.sessionInfoCount; i++) {
    const OrbState::SessionInfo &info = state.sessions[i];
    JsonObject item = sessions.add<JsonObject>();
    item["source"] = info.source;
    item["sessionId"] = info.sessionId;
    item["name"] = info.name;
    item["state"] = moodName(info.state);
    item["slot"] = i;
    if (info.tool[0]) item["tool"] = info.tool;
    if (info.state == Mood::Thinking) item["activity"] = activityLabel(info.activity);
    item["ended"] = info.ended;
    item["closed"] = info.closed;
    item["finished"] = info.finished;
    if (info.ended) item["endedAgoSec"] = (now - info.endedAtMs) / 1000UL;
    if (info.agent[0]) item["agent"] = info.agent;
    if (info.subagent[0]) item["subagent"] = info.subagent;
    if (info.model[0]) item["model"] = info.model;
    if (info.hasTokenUsage) {
      item["inputTokens"] = info.inputTokens;
      item["outputTokens"] = info.outputTokens;
    }
    if (info.contextPercent >= 0) item["contextPercent"] = info.contextPercent;
    if (info.busy) item["busySec"] = (now - info.busySinceMs) / 1000UL;
    if (info.attention.active) {
      JsonObject attention = item["attention"].to<JsonObject>();
      attention["id"] = info.attention.id;
      attention["kind"] = attentionKindName(info.attention.kind);
      if (info.attention.reason[0]) attention["reason"] = info.attention.reason;
      if (info.attention.preview[0]) attention["preview"] = info.attention.preview;
      attention["pending"] = info.attention.pending;
    }
  }
  doc["primary"] = state.primarySession;
  doc["hiddenSessions"] = state.hiddenSessions;
  doc["sessionCount"] = state.sessionCount;

  JsonObject settings = doc["settings"].to<JsonObject>();
  settings["sound"] = state.settings.sound;
  settings["volume"] = state.settings.volume;
  settings["brightness"] = state.settings.brightness;
  JsonObject qh = settings["quietHours"].to<JsonObject>();
  qh["enabled"] = state.settings.quietHoursEnabled;
  qh["start"] = state.settings.quietStart;
  qh["end"] = state.settings.quietEnd;
  doc["ts"] = state.serverTimestamp;
  sendJson(200, doc);
}

void OrbServer::handleGetSettings() {
  if (!authorized()) return;
  const DeviceConfig &cfg = configStore_->get();
  JsonDocument doc;
  doc["sound"] = cfg.settings.sound;
  doc["volume"] = cfg.settings.volume;
  doc["brightness"] = cfg.settings.brightness;
  JsonObject qh = doc["quietHours"].to<JsonObject>();
  qh["enabled"] = cfg.settings.quietHoursEnabled;
  qh["start"] = cfg.settings.quietStart;
  qh["end"] = cfg.settings.quietEnd;
  doc["timezone"] = cfg.timezone;
  doc["githubPollSec"] = cfg.githubPollSec;
  doc["githubConfigured"] = !cfg.githubPat.isEmpty();
  sendJson(200, doc);
}

void OrbServer::handlePutSettings() {
  if (!authorized()) return;
  const String body = server_.arg("plain");
  if (body.length() > 4096) {
    JsonDocument err;
    err["error"] = "payload_too_large";
    sendJson(413, err);
    return;
  }
  JsonDocument doc;
  if (deserializeJson(doc, body)) {
    JsonDocument err;
    err["error"] = "invalid_json";
    sendJson(400, err);
    return;
  }

  DeviceConfig &cfg = configStore_->mutableConfig();
  if (doc["sound"].is<bool>()) cfg.settings.sound = doc["sound"].as<bool>();
  if (doc["volume"].is<float>()) cfg.settings.volume = constrain(doc["volume"].as<float>(), 0.0f, 1.0f);
  if (doc["brightness"].is<float>()) cfg.settings.brightness = constrain(doc["brightness"].as<float>(), 0.05f, 1.0f);
  JsonObject qh = doc["quietHours"];
  if (!qh.isNull()) {
    if (qh["enabled"].is<bool>()) cfg.settings.quietHoursEnabled = qh["enabled"].as<bool>();
    const char *start = qh["start"] | nullptr;
    const char *end = qh["end"] | nullptr;
    if (validTimeString(start)) strlcpy(cfg.settings.quietStart, start, sizeof(cfg.settings.quietStart));
    if (validTimeString(end)) strlcpy(cfg.settings.quietEnd, end, sizeof(cfg.settings.quietEnd));
  }
  if (doc["timezone"].is<const char *>()) {
    const char *tz = doc["timezone"].as<const char *>();
    if (tz && tz[0]) {
      cfg.timezone = tz;
      configStore_->applyTimezone();
    }
  }
  bool ghUpdated = false;
  if (doc["githubPat"].is<const char *>()) {
    cfg.githubPat = doc["githubPat"].as<const char *>();
    ghUpdated = true;
  }
  if (doc["githubPollSec"].is<int>()) {
    cfg.githubPollSec = constrain(doc["githubPollSec"].as<int>(), 30, 3600);
    ghUpdated = true;
  }

  configStore_->save();
  xSemaphoreTake(engineMutex_, portMAX_DELAY);
  engine_->setSettings(cfg.settings);
  xSemaphoreGive(engineMutex_);
  if (ghUpdated && githubPoller_) {
    githubPoller_->configure(cfg.githubPat.c_str(), cfg.githubPollSec);
  }
  handleGetSettings();
}

void OrbServer::handleGitHubStatus() {
  if (!authorized()) return;
  const GitHubHealth health = githubPoller_ ? githubPoller_->health() : GitHubHealth{};
  JsonDocument doc;
  doc["enabled"] = health.enabled;
  doc["status"] = health.status;
  if (health.lastSuccessMs) doc["lastSuccessMs"] = health.lastSuccessMs;
  else doc["lastSuccessMs"] = nullptr;
  if (health.error[0]) doc["error"] = health.error;
  else doc["error"] = nullptr;
  sendJson(200, doc);
}

void OrbServer::handleOtaUpload() {
  handleUpdateUpload(true);
}

void OrbServer::handleUpdateUpload(bool firmware) {
  const bool raw = server_.hasRaw();
  const int status = raw ? static_cast<int>(server_.raw().status) : static_cast<int>(server_.upload().status);
  const bool start = raw ? status == RAW_START : status == UPLOAD_FILE_START;
  const bool writing = raw ? status == RAW_WRITE : status == UPLOAD_FILE_WRITE;
  const bool end = raw ? status == RAW_END : status == UPLOAD_FILE_END;
  const bool aborted = raw ? status == RAW_ABORTED : status == UPLOAD_FILE_ABORTED;
  if (start) {
    otaSuccess_ = false;
    otaError_ = "";
    httpUpdateOwned_ = false;
    if (!authorized()) {
      otaError_ = "unauthorized";
      return;
    }
    const String name = firmware ? "firmware.bin" : server_.header("X-Orb-Asset");
    if (raw && server_.header("Content-Type") != "application/octet-stream") {
      otaError_ = "invalid_content_type";
      return;
    }
    if (!firmware && name != "animations.orb" && name != "sounds.json") {
      otaError_ = "invalid_asset";
      return;
    }
    const String declared = server_.header("X-Orb-Size");
    const size_t size = raw ? static_cast<size_t>(server_.clientContentLength()) : declared.toInt();
    const char *error = deviceUpdate.begin(UpdateOwner::Http, name.c_str(), size, firmware && !raw && declared.isEmpty());
    if (error) otaError_ = error;
    else httpUpdateOwned_ = true;
  } else if (writing) {
    if (!otaError_.isEmpty()) return;
    const char *error = raw
      ? deviceUpdate.write(UpdateOwner::Http, server_.raw().buf, server_.raw().currentSize)
      : deviceUpdate.write(UpdateOwner::Http, server_.upload().buf, server_.upload().currentSize);
    if (error) {
      otaError_ = error;
      httpUpdateOwned_ = false;
    }
  } else if (end) {
    if (!otaError_.isEmpty()) return;
    const char *error = deviceUpdate.commit(UpdateOwner::Http);
    httpUpdateOwned_ = false;
    if (error) otaError_ = error;
    else otaSuccess_ = true;
  } else if (aborted) {
    if (httpUpdateOwned_) deviceUpdate.abort(UpdateOwner::Http);
    httpUpdateOwned_ = false;
    if (otaError_.isEmpty()) otaError_ = "upload_aborted";
  }
}

void OrbServer::handleOtaPost() {
  handleUpdatePost(true);
}

void OrbServer::handleUpdatePost(bool firmware) {
  if (otaError_ == "unauthorized") return;
  if (!authorized()) return;
  if (!otaSuccess_) {
    JsonDocument err;
    err["error"] = otaError_.isEmpty() ? "update_failed" : otaError_.c_str();
    sendJson(otaError_ == "busy" || otaError_ == "sd_unavailable" ? 409 : 400, err);
    return;
  }
  JsonDocument ok;
  ok["ok"] = true;
  ok["restarting"] = firmware;
  if (!firmware) ok["uploaded"] = server_.header("X-Orb-Asset");
  sendJson(200, ok);
  otaSuccess_ = false;
  otaError_ = "";
  if (!firmware) return;
  delay(250);
  ESP.restart();
}

void OrbServer::handleRestart() {
  if (!authorized()) return;
  JsonDocument doc;
  if (deviceUpdate.busy()) {
    doc["error"] = "busy";
    sendJson(409, doc);
    return;
  }
  doc["restarting"] = true;
  sendJson(200, doc);
  delay(250);
  ESP.restart();
}
