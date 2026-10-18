#pragma once

#include <Arduino.h>

namespace Board {

constexpr uint16_t kWidth = 480;
constexpr uint16_t kHeight = 480;

bool begin();
bool mountSdCard();
bool sdMounted();
void lockSd();
void unlockSd();

class SdLock {
 public:
  SdLock() { lockSd(); }
  ~SdLock() { unlockSd(); }
  SdLock(const SdLock &) = delete;
  SdLock &operator=(const SdLock &) = delete;
};

uint16_t *backBuffer();
bool present();
void setBrightness(float brightness);
bool touched();
bool touchPoint(uint16_t &x, uint16_t &y);
void setBuzzer(bool enabled);

}  // namespace Board
