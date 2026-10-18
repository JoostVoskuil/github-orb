#include "serial_control.h"

#include <ArduinoJson.h>
#include <Preferences.h>
#include <SD_MMC.h>
#include <WiFi.h>

#include "board.h"
#include "device_config.h"
#include "device_update.h"

namespace {
constexpr char kNamespace[] = "orb-usb";
constexpr char kPrefix[] = "@ORB ";
constexpr size_t kMaxBytesPerLoop = 4096;
constexpr uint32_t kAssetTimeoutMs = 30000;

bool validPassword(const String &password) {
  return password.isEmpty() || (password.length() >= 8 && password.length() <= 63);
}

}  // namespace

bool UsbProvisioningStore::stage(const UsbWifiRequest &request) {
  Preferences prefs;
  if (!prefs.begin(kNamespace, false)) return false;
  prefs.putString("op", request.operationId);
  prefs.putString("ssid", request.ssid);
  prefs.putString("pass", request.password);
  const bool saved = prefs.putBool("pending", true) == 1;
  prefs.remove("resultOp");
  prefs.remove("resultOk");
  prefs.remove("resultErr");
  prefs.end();
  return saved;
}

bool UsbProvisioningStore::pending(UsbWifiRequest &request) {
  Preferences prefs;
  if (!prefs.begin(kNamespace, false)) return false;
  if (!prefs.isKey("pending")) {
    prefs.end();
    return false;
  }
  const bool isPending = prefs.getBool("pending", false);
  if (isPending) {
    request.operationId = prefs.getString("op");
    request.ssid = prefs.getString("ssid");
    request.password = prefs.getString("pass");
  }
  prefs.end();
  return isPending && !request.operationId.isEmpty() && !request.ssid.isEmpty();
}

void UsbProvisioningStore::complete(const String &operationId, bool success, const char *error) {
  Preferences prefs;
  if (!prefs.begin(kNamespace, false)) return;
  prefs.putBool("pending", false);
  prefs.remove("op");
  prefs.remove("ssid");
  prefs.remove("pass");
  prefs.putString("resultOp", operationId);
  prefs.putBool("resultOk", success);
  prefs.putString("resultErr", error ? error : "");
  prefs.end();
}

bool UsbProvisioningStore::result(String &operationId, bool &success, String &error) {
  Preferences prefs;
  if (!prefs.begin(kNamespace, false)) return false;
  if (!prefs.isKey("resultOp")) {
    prefs.end();
    return false;
  }
  operationId = prefs.getString("resultOp");
  success = prefs.getBool("resultOk", false);
  error = prefs.getString("resultErr");
  prefs.end();
  return !operationId.isEmpty();
}

void UsbProvisioningStore::clear() {
  Preferences prefs;
  if (!prefs.begin(kNamespace, false)) return;
  prefs.clear();
  prefs.end();
}

void SerialControl::begin(DeviceConfigStore &configStore) {
  configStore_ = &configStore;
}

void SerialControl::loop(bool configured) {
  size_t processed = 0;
  while (Serial.available() && processed < kMaxBytesPerLoop) {
    if (receivingAsset_) {
      receiveAssetBytes();
      processed = kMaxBytesPerLoop;
      continue;
    }
    processed++;
    const char value = static_cast<char>(Serial.read());
    if (value == '\n') {
      if (!discarding_ && inputLength_ > 0) {
        input_[inputLength_] = '\0';
        if (inputLength_ > 0 && input_[inputLength_ - 1] == '\r') input_[--inputLength_] = '\0';
        handleLine(input_, configured);
      }
      inputLength_ = 0;
      discarding_ = false;
      continue;
    }
    if (discarding_) continue;
    if (inputLength_ >= sizeof(input_) - 1) {
      inputLength_ = 0;
      discarding_ = true;
      reply("", false, "frame_too_large", configured);
      continue;
    }
    input_[inputLength_++] = value;
  }

  if (assetExpected_ && millis() - assetLastByteAt_ >= kAssetTimeoutMs) {
    abortAssetUpload();
    discarding_ = true;
    inputLength_ = 0;
    Serial.println("USB update timed out");
  }
  if (restartAt_ && static_cast<int32_t>(millis() - restartAt_) >= 0) {
    Serial.flush();
    ESP.restart();
  }
}

void SerialControl::receiveAssetBytes() {
  uint8_t buffer[1024];
  const uint32_t remaining = assetExpected_ - assetReceived_;
  size_t count = static_cast<size_t>(Serial.available());
  if (count > sizeof(buffer)) count = sizeof(buffer);
  if (count > remaining) count = remaining;
  if (chunked_ && count > chunkRemaining_) count = chunkRemaining_;
  if (!count) return;
  const size_t read = Serial.read(buffer, count);
  assetLastByteAt_ = millis();
  // Drain the declared payload even after a write failure, never parse it as commands.
  if (!uploadError_) uploadError_ = deviceUpdate.write(UpdateOwner::Usb, buffer, read);
  assetReceived_ += read;
  if (chunked_) {
    chunkRemaining_ -= read;
    if (!chunkRemaining_) receivingAsset_ = false;
  }
  if (assetReceived_ == assetExpected_) {
    receivingAsset_ = false;
    assetReady_ = true;
  }
}

void SerialControl::abortAssetUpload() {
  receivingAsset_ = false;
  assetReady_ = false;
  deviceUpdate.abort(UpdateOwner::Usb);
  assetExpected_ = 0;
  assetReceived_ = 0;
  assetName_[0] = '\0';
  uploadError_ = nullptr;
  chunkRemaining_ = 0;
  chunked_ = false;
}

