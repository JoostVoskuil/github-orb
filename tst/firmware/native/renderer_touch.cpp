#include <assert.h>
#include "permission_review.h"

// Compile the actual production touch methods without display/SD dependencies.
class Renderer {
 public:
  void touch(bool down, uint16_t x, uint16_t y, uint32_t now);
  void pointerDown(uint16_t x, uint16_t y, uint32_t now);
  void pointerUp(uint32_t now, int x = -1, int y = -1);
  void tap(uint16_t x, uint16_t y, uint32_t) {
    assert(x == 300 && y == 350);
    taps++;
  }
  unsigned taps = 0;
  bool touching_ = false, pressActive_ = false, forceRender_ = false;
  uint16_t pressX_ = 0, pressY_ = 0;
  uint32_t pressAtMs_ = 0, pressToken_ = 0, overlayToken_ = 1;
  int pressOverlay_ = 0, overlay_ = 1;
  PermissionReview::TapMotion pressMotion_;
};

#include "touch-handler.inc"

int main() {
  Renderer renderer;
  renderer.touch(true, 300, 350, 0);
  renderer.touch(false, 0, 0, 10); // release coordinates are unavailable on hardware
  assert(renderer.taps == 1);
  renderer.touch(true, 300, 350, 20);
  renderer.touch(true, 340, 350, 21); // swipe off Approve
  renderer.touch(false, 0, 0, 30);
  assert(renderer.taps == 1);
  renderer.touch(true, 300, 350, 40);
  renderer.touch(true, 340, 350, 41);
  renderer.touch(true, 300, 350, 42); // returning must not re-arm
  renderer.touch(false, 0, 0, 50);
  assert(renderer.taps == 1);
  renderer.touch(true, 300, 350, 60);
  renderer.touch(true, 312, 350, 61);
  renderer.touch(false, 0, 0, 70);
  assert(renderer.taps == 2);
  renderer.pointerDown(300, 350, 80);
  renderer.pointerUp(90, 313, 350);
  assert(renderer.taps == 2);
  renderer.pointerDown(300, 350, 100);
  renderer.pointerUp(110); // legacy call remains valid
  renderer.pointerUp(111); // duplicate release cannot tap
  assert(renderer.taps == 3);
  renderer.pointerDown(300, 350, 120);
  renderer.overlayToken_++;
  renderer.pointerUp(130);
  assert(renderer.taps == 3);
  renderer.pointerDown(300, 350, 140);
  renderer.overlay_++;
  renderer.pointerUp(150);
  assert(renderer.taps == 3);
  renderer.pointerDown(300, 350, 160);
  renderer.pointerUp(960); // 800 ms hold is not a tap
  assert(renderer.taps == 3);
}