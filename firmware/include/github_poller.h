#pragma once

#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>

#include "orb_state.h"

struct GitHubHealth {
  bool enabled = false;
  char status[16] = "disabled";
  uint32_t lastSuccessMs = 0;
  char error[96] = "";
};

class GitHubPoller {
 public:
  using AlertCallback = void (*)(const OrbState::Alert &alert, void *context);

  void begin(const char *token, uint16_t pollSec, AlertCallback callback, void *context);
  void configure(const char *token, uint16_t pollSec);
  GitHubHealth health() const;

 private:
  struct ThreadRecord {
    char id[24] = "";
    char updatedAt[32] = "";
  };

  struct AlertRecord {
    char id[96] = "";
  };

  static constexpr size_t kMaxThreads = 128;
  static constexpr size_t kMaxAlerts = 256;

  static void taskEntry(void *arg);
  void taskLoop();
  void pollOnce();
  bool loadStateFromSd();
  void saveStateToSd();
  bool captureBootTime();
  bool threadSeen(const char *id, const char *updatedAt) const;
  void recordThread(const char *id, const char *updatedAt);
  bool alertSeen(const char *id) const;
  void recordAlert(const char *id);
  void setHealth(bool enabled, const char *status, uint32_t lastSuccessMs, const char *error);

  mutable SemaphoreHandle_t mutex_ = nullptr;
  TaskHandle_t task_ = nullptr;
  AlertCallback callback_ = nullptr;
  void *context_ = nullptr;
  char token_[129] = "";
  uint16_t pollSec_ = 60;
  uint32_t nextDelayMs_ = 60000;
  char bootTime_[21] = "";
  char etag_[96] = "";
  bool stateLoaded_ = false;
  bool reconfigureRequested_ = false;
  GitHubHealth health_;
  ThreadRecord threads_[kMaxThreads];
  size_t threadCount_ = 0;
  size_t threadWriteIndex_ = 0;
  AlertRecord alerts_[kMaxAlerts];
  size_t alertCount_ = 0;
  size_t alertWriteIndex_ = 0;
};