const char *SerialControl::commitAssetUpload(const char *assetName) {
  if (!assetReady_ || strcmp(assetName, assetName_)) return "asset_incomplete_or_invalid";
  const char *error = uploadError_ ? uploadError_ : deviceUpdate.commit(UpdateOwner::Usb);
  abortAssetUpload();
  return error;
}

void SerialControl::handleLine(const char *line, bool configured) {
  JsonDocument request;
  if (deserializeJson(request, line)) {
    reply("", false, "invalid_json", configured);
    return;
  }
  const int version = request["v"] | 0;
  const String id = request["id"] | "";
  const String command = request["cmd"] | "";
  if (version != 1 || id.isEmpty() || id.length() > 48) {
    reply(id, false, "invalid_request", configured);
    return;
  }
  if (command == "hello" || command == "status" || command == "update_status") {
    reply(id, true, nullptr, configured);
    return;
  }
  if (command == "token") {
    if (!configured || !configStore_ || configStore_->get().token.isEmpty()) {
      reply(id, false, "not_ready", configured);
      return;
    }
    reply(id, true, nullptr, configured, true);
    return;
  }
  if (command == "configure") {
    if (deviceUpdate.busy()) {
      reply(id, false, "busy", configured);
      return;
    }
    const String operationId = request["operationId"] | "";
    const String ssid = request["ssid"] | "";
    const String password = request["password"] | "";
    if (operationId.isEmpty() || operationId.length() > 48 || ssid.isEmpty() || ssid.length() > 32 || !validPassword(password)) {
      reply(id, false, "invalid_credentials", configured);
      return;
    }
    if (!UsbProvisioningStore::stage({operationId, ssid, password})) {
      reply(id, false, "storage_failed", configured);
      return;
    }
    reply(id, true, nullptr, configured);
    restartAt_ = millis() + 500;
    return;
  }
  if (command == "asset_begin" || command == "firmware_begin") {
    const String assetName = command == "firmware_begin" ? "firmware.bin" : request["name"] | "";
    const uint32_t size = request["size"] | 0;
    if (command == "asset_begin" && assetName != "animations.orb" && assetName != "sounds.json") {
      reply(id, false, "invalid_asset", configured);
      return;
    }
    if (assetExpected_) {
      reply(id, false, "busy", configured);
      return;
    }
    const char *error = deviceUpdate.begin(UpdateOwner::Usb, assetName.c_str(), size);
    if (error) {
      reply(id, false, error, configured);
      return;
    }
    strlcpy(assetName_, assetName.c_str(), sizeof(assetName_));
    assetExpected_ = size;
    assetReceived_ = 0;
    assetLastByteAt_ = millis();
    chunked_ = request["chunked"] | false;
    receivingAsset_ = !chunked_;
    uploadError_ = nullptr;
    reply(id, true, nullptr, configured);
    return;
  }
  if (command == "update_chunk") {
    const uint32_t size = request["size"] | 0;
    if (!chunked_ || !assetExpected_ || receivingAsset_ || !size || size > 4096 ||
        size > assetExpected_ - assetReceived_) {
      reply(id, false, "invalid_chunk", configured);
      return;
    }
    chunkRemaining_ = size;
    receivingAsset_ = true;
    assetLastByteAt_ = millis();
    reply(id, true, nullptr, configured);
    return;
  }
  if (command == "asset_commit" || command == "firmware_commit") {
    const String assetName = command == "firmware_commit" ? "firmware.bin" : request["name"] | "";
    const char *error = commitAssetUpload(assetName.c_str());
    if (error) {
      reply(id, false, error, configured);
      return;
    }
    reply(id, true, nullptr, configured);
    if (command == "firmware_commit") restartAt_ = millis() + 500;
    return;
  }
  if (command == "update_abort") {
    abortAssetUpload();
    reply(id, true, nullptr, configured);
    return;
  }
  if (command == "restart") {
    if (deviceUpdate.busy()) {
      reply(id, false, "busy", configured);
      return;
    }
    reply(id, true, nullptr, configured);
    restartAt_ = millis() + 500;
    return;
  }
  reply(id, false, "unknown_command", configured);
}

void SerialControl::reply(const String &id, bool ok, const char *error, bool configured, bool includeToken) {
  JsonDocument response;
  response["orb"] = "control";
  response["v"] = 1;
  response["id"] = id;
  response["ok"] = ok;
  if (error) response["error"] = error;
  JsonObject result = response["result"].to<JsonObject>();
  result["configured"] = configured;
  result["usbFirmwareUpdate"] = true;
  result["updateReceived"] = assetReceived_;
  result["connected"] = WiFi.status() == WL_CONNECTED;
  if (WiFi.status() == WL_CONNECTED) result["ip"] = WiFi.localIP().toString();
  if (configStore_ && configured) {
    result["hostname"] = configStore_->get().hostname;
    result["port"] = configStore_->get().port;
    if (includeToken) result["token"] = configStore_->get().token;
  }
  String operationId;
  String operationError;
  bool operationSuccess = false;
  if (UsbProvisioningStore::result(operationId, operationSuccess, operationError)) {
    JsonObject operation = result["operation"].to<JsonObject>();
    operation["id"] = operationId;
    operation["success"] = operationSuccess;
    if (!operationError.isEmpty()) operation["error"] = operationError;
  }
  String frame;
  serializeJson(response, frame);
  Serial.println(String(kPrefix) + frame);
}