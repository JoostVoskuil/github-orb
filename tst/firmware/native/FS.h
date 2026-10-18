#pragma once
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <memory>
#include <vector>
#define FILE_READ "r"
class File {
 public:
  File() = default;
  explicit File(const std::vector<uint8_t> &bytes)
      : bytes_(std::make_shared<std::vector<uint8_t>>(bytes)) {}
  explicit operator bool() const { return bytes_ != nullptr; }
  bool seek(size_t offset) {
    if (!bytes_ || offset > bytes_->size()) return false;
    position_ = offset;
    return true;
  }
  size_t read(uint8_t *target, size_t length) {
    if (!bytes_) return 0;
    const size_t count = std::min(length, bytes_->size() - position_);
    std::memcpy(target, bytes_->data() + position_, count);
    position_ += count;
    return count;
  }
  size_t size() const { return bytes_ ? bytes_->size() : 0; }
 private:
  std::shared_ptr<std::vector<uint8_t>> bytes_;
  size_t position_ = 0;
};
namespace fs {
class FS {
 public:
  explicit FS(const std::vector<uint8_t> &bytes) : file_(bytes) {}
  File open(const char *, const char *) { return file_; }
 private:
  File file_;
};
}