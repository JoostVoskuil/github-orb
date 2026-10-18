#include "animation_pack.h"

#include <algorithm>
#include <esp_heap_caps.h>

namespace {
constexpr uint16_t kPackVersion = 1;
constexpr uint32_t kHeaderSize = 32;
constexpr uint32_t kClipEntrySize = 32;
constexpr uint32_t kFrameEntrySize = 16;
}

AnimationPack *AnimationPack::active_ = nullptr;

AnimationPack::~AnimationPack() {
  if (payload_) heap_caps_free(payload_);
  if (alpha_) heap_caps_free(alpha_);
}

uint16_t AnimationPack::readU16(const uint8_t *bytes) {
  return bytes[0] | static_cast<uint16_t>(bytes[1]) << 8;
}

uint32_t AnimationPack::readU32(const uint8_t *bytes) {
  return bytes[0] | static_cast<uint32_t>(bytes[1]) << 8 | static_cast<uint32_t>(bytes[2]) << 16 |
         static_cast<uint32_t>(bytes[3]) << 24;
}

bool AnimationPack::readAt(uint32_t offset, void *destination, size_t length) {
  return file_ && file_.seek(offset) && file_.read(static_cast<uint8_t *>(destination), length) == length;
}

bool AnimationPack::begin(fs::FS &filesystem, const char *path) {
  file_ = filesystem.open(path, FILE_READ);
  uint8_t header[kHeaderSize];
  if (!file_ || !readAt(0, header, sizeof(header)) || memcmp(header, "ORBA", 4)) return false;
  if (readU16(header + 4) != kPackVersion) return false;
  width_ = readU16(header + 6);
  height_ = readU16(header + 8);
  clipCount_ = readU16(header + 10);
  frameCount_ = readU32(header + 12);
  clipTableOffset_ = readU32(header + 16);
  frameTableOffset_ = readU32(header + 20);
  const uint32_t dataOffset = readU32(header + 24);
  const uint64_t minimumDataOffset = static_cast<uint64_t>(frameTableOffset_) + frameCount_ * kFrameEntrySize;
  if (width_ != 320 || height_ != 320 || !clipCount_ || !frameCount_ || clipTableOffset_ != kHeaderSize ||
      frameTableOffset_ != clipTableOffset_ + clipCount_ * kClipEntrySize || dataOffset < minimumDataOffset ||
      dataOffset > file_.size()) return false;
  alpha_ = static_cast<uint8_t *>(heap_caps_malloc(static_cast<size_t>(width_) * height_, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  return alpha_ != nullptr;
}

bool AnimationPack::findClip(const char *name, AnimationClip &clip) {
  uint8_t entry[kClipEntrySize];
  for (uint16_t index = 0; index < clipCount_; index++) {
    if (!readAt(clipTableOffset_ + index * kClipEntrySize, entry, sizeof(entry))) return false;
    char candidate[17] = {};
    memcpy(candidate, entry, 16);
    if (candidate[15]) continue; // Pack names have at most 15 characters.
    if (strcmp(candidate, name)) continue;
    strlcpy(clip.name, candidate, sizeof(clip.name));
    clip.firstFrame = readU16(entry + 16);
    clip.frameCount = readU16(entry + 18);
    clip.fps100 = readU16(entry + 20);
    clip.loop = (readU16(entry + 22) & 1) != 0;
    clip.durationMs = readU32(entry + 24);
    return clip.frameCount && clip.fps100 && static_cast<uint32_t>(clip.firstFrame) + clip.frameCount <= frameCount_;
  }
  return false;
}

bool AnimationPack::readFrameEntry(uint32_t index, FrameEntry &entry) {
  if (index >= frameCount_) return false;
  uint8_t bytes[kFrameEntrySize];
  if (!readAt(frameTableOffset_ + index * kFrameEntrySize, bytes, sizeof(bytes))) return false;
  entry = {readU32(bytes), readU32(bytes + 4), readU32(bytes + 8), readU32(bytes + 12)};
  const uint64_t end = static_cast<uint64_t>(entry.offset) + entry.jpegLength + entry.alphaLength;
  return entry.jpegLength > 0 && entry.alphaLength > 0 && end <= file_.size();
}

bool AnimationPack::ensurePayload(size_t bytes) {
  if (bytes <= payloadCapacity_) return true;
  if (payload_) heap_caps_free(payload_);
  payloadCapacity_ = 0;
  payload_ = static_cast<uint8_t *>(heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!payload_) return false;
  payloadCapacity_ = bytes;
  return true;
}

bool AnimationPack::decodeAlpha(const uint8_t *encoded, size_t length) {
  const size_t pixels = static_cast<size_t>(width_) * height_;
  size_t cursor = 0;
  for (size_t offset = 0; offset + 1 < length; offset += 2) {
    const uint8_t alpha = (encoded[offset] >> 4) * 17;
    const size_t run = (((encoded[offset] & 0x0f) << 8) | encoded[offset + 1]) + 1;
    if (cursor + run > pixels) return false;
    memset(alpha_ + cursor, alpha, run);
    cursor += run;
  }
  return cursor == pixels && (length % 2) == 0;
}

uint32_t AnimationPack::crc32(const uint8_t *bytes, size_t length) {
  uint32_t crc = 0xffffffff;
  for (size_t i = 0; i < length; i++) {
    crc ^= bytes[i];
    for (uint8_t bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return crc ^ 0xffffffff;
}

uint16_t AnimationPack::blend565(uint16_t background, uint16_t foreground, uint8_t alpha) {
  if (alpha == 255) return foreground;
  if (!alpha) return background;
  const uint32_t inverse = 255 - alpha;
  const uint32_t red = (((foreground >> 11) & 0x1f) * alpha + ((background >> 11) & 0x1f) * inverse) / 255;
  const uint32_t green = (((foreground >> 5) & 0x3f) * alpha + ((background >> 5) & 0x3f) * inverse) / 255;
  const uint32_t blue = ((foreground & 0x1f) * alpha + (background & 0x1f) * inverse) / 255;
  return (red << 11) | (green << 5) | blue;
}

int AnimationPack::jpegDraw(JPEGDRAW *draw) {
  if (!active_ || !draw || !draw->pPixels || draw->iWidth <= 0 || draw->iHeight <= 0) return 0;
  AnimationPack &pack = *active_;
  auto *pixels = static_cast<uint16_t *>(draw->pPixels);
  for (int y = 0; y < draw->iHeight; y++) {
    const int64_t sourceY = static_cast<int64_t>(draw->y) + y;
    if (sourceY < 0 || sourceY >= pack.height_) continue;
    const int scaledY = pack.drawSize_ == pack.height_ ? sourceY : pack.sourceToTarget_[sourceY];
    if (scaledY < 0) continue;
    const int64_t targetY = pack.originY_ + scaledY;
    if (targetY < 0 || targetY >= pack.targetHeight_) continue;
    for (int x = 0; x < draw->iWidth; x++) {
      const int64_t sourceX = static_cast<int64_t>(draw->x) + x;
      if (sourceX < 0 || sourceX >= pack.width_) continue;
      const int scaledX = pack.drawSize_ == pack.width_ ? sourceX : pack.sourceToTarget_[sourceX];
      if (scaledX < 0) continue;
      const int64_t targetX = pack.originX_ + scaledX;
      if (targetX < 0 || targetX >= pack.targetStride_) continue;
      const uint8_t alpha = pack.alpha_[sourceY * pack.width_ + sourceX];
      uint16_t &destination = pack.target_[static_cast<size_t>(targetY) * pack.targetStride_ + targetX];
      destination = blend565(destination, pixels[static_cast<size_t>(y) * draw->iWidth + x], alpha);
    }
  }
  return 1;
}

bool AnimationPack::drawFrame(const AnimationClip &clip, uint16_t localFrame, uint16_t *target,
                              uint16_t stride, uint16_t targetHeight, int16_t originX, int16_t originY,
                              uint16_t drawSize) {
  if (!target || !stride || !targetHeight || !clip.frameCount || !drawSize || drawSize > width_) return false;
  localFrame = clip.loop ? localFrame % clip.frameCount : min<uint16_t>(localFrame, clip.frameCount - 1);
  FrameEntry entry;
  if (!readFrameEntry(clip.firstFrame + localFrame, entry)) return false;
  const size_t payloadLength = entry.jpegLength + entry.alphaLength;
  if (!ensurePayload(payloadLength) || !readAt(entry.offset, payload_, payloadLength)) return false;
  if (crc32(payload_, payloadLength) != entry.crc || !decodeAlpha(payload_ + entry.jpegLength, entry.alphaLength)) return false;

  if (!jpeg_.openRAM(payload_, entry.jpegLength, jpegDraw)) return false;
  if (jpeg_.getWidth() != width_ || jpeg_.getHeight() != height_) {
    jpeg_.close();
    return false;
  }
  target_ = target;
  targetStride_ = stride;
  targetHeight_ = targetHeight;
  originX_ = originX;
  originY_ = originY;
  drawSize_ = drawSize;
  if (drawSize < width_) {
    std::fill(sourceToTarget_, sourceToTarget_ + width_, -1);
    for (uint16_t target = 0; target < drawSize; target++) sourceToTarget_[target * width_ / drawSize] = target;
  }
  active_ = this;
  jpeg_.setPixelType(RGB565_LITTLE_ENDIAN);
  const bool ok = jpeg_.decode(0, 0, 0) != 0;
  jpeg_.close();
  active_ = nullptr;
  return ok;
}