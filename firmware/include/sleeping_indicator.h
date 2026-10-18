#pragma once

#include <math.h>
#include <stdint.h>

// Three drifting lowercase z glyphs, independent of the SD animation assets.
inline void drawSleepingIndicator(uint16_t *buffer, int width, int height, uint32_t elapsedMs) {
  if (!buffer || width <= 0 || height <= 0) return;
  const uint8_t glyph[] = {0x1f, 0x02, 0x04, 0x08, 0x1f};
  for (int i = 0; i < 3; i++) {
    const float phase = fmodf(elapsedMs / 1000.0f * 0.35f + i / 3.0f, 1.0f);
    const float alpha = sinf(phase * 3.14159265f);
    const int size = static_cast<int>(12 + phase * 12);
    // Keep the entire rising trail inside the circular 480px display.
    const int left = width / 2 + static_cast<int>(100 + phase * 30) - size / 2;
    const int top = height / 2 - static_cast<int>(115 + phase * 55) - size / 2;
    for (int dy = 0; dy < size; dy++) {
      const int y = top + dy;
      if (y < 0 || y >= height) continue;
      for (int dx = 0; dx < size; dx++) {
        const int x = left + dx;
        if (x < 0 || x >= width || !(glyph[dy * 5 / size] & (1 << (4 - dx * 5 / size)))) continue;
        uint16_t &pixel = buffer[y * width + x];
        const int r = (pixel >> 11) & 31;
        const int g = (pixel >> 5) & 63;
        const int b = pixel & 31;
        // Lavender #c9b8f5, alpha-blended against the current RGB565 frame.
        pixel = (static_cast<uint16_t>(r + (25 - r) * alpha) << 11) |
          (static_cast<uint16_t>(g + (46 - g) * alpha) << 5) |
          static_cast<uint16_t>(b + (30 - b) * alpha);
      }
    }
  }
}