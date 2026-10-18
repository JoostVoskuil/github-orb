#pragma once

#include <Arduino.h>
#include <FS.h>
#include <JPEGDEC.h>

struct AnimationClip {
  char name[16] = {};
  uint16_t firstFrame = 0;
  uint16_t frameCount = 0;
  uint16_t fps100 = 0;
  bool loop = false;
  uint32_t durationMs = 0;
};

class AnimationPack {
 public:
  ~AnimationPack();
  bool begin(fs::FS &filesystem, const char *path = "/animations.orb");
  bool findClip(const char *name, AnimationClip &clip);
  bool drawFrame(const AnimationClip &clip, uint16_t localFrame, uint16_t *target,
                 uint16_t stride, uint16_t targetHeight, int16_t originX, int16_t originY,
                 uint16_t drawSize = 320);
  uint16_t width() const { return width_; }
  uint16_t height() const { return height_; }

 private:
  struct FrameEntry {
    uint32_t offset;
    uint32_t jpegLength;
    uint32_t alphaLength;
    uint32_t crc;
  };

  static int jpegDraw(JPEGDRAW *draw);
  bool readAt(uint32_t offset, void *destination, size_t length);
  bool readFrameEntry(uint32_t index, FrameEntry &entry);
  bool ensurePayload(size_t bytes);
  bool decodeAlpha(const uint8_t *encoded, size_t length);
  static uint32_t readU32(const uint8_t *bytes);
  static uint16_t readU16(const uint8_t *bytes);
  static uint32_t crc32(const uint8_t *bytes, size_t length);
  static uint16_t blend565(uint16_t background, uint16_t foreground, uint8_t alpha);

  File file_;
  JPEGDEC jpeg_;
  uint16_t width_ = 0;
  uint16_t height_ = 0;
  uint16_t clipCount_ = 0;
  uint32_t frameCount_ = 0;
  uint32_t clipTableOffset_ = 0;
  uint32_t frameTableOffset_ = 0;
  uint8_t *payload_ = nullptr;
  size_t payloadCapacity_ = 0;
  uint8_t *alpha_ = nullptr;
  uint16_t *target_ = nullptr;
  uint16_t targetStride_ = 0;
  uint16_t targetHeight_ = 0;
  int16_t originX_ = 0;
  int16_t originY_ = 0;
  uint16_t drawSize_ = 320;
  int16_t sourceToTarget_[320] = {};
  static AnimationPack *active_;
};
