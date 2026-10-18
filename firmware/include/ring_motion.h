#pragma once

#include <math.h>
#include <stdint.h>

inline bool runningSessionDot(uint8_t position, uint32_t now) {
  constexpr uint8_t count = 23;
  const uint8_t offset = (now / 100) % count;
  return (position + count - offset) % count < 5;
}

inline uint32_t ringDotColor(uint8_t position, uint8_t count, uint8_t dotCount, float speed, uint32_t now, uint8_t colorOffset = 0) {
  constexpr uint32_t kColors[] = {0xf85149, 0xf0a020, 0x3fb950, 0x2f81f7};
  if (!count || !dotCount) return 0;
  const uint8_t offset = static_cast<uint8_t>(fmodf(now / 1000.0f * speed, 1.0f) * count);
  for (uint8_t dot = 0; dot < dotCount; dot++) {
    const uint8_t start = static_cast<uint8_t>((offset + dot * count / dotCount) % count);
    if ((position + count - start) % count < 2) return kColors[(dot + colorOffset) % 4];
  }
  return 0;
}
