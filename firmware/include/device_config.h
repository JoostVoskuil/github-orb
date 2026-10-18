#pragma once

#include <Arduino.h>

#include "orb_state.h"

struct DeviceConfig {
  String wifiSsid;
  String wifiPassword;
  String hostname = "github-orb";
  uint16_t port = 7420;
  String token;
  String githubPat;
  uint16_t githubPollSec = 60;
  String timezone = "CET-1CEST,M3.5.0,M10.5.0/3";
  OrbSettings settings;
};

class DeviceConfigStore {
 public:
  bool begin(bool forcePortal = false);
  void clear();
  void save();
  const DeviceConfig &get() const { return config_; }
  DeviceConfig &mutableConfig() { return config_; }
  void applyTimezone() const;

 private:
  bool connect(const String &ssid, const String &password);
  void load();
  bool importFromSdCard();
  void ensureToken();
  DeviceConfig config_;
};
