#include <assert.h>
#include <stdint.h>
#include <vector>

#include "offline_indicator.h"

int main() {
  const uint16_t sentinel = 0x1234;
  const uint16_t color = 0xffff;
  for (int width : {480, 20, 1}) {
    for (int height : {480, 40, 1}) {
      std::vector<uint16_t> pixels(width * height + 2, sentinel);
      drawOfflineIndicator(pixels.data() + 1, width, height, color);
      assert(pixels.front() == sentinel && pixels.back() == sentinel);
      if (height == 480) {
        assert(pixels[1 + 54 * width + width / 2] == color); // Wi-Fi dot.
        assert(pixels[1 + 42 * width + width / 2] == color); // Slash.
        if (width == 480) {
          assert(pixels[1 + 30 * width + width / 2] == color); // Outer arc.
          assert(pixels[1 + 100 * width + width / 2] == sentinel);
        }
      }
    }
  }
}