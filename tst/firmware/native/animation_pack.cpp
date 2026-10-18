#include <Arduino.h>
#include <FS.h>
#include <JPEGDEC.h>
#include <cassert>
#include <climits>
#include <fstream>
#include <iterator>
#include <iostream>
// Expose callback state only in this test translation unit.
#define private public
#include "animation_pack.h"
#undef private

static void put16(std::vector<uint8_t> &bytes, size_t offset, uint16_t value) {
  bytes[offset] = value;
  bytes[offset + 1] = value >> 8;
}
static void put32(std::vector<uint8_t> &bytes, size_t offset, uint32_t value) {
  put16(bytes, offset, value);
  put16(bytes, offset + 2, value >> 16);
}

static std::vector<uint8_t> fixture(const std::vector<uint8_t> &jpeg) {
  // Minimal one-clip, one-frame ORBA pack with fully opaque valid alpha RLE.
  std::vector<uint8_t> bytes(80, 0);
  std::memcpy(bytes.data(), "ORBA", 4);
  put16(bytes, 4, 1);
  put16(bytes, 6, 320);
  put16(bytes, 8, 320);
  put16(bytes, 10, 1);
  put32(bytes, 12, 1);
  put32(bytes, 16, 32);
  put32(bytes, 20, 64);
  put32(bytes, 24, 80);
  std::memcpy(bytes.data() + 32, "idle", 4);
  put16(bytes, 50, 1);
  put16(bytes, 52, 1200);
  put32(bytes, 64, 80);
  put32(bytes, 68, jpeg.size());
  put32(bytes, 72, 50);
  bytes.insert(bytes.end(), jpeg.begin(), jpeg.end());
  for (int i = 0; i < 25; ++i) {
    bytes.push_back(0xff);
    bytes.push_back(0xff); // 25 * 4096 = 320 * 320 pixels.
  }
  put32(bytes, 76, AnimationPack::crc32(bytes.data() + 80, bytes.size() - 80));
  return bytes;
}

static size_t sofOffset(const std::vector<uint8_t> &jpeg) {
  assert(jpeg[0] == 0xff && jpeg[1] == 0xd8);
  size_t offset = 2;
  while (offset + 9 < jpeg.size()) {
    assert(jpeg[offset] == 0xff);
    if (jpeg[offset + 1] == 0xc0) return offset;
    assert(jpeg[offset + 1] != 0xda);
    offset += 2 + (static_cast<size_t>(jpeg[offset + 2]) << 8) + jpeg[offset + 3];
  }
  assert(false && "Baseline JPEG SOF required");
  return 0;
}

static void testDimensions(const std::vector<uint8_t> &jpeg) {
  const size_t sof = sofOffset(jpeg);
  const uint16_t dimensions[][2] = {{320, 320}, {321, 320}, {320, 321},
                                     {319, 320}, {320, 319}, {640, 640}};
  for (const auto &dimension : dimensions) {
    auto altered = jpeg;
    altered[sof + 5] = dimension[1] >> 8;
    altered[sof + 6] = dimension[1];
    altered[sof + 7] = dimension[0] >> 8;
    altered[sof + 8] = dimension[0];
    // Verify the real decoder accepts this header and reports the altered dimensions.
    JPEGDEC decoder;
    assert(decoder.openRAM(altered.data(), altered.size(), nullptr));
    assert(decoder.getWidth() == dimension[0] && decoder.getHeight() == dimension[1]);
    decoder.close();
    fs::FS filesystem(fixture(altered));
    AnimationPack pack;
    assert(pack.begin(filesystem));
    AnimationClip clip;
    assert(pack.findClip("idle", clip));
    std::vector<uint16_t> target(320 * 320, 0x1234);
    const bool expected = dimension[0] == 320 && dimension[1] == 320;
    assert(pack.drawFrame(clip, 0, target.data(), 320, 320, 0, 0) == expected);
    assert(AnimationPack::active_ == nullptr);
    if (!expected) for (uint16_t pixel : target) assert(pixel == 0x1234);
    assert(!pack.drawFrame(clip, 0, target.data(), 0, 320, 0, 0));
    assert(!pack.drawFrame(clip, 0, target.data(), 320, 0, 0, 0));
    assert(!pack.drawFrame(clip, 0, nullptr, 320, 320, 0, 0));
    // A rejected header must not poison the next valid decode on the same pack.
    if (!expected) {
      auto valid = fixture(jpeg);
      pack.file_ = File(valid);
      assert(pack.drawFrame(clip, 0, target.data(), 320, 320, 0, 0));
    }
  }
}

