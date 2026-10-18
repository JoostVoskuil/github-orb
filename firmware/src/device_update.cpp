#include "device_update.h"

#include <ArduinoJson.h>
#include <SD_MMC.h>
#include <Update.h>

#include "board.h"

DeviceUpdate deviceUpdate;

namespace {
bool validSounds(File &file) {
  JsonDocument document;
  if (deserializeJson(document, file) || document["version"].as<uint8_t>() != 1) return false;
  JsonObjectConst sounds = document["sounds"].as<JsonObjectConst>();
  if (sounds.isNull()) return false;
  const char *names[] = {"copilotDone", "copilotNeedsInput", "monaPrAssigned", "monaReviewRequested",
                         "monaWorkflow", "monaSecurity", "monaNotification"};
  for (const char *name : names) {
    JsonArrayConst pulses = sounds[name].as<JsonArrayConst>();
    if (pulses.isNull() || pulses.size() == 0 || pulses.size() > 4) return false;
    uint16_t totalMs = 0;
    for (JsonVariantConst value : pulses) {
      JsonArrayConst pulse = value.as<JsonArrayConst>();
      if (pulse.size() != 2 || !pulse[0].is<uint16_t>() || !pulse[1].is<uint16_t>()) return false;
      const uint16_t onMs = pulse[0].as<uint16_t>(), gapMs = pulse[1].as<uint16_t>();
      if (onMs < 30 || onMs > 180 || gapMs > 120) return false;
      totalMs += onMs + gapMs;
      if (totalMs > 700) return false;
    }
  }
  return true;
}
}

const char *DeviceUpdate::begin(UpdateOwner owner, const char *name, size_t size, bool unknownFirmwareSize) {
  if (busy()) return "busy";
  const bool firmware = !strcmp(name, "firmware.bin");
  const size_t maximum = firmware ? 0x300000 : !strcmp(name, "animations.orb") ? 32 * 1024 * 1024 :
    !strcmp(name, "sounds.json") ? 4096 : 0;
  const bool unknown = unknownFirmwareSize && firmware && owner == UpdateOwner::Http && size == 0;
  if (owner == UpdateOwner::None || !maximum || (!size && !unknown) || size > maximum) return "invalid_update";
  if (!firmware && !Board::sdMounted()) return "sd_unavailable";
  owner_ = owner;
  expected_ = unknown ? maximum : size;
  received_ = 0;
  firmware_ = firmware;
  unknownSize_ = unknown;
  name_ = name;
  if (firmware_) {
    if (!Update.begin(unknown ? UPDATE_SIZE_UNKNOWN : size, U_FLASH)) {
      Serial.printf("Firmware update begin failed: %s\n", Update.errorString());
      clear();
      return "firmware_begin_failed";
    }
  } else {
    Board::SdLock lock;
    const String temporary = "/." + name_ + ".upload";
    SD_MMC.remove(temporary);
    file_ = SD_MMC.open(temporary, FILE_WRITE);
    if (!file_) {
      clear();
      return "storage_failed";
    }
  }
  return nullptr;
}

const char *DeviceUpdate::write(UpdateOwner owner, const uint8_t *data, size_t size) {
  if (owner_ != owner || !busy()) return "no_update";
  if (size > expected_ - received_) {
    abort(owner);
    return "update_size_mismatch";
  }
  size_t written;
  if (firmware_) written = Update.write(const_cast<uint8_t *>(data), size);
  else {
    Board::SdLock lock;
    written = file_.write(data, size);
  }
  if (written != size) {
    abort(owner);
    return "update_write_failed";
  }
  received_ += written;
  return nullptr;
}

const char *DeviceUpdate::commit(UpdateOwner owner) {
  if (owner_ != owner || !busy()) return "no_update";
  if (!received_ || (!unknownSize_ && received_ != expected_)) {
    abort(owner);
    return "update_size_mismatch";
  }
  if (firmware_) {
    if (!Update.end(unknownSize_)) {
      Serial.printf("Firmware validation failed: %s\n", Update.errorString());
      abort(owner);
      return "invalid_firmware";
    }
    clear();
    return nullptr;
  }
  Board::SdLock lock;
  file_.flush();
  file_.close();
  const String target = "/" + name_, temporary = "/." + name_ + ".upload", backup = "/." + name_ + ".backup";
  File check = SD_MMC.open(temporary, FILE_READ);
  bool valid = check && check.size() == expected_;
  if (!valid) Serial.printf("Asset validation: expected %u bytes, found %u\n", unsigned(expected_), unsigned(check.size()));
  if (valid && name_ == "animations.orb") {
    char magic[4] = {};
    valid = check.size() >= 32 && check.read(reinterpret_cast<uint8_t *>(magic), sizeof(magic)) == sizeof(magic) &&
      !memcmp(magic, "ORBA", sizeof(magic));
  } else if (valid) valid = validSounds(check);
  check.close();
  if (!valid) {
    abort(owner);
    return "asset_incomplete_or_invalid";
  }
  // A leftover backup may be the only intact copy after a power interruption.
  if (SD_MMC.exists(backup)) {
    if (!SD_MMC.exists(target) && !SD_MMC.rename(backup, target)) {
      abort(owner);
      return "asset_restore_failed";
    }
    if (SD_MMC.exists(backup) && !SD_MMC.remove(backup)) {
      abort(owner);
      return "storage_failed";
    }
  }
  const bool hadTarget = SD_MMC.exists(target);
  if (hadTarget && !SD_MMC.rename(target, backup)) {
    abort(owner);
    return "storage_failed";
  }
  if (!SD_MMC.rename(temporary, target)) {
    const bool restored = !hadTarget || SD_MMC.rename(backup, target);
    abort(owner);
    return restored ? "storage_failed" : "asset_restore_failed";
  }
  if (hadTarget && !SD_MMC.remove(backup)) Serial.println("Asset update: previous file retained as backup");
  clear();
  return nullptr;
}

void DeviceUpdate::abort(UpdateOwner owner) {
  if (owner_ != owner || !busy()) return;
  if (firmware_) Update.abort();
  else {
    Board::SdLock lock;
    file_.close();
    if (!SD_MMC.remove("/." + name_ + ".upload")) Serial.println("Asset update: temporary file cleanup failed");
  }
  clear();
}

void DeviceUpdate::clear() {
  owner_ = UpdateOwner::None;
  expected_ = received_ = 0;
  name_ = "";
  firmware_ = false;
  unknownSize_ = false;
}
