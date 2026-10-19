#include <Arduino.h>
#include <WiFi.h>
#include <freertos/semphr.h>

#include "board.h"
#include "device_config.h"
#include "github_poller.h"
#include "orb_engine.h"
#include "orb_server.h"
#include "orb_state.h"
#include "ota_updater.h"
#include "renderer.h"
#include "serial_control.h"

namespace {
DeviceConfigStore configStore;
OrbEngine engine;
GitHubPoller githubPoller;
OrbServer server;
Renderer renderer;
SerialControl serialControl;
OrbState state;

bool provisionWhileRendering(bool forcePortal) {
  struct Provisioning {
    SemaphoreHandle_t finished;
    bool forcePortal;
    bool configured;
  } provisioning = {xSemaphoreCreateBinary(), forcePortal, false};
  if (!provisioning.finished) return false;
  // WiFiManager blocks during connection and its portal. Keep SD/display
  // access on this task while the worker handles network setup only.
  const BaseType_t started = xTaskCreate([](void *argument) {
    auto *context = static_cast<Provisioning *>(argument);
    context->configured = configStore.begin(context->forcePortal);
    xSemaphoreGive(context->finished);
    vTaskDelete(nullptr);
  }, "orb-provision", 12288, &provisioning, 1, nullptr);
  if (started != pdPASS) {
    vSemaphoreDelete(provisioning.finished);
    return false;
  }
  while (xSemaphoreTake(provisioning.finished, 0) != pdTRUE) {
    serialControl.loop(false);
    renderer.loop();
    delay(1);
  }
  vSemaphoreDelete(provisioning.finished);
  return provisioning.configured;
}

bool provisioningResetRequested() {
  if (!Board::touched()) return false;
  const uint32_t started = millis();
  while (Board::touched()) {
    renderer.loop();
    if (millis() - started >= 2500) return true;
    delay(25);
  }
  return false;
}
}

void setup() {
  // Acknowledged USB update chunks are 4096 bytes; the default CDC RX queue is only 256.
  Serial.setRxBufferSize(8192);
  Serial.setTxBufferSize(2048);
  Serial.begin(115200);
  serialControl.begin(configStore);
  delay(200);
  Serial.println("\nGitHub Orb starting");

  if (!psramFound()) Serial.println("ERROR: PSRAM was not detected");
  if (!Board::begin()) {
    Serial.println("ERROR: Waveshare display board initialization failed");
    while (true) delay(1000);
  }

  const bool assetsReady = renderer.begin();
  Serial.printf("Animation assets: %s\n", assetsReady ? "ready" : "missing or invalid");
  OtaUpdater::applySdUpdateIfPresent();
  Serial.println("Startup: SD update check complete");
  renderer.setState(state);
  renderer.loop();
  Serial.println("Startup: initial frame ready");

  const bool forcePortal = provisioningResetRequested();
  Serial.println("Startup: starting network provisioning");
  if (forcePortal) {
    Serial.println("Touch held at boot; clearing saved provisioning");
    configStore.clear();
  }
  if (!provisionWhileRendering(forcePortal)) {
    Serial.println("Provisioning failed or token is empty; restarting");
    delay(2000);
    ESP.restart();
  }

  Serial.printf("Wi-Fi: %s (%s)\n", WiFi.SSID().c_str(), WiFi.localIP().toString().c_str());
  Serial.printf("Orb HTTP server: http://%s.local:%u (IP http://%s:%u)\n",
                configStore.get().hostname.c_str(),
                configStore.get().port,
                WiFi.localIP().toString().c_str(),
                configStore.get().port);
  server.begin(configStore, engine, githubPoller, renderer);
  Serial.println("Startup: HTTP server ready");
  if (server.takeState(state)) renderer.setState(state);
}

void loop() {
  serialControl.loop(true);
  server.loop();
  if (server.takeState(state)) renderer.setState(state);
  // Touch is polled at 40 Hz to spare the I2C bus; the renderer derives taps.
  static uint32_t lastPollMs = 0;
  const uint32_t now = millis();
  if (now - lastPollMs >= 25) {
    lastPollMs = now;
    uint16_t x = 0, y = 0;
    const bool down = Board::touchPoint(x, y);
    renderer.touch(down, x, y, now);
    OrbState::PermissionIntent intent;
    if (renderer.takePermissionDecision(intent)) {
      server.queuePermissionDecision(intent);
      if (server.takeState(state)) renderer.setState(state);
    }
    char alertId[48];
    if (renderer.takeAlertAcknowledgement(alertId, sizeof(alertId)) && server.acknowledgeAlert(alertId) &&
        server.takeState(state)) renderer.setState(state);
  }
  renderer.loop();
  delay(1);
}
