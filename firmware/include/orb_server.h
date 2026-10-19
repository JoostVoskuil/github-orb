#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <WebServer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#include "device_config.h"
#include "github_poller.h"
#include "orb_engine.h"

class Renderer;

class OrbServer {
 public:
  void begin(DeviceConfigStore &configStore, OrbEngine &engine, GitHubPoller &githubPoller, Renderer &renderer);
  void loop();
  bool takeState(OrbState &state);
  bool acknowledgeAlert(const char *id);
  bool queuePermissionDecision(const OrbState::PermissionIntent &intent);
  bool permissionReview(const char *sessionId, const char *attentionId, OrbState::PermissionReviewDetails &out);

 private:
  bool authorized();
  void addCorsHeaders();
  void sendJson(int code, const JsonDocument &doc);
  void handleHealth();
  void handleEvent();
  void handlePermissionDecision();
  void handleGetState();
  void handleGetSettings();
  void handlePutSettings();
  void handleGitHubStatus();
  void handleAcknowledgeAlert();
  void handleSimulateAlert();
  void handleOtaPost();
  void handleOtaUpload();
  void handleUpdateUpload(bool firmware);
  void handleUpdatePost(bool firmware);
  void handleRestart();

  static void onGitHubAlert(const OrbState::Alert &alert, void *context);

  WebServer server_{7420};
  SemaphoreHandle_t engineMutex_ = nullptr;
  DeviceConfigStore *configStore_ = nullptr;
  OrbEngine *engine_ = nullptr;
  GitHubPoller *githubPoller_ = nullptr;
  bool started_ = false;
  bool otaSuccess_ = false;
  String otaError_;
  bool httpUpdateOwned_ = false;
};
