#include <cassert>
#include "device_update.h"
#include "board.h"
#include "SD_MMC.h"
#include "Update.h"

SerialStub Serial;
SdStub SD_MMC;
UpdateStub Update;
bool mounted = true;
namespace Board {
bool sdMounted() { return mounted; }
void lockSd() {}
void unlockSd() {}
}

int main() {
  DeviceUpdate updater;
  const uint8_t image[] = {0xe9, 1, 2, 3};
  assert(updater.begin(UpdateOwner::Usb, "firmware.bin", 0));
  assert(updater.begin(UpdateOwner::Usb, "firmware.bin", 0x300001));
  assert(!updater.begin(UpdateOwner::Usb, "firmware.bin", 0x300000));
  updater.abort(UpdateOwner::Usb);
  assert(!updater.busy());
  assert(!updater.begin(UpdateOwner::Usb, "animations.orb", 32 * 1024 * 1024));
  updater.abort(UpdateOwner::Usb);
  assert(updater.begin(UpdateOwner::Usb, "animations.orb", 32 * 1024 * 1024 + 1));
  assert(updater.begin(UpdateOwner::Usb, "../config.json", 4));
  assert(!updater.begin(UpdateOwner::Usb, "firmware.bin", sizeof(image)));
  assert(updater.begin(UpdateOwner::Http, "sounds.json", 10));
  updater.abort(UpdateOwner::Http);
  assert(updater.busy() && Update.active);
  assert(updater.write(UpdateOwner::Http, image, sizeof(image)));
  assert(!updater.write(UpdateOwner::Usb, image, sizeof(image)));
  assert(!updater.commit(UpdateOwner::Usb));
  assert(Update.committed && !updater.busy());
  assert(!updater.begin(UpdateOwner::Http, "firmware.bin", 0, true));
  assert(!updater.write(UpdateOwner::Http, image, sizeof(image)));
  assert(!updater.commit(UpdateOwner::Http));
  assert(!updater.begin(UpdateOwner::Http, "firmware.bin", sizeof(image)));
  assert(!updater.write(UpdateOwner::Http, image, 1));
  assert(updater.commit(UpdateOwner::Http));
  assert(!Update.active && !updater.busy());
  assert(!updater.begin(UpdateOwner::Usb, "firmware.bin", 1));
  assert(updater.write(UpdateOwner::Usb, image, 2));
  assert(!updater.busy());
  const uint8_t invalidImage[] = {0};
  assert(!updater.begin(UpdateOwner::Usb, "firmware.bin", 1));
  assert(!updater.write(UpdateOwner::Usb, invalidImage, 1));
  assert(updater.commit(UpdateOwner::Usb));
  assert(!updater.busy());
  mounted = false;
  assert(updater.begin(UpdateOwner::Http, "sounds.json", 1));
  mounted = true;
  assert(updater.begin(UpdateOwner::Http, "sounds.json", 4097));
  const std::string validSounds = R"({"version":1,"sounds":{"copilotDone":[[50,0]],"copilotNeedsInput":[[50,0]],"monaPrAssigned":[[50,0]],"monaReviewRequested":[[50,0]],"monaWorkflow":[[50,0]],"monaSecurity":[[50,0]],"monaNotification":[[50,0]]}})";
  const auto original = std::make_shared<std::vector<uint8_t>>(std::initializer_list<uint8_t>{1, 2});
  SD_MMC.files["/sounds.json"] = original;
  assert(!updater.begin(UpdateOwner::Http, "sounds.json", 1));
  assert(!updater.write(UpdateOwner::Http, invalidImage, 1));
  assert(updater.commit(UpdateOwner::Http));
  assert(SD_MMC.files["/sounds.json"] == original);
  assert(!SD_MMC.exists("/.sounds.json.upload"));
  for (UpdateOwner owner : {UpdateOwner::Usb, UpdateOwner::Http}) {
    assert(!updater.begin(owner, "sounds.json", validSounds.size()));
    assert(!updater.write(owner, reinterpret_cast<const uint8_t *>(validSounds.data()), validSounds.size()));
    SD_MMC.failRenameFrom = "/.sounds.json.upload";
    assert(updater.commit(owner));
    assert(SD_MMC.files["/sounds.json"] == original);
    SD_MMC.failRenameFrom = "";
  }
  assert(!updater.begin(UpdateOwner::Http, "sounds.json", validSounds.size()));
  assert(!updater.write(UpdateOwner::Http, reinterpret_cast<const uint8_t *>(validSounds.data()), validSounds.size()));
  assert(!updater.commit(UpdateOwner::Http));
  assert(SD_MMC.files["/sounds.json"] != original);
  assert(!SD_MMC.exists("/.sounds.json.backup"));
  return 0;
}
