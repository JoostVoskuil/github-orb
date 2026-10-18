#pragma once
#include <vector>
#include <cstdint>
#define U_FLASH 0
#define UPDATE_SIZE_UNKNOWN 0xffffffff
class UpdateStub {
 public:
  bool active = false, committed = false;
  size_t expected = 0;
  std::vector<uint8_t> bytes;
  bool begin(size_t size, int) { active = true; committed = false; expected = size; bytes.clear(); return true; }
  size_t write(uint8_t *data, size_t size) { bytes.insert(bytes.end(), data, data + size); return size; }
  bool end(bool unknown = false) { committed = (unknown || bytes.size() == expected) && !bytes.empty() && bytes[0] == 0xe9; active = !committed; return committed; }
  void abort() { active = false; }
  const char *errorString() { return "invalid image"; }
};
extern UpdateStub Update;
