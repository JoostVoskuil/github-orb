#pragma once

#include <stdint.h>
#include <stdlib.h>

// A small Wi-Fi fan with a diagonal slash, above the animation viewport.
inline void drawOfflineIndicator(uint16_t *buffer, int width, int height, uint16_t color) {
  for (int dy = -30; dy <= 4; dy++) {
    for (int dx = -26; dx <= 26; dx++) {
      const int x = width / 2 + dx;
      const int y = 54 + dy;
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const int distance = dx * dx + dy * dy;
      bool visible = distance <= 4;
      for (int radius = 10; radius <= 24; radius += 7) {
        visible |= dy < -abs(dx) / 2 && distance >= (radius - 1) * (radius - 1) &&
          distance <= (radius + 1) * (radius + 1);
      }
      visible |= abs(dy + dx + 12) <= 1 && dx >= -16 && dx <= 18;
      if (visible) buffer[y * width + x] = color;
    }
  }
}