static void testRectangles() {
  AnimationPack pack;
  pack.width_ = pack.height_ = 320;
  pack.alpha_ = static_cast<uint8_t *>(std::malloc(320 * 320));
  assert(pack.alpha_);
  std::memset(pack.alpha_, 255, 320 * 320);
  pack.targetStride_ = 5;
  pack.targetHeight_ = 3; // Deliberately not square.
  std::vector<uint16_t> guarded(17, 0x1234);
  pack.target_ = guarded.data() + 1;
  AnimationPack::active_ = &pack;
  uint16_t pixels[16];
  for (int i = 0; i < 16; ++i) pixels[i] = 0x8000 + i;
  const int coordinates[][2] = {{-2, -2}, {0, 0}, {3, 1}, {318, 318},
                                {320, 0}, {0, 320}, {INT_MAX, INT_MAX}, {INT_MIN, INT_MIN}};
  const int16_t origins[][2] = {{0, 0}, {-319, -319}, {-1, -1}, {4, 2}, {32767, 32767}};
  for (const auto &origin : origins) for (const auto &coordinate : coordinates) {
    std::fill(guarded.begin(), guarded.end(), 0x1234);
    auto expected = guarded;
    pack.originX_ = origin[0];
    pack.originY_ = origin[1];
    JPEGDRAW draw = {};
    draw.x = coordinate[0];
    draw.y = coordinate[1];
    draw.iWidth = draw.iHeight = 4;
    draw.pPixels = pixels;
    for (int y = 0; y < 4; ++y) for (int x = 0; x < 4; ++x) {
      const int64_t sx = static_cast<int64_t>(draw.x) + x;
      const int64_t sy = static_cast<int64_t>(draw.y) + y;
      const int64_t tx = sx + origin[0], ty = sy + origin[1];
      if (sx >= 0 && sx < 320 && sy >= 0 && sy < 320 && tx >= 0 && tx < 5 && ty >= 0 && ty < 3)
        expected[1 + ty * 5 + tx] = pixels[y * 4 + x];
    }
    assert(AnimationPack::jpegDraw(&draw) == 1);
    assert(guarded == expected);
  }
  assert(AnimationPack::jpegDraw(nullptr) == 0);
  JPEGDRAW empty = {};
  assert(AnimationPack::jpegDraw(&empty) == 0);
  AnimationPack::active_ = nullptr;
  assert(AnimationPack::jpegDraw(&empty) == 0);
}

static void testScaling(const std::vector<uint8_t> &jpeg) {
  fs::FS filesystem(fixture(jpeg));
  AnimationPack pack;
  assert(pack.begin(filesystem));
  AnimationClip clip;
  assert(pack.findClip("idle", clip));
  std::vector<uint16_t> full(320 * 320);
  assert(pack.drawFrame(clip, 0, full.data(), 320, 320, 0, 0));
  for (uint16_t size : {112, 184, 256, 320}) {
    const int stride = size + 4, height = size + 6;
    std::vector<uint16_t> scaled(stride * height, 0x1234);
    assert(pack.drawFrame(clip, 0, scaled.data(), stride, height, 2, 3, size));
    for (int y = 0; y < height; y++) for (int x = 0; x < stride; x++) {
      const bool inside = x >= 2 && x < size + 2 && y >= 3 && y < size + 3;
      assert(scaled[y * stride + x] == (inside ? full[(y - 3) * 320 / size * 320 + (x - 2) * 320 / size] : 0x1234));
    }
  }
  assert(!pack.drawFrame(clip, 0, full.data(), 320, 320, 0, 0, 0));
  assert(!pack.drawFrame(clip, 0, full.data(), 320, 320, 0, 0, 321));
}

int main(int argc, char **argv) {
  assert(argc == 2);
  std::ifstream input(argv[1], std::ios::binary);
  assert(input);
  const std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(input)), {});
  const uint32_t table = AnimationPack::readU32(bytes.data() + 20);
  const uint32_t offset = AnimationPack::readU32(bytes.data() + table);
  const uint32_t length = AnimationPack::readU32(bytes.data() + table + 4);
  assert(static_cast<uint64_t>(offset) + length <= bytes.size());
  const std::vector<uint8_t> jpeg(bytes.begin() + offset, bytes.begin() + offset + length);
  testDimensions(jpeg);
  testRectangles();
  testScaling(jpeg);
  std::cout << "JPEG dimension rejection and callback bounds passed\n";
}