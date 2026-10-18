#pragma once
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
using std::min;
inline size_t strlcpy(char *target, const char *source, size_t size) {
  const size_t length = std::strlen(source);
  if (size) {
    const size_t count = std::min(length, size - 1);
    std::memcpy(target, source, count);
    target[count] = 0;
  }
  return length;
}