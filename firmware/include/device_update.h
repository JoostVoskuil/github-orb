#pragma once

#include <Arduino.h>
#include <FS.h>

enum class UpdateOwner { None, Usb, Http };

class DeviceUpdate {
 public:
  const char *begin(UpdateOwner owner, const char *name, size_t size, bool unknownFirmwareSize = false);
  const char *write(UpdateOwner owner, const uint8_t *data, size_t size);
  const char *commit(UpdateOwner owner);
  void abort(UpdateOwner owner);
  bool busy() const { return owner_ != UpdateOwner::None; }

 private:
  void clear();
  UpdateOwner owner_ = UpdateOwner::None;
  File file_;
  size_t expected_ = 0;
  size_t received_ = 0;
  bool firmware_ = false;
  bool unknownSize_ = false;
  String name_;
};

extern DeviceUpdate deviceUpdate;
