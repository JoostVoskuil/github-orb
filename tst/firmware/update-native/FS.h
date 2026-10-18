#pragma once
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <memory>
#include <vector>
#define FILE_READ "r"
#define FILE_WRITE "w"
class File {
 public:
  File() = default;
  explicit File(std::shared_ptr<std::vector<uint8_t>> bytes) : bytes_(bytes) {}
  explicit operator bool() const { return bool(bytes_); }
  size_t size() const { return bytes_ ? bytes_->size() : 0; }
  size_t read(uint8_t *data, size_t count) {
    const size_t length = std::min(count, size() - position_);
    if (length) std::memcpy(data, bytes_->data() + position_, length);
    position_ += length;
    return length;
  }
  int read() { uint8_t byte; return read(&byte, 1) ? byte : -1; }
  size_t readBytes(char *data, size_t count) { return read(reinterpret_cast<uint8_t *>(data), count); }
  size_t write(const uint8_t *data, size_t count) {
    if (!bytes_) return 0;
    bytes_->insert(bytes_->end(), data, data + count);
    return count;
  }
  void flush() {}
  void close() { bytes_.reset(); }
 private:
  std::shared_ptr<std::vector<uint8_t>> bytes_;
  size_t position_ = 0;
};
