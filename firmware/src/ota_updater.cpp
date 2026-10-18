#include "ota_updater.h"

#include <SD_MMC.h>
#include <Update.h>

#include "board.h"

namespace {
constexpr char kFirmwarePath[] = "/firmware.bin";
constexpr char kBackupPath[] = "/firmware.bak";
constexpr size_t kMaxFirmwareBytes = 0x300000;

void archiveOrRemoveUpdateFile() {
  // Consume the image after either success or failure so a bad update is not retried on every boot.
  if (SD_MMC.exists(kBackupPath)) SD_MMC.remove(kBackupPath);
  if (!SD_MMC.rename(kFirmwarePath, kBackupPath)) {
    SD_MMC.remove(kFirmwarePath);
  }
}
}  // namespace

namespace OtaUpdater {

bool applySdUpdateIfPresent() {
  if (!Board::sdMounted()) return false;
  Board::SdLock lock;
  if (!SD_MMC.exists(kFirmwarePath)) return false;

  File file = SD_MMC.open(kFirmwarePath, FILE_READ);
  if (!file) return false;
  const size_t size = file.size();
  if (size == 0 || size > kMaxFirmwareBytes) {
    Serial.printf("SD OTA skipped: invalid /firmware.bin size (%u bytes)\n", static_cast<unsigned>(size));
    file.close();
    archiveOrRemoveUpdateFile();
    return false;
  }

  Serial.printf("SD OTA: applying /firmware.bin (%u bytes)\n", static_cast<unsigned>(size));
  if (!Update.begin(size, U_FLASH)) {
    Serial.printf("SD OTA begin failed: %s\n", Update.errorString());
    file.close();
    archiveOrRemoveUpdateFile();
    return false;
  }

  const size_t written = Update.writeStream(file);
  file.close();
  if (written != size || !Update.end(true)) {
    Serial.printf("SD OTA failed (%u/%u bytes): %s\n",
                  static_cast<unsigned>(written), static_cast<unsigned>(size), Update.errorString());
    Update.abort();
    archiveOrRemoveUpdateFile();
    return false;
  }

  archiveOrRemoveUpdateFile();
  Serial.println("SD OTA applied; restarting");
  delay(200);
  ESP.restart();
  return true;
}

}  // namespace OtaUpdater
