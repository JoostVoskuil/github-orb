#include <assert.h>
#include <stdint.h>
#include <vector>

#include "sleeping_indicator.h"

int main() {
  const uint16_t background = 0x0862;
  std::vector<uint16_t> first;
  for (uint32_t elapsed : {0u, 500u, 1000u, 2857u, 0xffffffffu}) {
    for (int width : {480, 20, 1}) {
      for (int height : {480, 40, 1}) {
        std::vector<uint16_t> pixels(width * height + 2, background);
        drawSleepingIndicator(pixels.data() + 1, width, height, elapsed);
        assert(pixels.front() == background && pixels.back() == background);
        if (width != 480 || height != 480) continue;
        int changed = 0;
        for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
          if (pixels[1 + y * width + x] == background) continue;
          changed++;
          const int dx = x - 240, dy = y - 240;
          assert(dx * dx + dy * dy < 226 * 226); // Inside the status ring.
        }
        assert(changed > 100);
        if (elapsed == 0) {
          // Middle z at phase 1/3: top bar and open interior.
          assert(pixels[1 + 100 * width + 342] != background);
          assert(pixels[1 + 104 * width + 342] == background);
          const uint16_t faded = pixels[1 + 100 * width + 342];
          assert(faded != static_cast<uint16_t>((25 << 11) | (46 << 5) | 30));
          first = pixels;
        } else assert(pixels != first); // Motion and fading alter the frame.
      }
    }
  }
  drawSleepingIndicator(nullptr, 480, 480, 0);
}