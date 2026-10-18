#pragma once
#include <map>
#include <string>
#include "FS.h"
class SdStub {
 public:
  std::map<std::string, std::shared_ptr<std::vector<uint8_t>>> files;
  std::string failRenameFrom;
  File open(const std::string &path, const char *mode) {
    if (*mode == 'w') files[path] = std::make_shared<std::vector<uint8_t>>();
    const auto found = files.find(path);
    return found == files.end() ? File() : File(found->second);
  }
  bool exists(const std::string &path) { return files.count(path); }
  bool remove(const std::string &path) { return files.erase(path); }
  bool rename(const std::string &from, const std::string &to) {
    if (from == failRenameFrom || !exists(from) || exists(to)) return false;
    files[to] = files[from];
    files.erase(from);
    return true;
  }
};
extern SdStub SD_MMC;
