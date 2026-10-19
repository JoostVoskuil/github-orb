#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>

// Fixed-cell, lossless byte review. ASCII is literal; backslash and unsupported
// bytes are escaped, so the display font cannot conceal shell syntax or controls.
namespace PermissionReview {
constexpr size_t kCommandMax = 1024;

// Match JavaScript String.trim() whitespace, not locale-dependent isspace().
inline bool whitespace(uint32_t c) {
  return c == 0x20 || (c >= 0x09 && c <= 0x0d) || c == 0xa0 || c == 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c == 0x2028 || c == 0x2029 || c == 0x202f ||
    c == 0x205f || c == 0x3000 || c == 0xfeff;
}

// Validate the complete UTF-8 input before storage; never approve a truncated prefix.
inline bool validCommand(const char *command) {
  if (!command) return false;
  const size_t length = strlen(command);
  if (!length || length > kCommandMax) return false;
  const auto *bytes = reinterpret_cast<const unsigned char *>(command);
  bool nonblank = false;
  for (size_t i = 0; i < length;) {
    uint32_t c = bytes[i++];
    if (c >= 0x80) {
      size_t continuation;
      uint32_t minimum;
      if (c >= 0xc2 && c <= 0xdf) { continuation = 1; minimum = 0x80; c &= 0x1f; }
      else if (c >= 0xe0 && c <= 0xef) { continuation = 2; minimum = 0x800; c &= 0x0f; }
      else if (c >= 0xf0 && c <= 0xf4) { continuation = 3; minimum = 0x10000; c &= 0x07; }
      else return false;
      if (continuation > length - i) return false;
      while (continuation--) {
        const unsigned char next = bytes[i++];
        if ((next & 0xc0) != 0x80) return false;
        c = (c << 6) | (next & 0x3f);
      }
      if (c < minimum || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) return false;
    }
    if ((c < 0x20 && c != '\t' && c != '\n' && c != '\r') || (c >= 0x7f && c <= 0x9f)) return false;
    nonblank |= !whitespace(c);
  }
  return nonblank;
}

// Once any sampled point leaves the tap radius, returning cannot re-arm it.
struct TapMotion {
  uint16_t startX = 0, startY = 0, x = 0, y = 0;
  bool cancelled = false;
  void begin(uint16_t px, uint16_t py) {
    startX = x = px;
    startY = y = py;
    cancelled = false;
  }
  void update(uint16_t px, uint16_t py) {
    x = px;
    y = py;
    const int64_t dx = static_cast<int64_t>(x) - startX;
    const int64_t dy = static_cast<int64_t>(y) - startY;
    cancelled |= dx * dx + dy * dy > 12 * 12;
  }
};

constexpr size_t kColumns = 26;
constexpr size_t kRows = 6;
struct Page {
  char lines[kRows][kColumns + 1] = {};
  size_t count = 1;
};

inline Page page(const char *command, size_t requested) {
  Page out;
  size_t number = 0, row = 0, column = 0;
  auto emit = [&](char c) {
    if (c == '\n' || column == kColumns) {
      column = 0;
      if (++row == kRows) { row = 0; number++; }
      if (c == '\n') return;
    }
    if (number == requested) out.lines[row][column] = c;
    column++;
  };
  const char *hex = "0123456789ABCDEF";
  for (const unsigned char *p = reinterpret_cast<const unsigned char *>(command); *p; p++) {
    if (*p == '\n') emit('\n');
    else if (*p == '\\') { emit('\\'); emit('\\'); }
    else if (*p >= 0x20 && *p <= 0x7e) emit(static_cast<char>(*p));
    else { emit('\\'); emit('x'); emit(hex[*p >> 4]); emit(hex[*p & 15]); }
  }
  out.count = number + 1;
  return out;
}

enum class Hit : uint8_t { None, Deny, Approve };
inline Hit hit(int x, int y) {
  if (y >= 340 && y < 378) {
    if (x >= 90 && x < 230) return Hit::Deny;
    if (x >= 250 && x < 390) return Hit::Approve;
  }
  return Hit::None;
}
inline bool canApprove(bool actionable, bool displayOnly, bool pending) {
  return actionable && !displayOnly && !pending;
}
}  // namespace PermissionReview