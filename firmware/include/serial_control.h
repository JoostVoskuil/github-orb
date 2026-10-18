#pragma once

#include <Arduino.h>
#include <FS.h>

class DeviceConfigStore;

struct UsbWifiRequest {
  String operationId;
  String ssid;
  String password;
};

class UsbProvisioningStore {
 public:
  static bool stage(const UsbWifiRequest &request);
  static bool pending(UsbWifiRequest &request);
  static void complete(const String &operationId, bool success, const char *error = nullptr);
  static bool result(String &operationId, bool &success, String &error);
  static void clear();
};

class SerialControl {
 public:
  void begin(DeviceConfigStore &configStore);
  void loop(bool configured);

 private:
  void handleLine(const char *line, bool configured);
  void reply(const String &id, bool ok, const char *error, bool configured, bool includeToken = false);
  void receiveAssetBytes();
  void abortAssetUpload();
  const char *commitAssetUpload(const char *assetName);

  DeviceConfigStore *configStore_ = nullptr;
  const char *uploadError_ = nullptr;
  char input_[1025] = {};
  size_t inputLength_ = 0;
  uint32_t assetExpected_ = 0;
  uint32_t assetReceived_ = 0;
  uint32_t assetLastByteAt_ = 0;
  uint32_t chunkRemaining_ = 0;
  bool chunked_ = false;
  char assetName_[16] = {};
  bool receivingAsset_ = false;
  bool assetReady_ = false;
  bool discarding_ = false;
  uint32_t restartAt_ = 0;
};