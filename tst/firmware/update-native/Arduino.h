#pragma once
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
using String = std::string;
struct SerialStub {
  template<class... Args> void printf(const char *, Args...) {}
  void println(const char *) {}
};
extern SerialStub Serial;
