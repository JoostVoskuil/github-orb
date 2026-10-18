#include "board.h"

#include <SD_MMC.h>
#include <Wire.h>
#include <driver/spi_master.h>
#include <esp_lcd_panel_ops.h>
#include <esp_lcd_panel_rgb.h>
#include <freertos/semphr.h>

// Verified against Waveshare's ESP32-S3-Touch-LCD-2.1 board docs and Arduino demo.
// Source: https://files.waveshare.com/wiki/ESP32-S3-Touch-LCD-2.1/ESP32-S3-Touch-LCD-2.1-Demo.zip
namespace {
constexpr int kI2cSda = 15;
constexpr int kI2cScl = 7;
constexpr uint8_t kExpanderAddress = 0x20;
constexpr uint8_t kExpanderOutput = 0x01;
constexpr uint8_t kExpanderConfig = 0x03;
constexpr uint8_t kPanelReset = 1;
constexpr uint8_t kTouchReset = 2;
constexpr uint8_t kPanelCs = 3;
constexpr uint8_t kBuzzer = 8;
constexpr int kTouchInterrupt = 16;
constexpr uint8_t kTouchAddress = 0x15;
constexpr int kPanelClock = 2;
constexpr int kPanelMosi = 1;
constexpr int kSdClock = 2;
constexpr int kSdCommand = 1;
constexpr int kSdData0 = 42;
constexpr uint8_t kSdD3Enable = 4;
constexpr int kBacklight = 6;

constexpr int kHsync = 38;
constexpr int kVsync = 39;
constexpr int kDataEnable = 40;
constexpr int kPixelClock = 41;
constexpr int kRgbPins[16] = {5, 45, 48, 47, 21, 14, 13, 12, 11, 10, 9, 46, 3, 8, 18, 17};

struct LcdCommand {
  uint8_t command;
  uint8_t length;
  uint8_t data[16];
  uint16_t delayMs;
};

constexpr LcdCommand kInit[] = {
  {0xFF, 5, {0x77, 0x01, 0x00, 0x00, 0x10}, 0},
  {0xC0, 2, {0x3B, 0x00}, 0}, {0xC1, 2, {0x0B, 0x02}, 0}, {0xC2, 2, {0x07, 0x02}, 0},
  {0xCC, 1, {0x10}, 0}, {0xCD, 1, {0x08}, 0},
  {0xB0, 16, {0x00, 0x11, 0x16, 0x0E, 0x11, 0x06, 0x05, 0x09, 0x08, 0x21, 0x06, 0x13, 0x10, 0x29, 0x31, 0x18}, 0},
  {0xB1, 16, {0x00, 0x11, 0x16, 0x0E, 0x11, 0x07, 0x05, 0x09, 0x09, 0x21, 0x05, 0x13, 0x11, 0x2A, 0x31, 0x18}, 0},
  {0xFF, 5, {0x77, 0x01, 0x00, 0x00, 0x11}, 0},
  {0xB0, 1, {0x6D}, 0}, {0xB1, 1, {0x37}, 0}, {0xB2, 1, {0x81}, 0}, {0xB3, 1, {0x80}, 0},
  {0xB5, 1, {0x43}, 0}, {0xB7, 1, {0x85}, 0}, {0xB8, 1, {0x20}, 0},
  {0xC1, 1, {0x78}, 0}, {0xC2, 1, {0x78}, 0}, {0xD0, 1, {0x88}, 0},
  {0xE0, 3, {0x00, 0x00, 0x02}, 0},
  {0xE1, 11, {0x03, 0xA0, 0x00, 0x00, 0x04, 0xA0, 0x00, 0x00, 0x00, 0x20, 0x20}, 0},
  {0xE2, 13, {0}, 0}, {0xE3, 4, {0x00, 0x00, 0x11, 0x00}, 0}, {0xE4, 2, {0x22, 0x00}, 0},
  {0xE5, 16, {0x05, 0xEC, 0xA0, 0xA0, 0x07, 0xEE, 0xA0, 0xA0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}, 0},
  {0xE6, 4, {0x00, 0x00, 0x11, 0x00}, 0}, {0xE7, 2, {0x22, 0x00}, 0},
  {0xE8, 16, {0x06, 0xED, 0xA0, 0xA0, 0x08, 0xEF, 0xA0, 0xA0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}, 0},
  {0xEB, 7, {0x00, 0x00, 0x40, 0x40, 0x00, 0x00, 0x00}, 0},
  {0xED, 16, {0xFF, 0xFF, 0xFF, 0xBA, 0x0A, 0xBF, 0x45, 0xFF, 0xFF, 0x54, 0xFB, 0xA0, 0xAB, 0xFF, 0xFF, 0xFF}, 0},
  {0xEF, 6, {0x10, 0x0D, 0x04, 0x08, 0x3F, 0x1F}, 0},
  {0xFF, 5, {0x77, 0x01, 0x00, 0x00, 0x13}, 0}, {0xEF, 1, {0x08}, 0},
  {0xFF, 5, {0x77, 0x01, 0x00, 0x00, 0x00}, 0}, {0x36, 1, {0x00}, 0},
  {0x3A, 1, {0x66}, 0}, {0x11, 0, {}, 480}, {0x20, 0, {}, 120}, {0x29, 0, {}, 0}
};

esp_lcd_panel_handle_t panel;
spi_device_handle_t spi;
uint16_t *framebuffers[2] = {};
uint8_t drawBuffer = 0;
uint8_t expanderOutput = 0;

bool i2cWrite(uint8_t address, uint8_t reg, uint8_t value) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool setExpander(uint8_t pin, bool high) {
  const uint8_t mask = 1u << (pin - 1);
  expanderOutput = high ? expanderOutput | mask : expanderOutput & ~mask;
  return i2cWrite(kExpanderAddress, kExpanderOutput, expanderOutput);
}

bool sendCommand(uint8_t command, const uint8_t *data, uint8_t length) {
  spi_transaction_t transaction = {};
  transaction.cmd = 0;
  transaction.addr = command;
  if (spi_device_transmit(spi, &transaction) != ESP_OK) return false;
  for (uint8_t i = 0; i < length; i++) {
    transaction = {};
    transaction.cmd = 1;
    transaction.addr = data[i];
    if (spi_device_transmit(spi, &transaction) != ESP_OK) return false;
  }
  return true;
}

bool initCommandBus() {
  spi_bus_config_t bus = {};
  bus.mosi_io_num = kPanelMosi;
  bus.miso_io_num = -1;
  bus.sclk_io_num = kPanelClock;
  bus.quadwp_io_num = -1;
  bus.quadhd_io_num = -1;
  bus.max_transfer_sz = 64;
  if (spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO) != ESP_OK) return false;
  spi_device_interface_config_t device = {};
  device.command_bits = 1;
  device.address_bits = 8;
  device.mode = 0;
  device.clock_speed_hz = 40000000;
  device.spics_io_num = -1;
  device.queue_size = 1;
  return spi_bus_add_device(SPI2_HOST, &device, &spi) == ESP_OK;
}

bool initPanel() {
  setExpander(kPanelReset, false);
  delay(10);
  setExpander(kPanelReset, true);
  delay(50);
  if (!initCommandBus()) return false;
  setExpander(kPanelCs, false);
  delay(10);
  for (const auto &entry : kInit) {
    if (!sendCommand(entry.command, entry.data, entry.length)) return false;
    if (entry.delayMs) delay(entry.delayMs);
  }
  setExpander(kPanelCs, true);

  esp_lcd_rgb_panel_config_t config = {};
  config.clk_src = LCD_CLK_SRC_DEFAULT;
  config.timings.pclk_hz = 12000000;
  config.timings.h_res = Board::kWidth;
  config.timings.v_res = Board::kHeight;
  config.timings.hsync_pulse_width = 8;
  config.timings.hsync_back_porch = 10;
  config.timings.hsync_front_porch = 50;
  config.timings.vsync_pulse_width = 3;
  config.timings.vsync_back_porch = 8;
  config.timings.vsync_front_porch = 8;
  config.data_width = 16;
  config.bits_per_pixel = 16;
  config.num_fbs = 2;
  config.bounce_buffer_size_px = Board::kWidth * 10;
  config.psram_trans_align = 64;
  config.hsync_gpio_num = kHsync;
  config.vsync_gpio_num = kVsync;
  config.de_gpio_num = kDataEnable;
  config.pclk_gpio_num = kPixelClock;
  config.disp_gpio_num = -1;
  memcpy(config.data_gpio_nums, kRgbPins, sizeof(kRgbPins));
  config.flags.fb_in_psram = true;
  config.flags.double_fb = true;
  if (esp_lcd_new_rgb_panel(&config, &panel) != ESP_OK) return false;
  if (esp_lcd_panel_reset(panel) != ESP_OK || esp_lcd_panel_init(panel) != ESP_OK) return false;
  if (esp_lcd_rgb_panel_get_frame_buffer(panel, 2, reinterpret_cast<void **>(&framebuffers[0]), reinterpret_cast<void **>(&framebuffers[1])) != ESP_OK) return false;
  memset(framebuffers[0], 0, Board::kWidth * Board::kHeight * sizeof(uint16_t));
  memset(framebuffers[1], 0, Board::kWidth * Board::kHeight * sizeof(uint16_t));
  return true;
}

void initTouch() {
  pinMode(kTouchInterrupt, INPUT_PULLUP);
  setExpander(kTouchReset, false);
  delay(10);
  setExpander(kTouchReset, true);
  delay(50);
  i2cWrite(kTouchAddress, 0xFE, 0xFF);
}
}  // namespace

namespace Board {
bool begin() {
  Wire.begin(kI2cSda, kI2cScl);
  Wire.setClock(400000);
  if (!i2cWrite(kExpanderAddress, kExpanderConfig, 0x00)) return false;
  if (!i2cWrite(kExpanderAddress, kExpanderOutput, 0x00)) return false;
  setBuzzer(false);
  if (!initPanel()) return false;
  initTouch();
  ledcAttach(kBacklight, 20000, 10);
  setBrightness(0.5f);
  return true;
}

bool mountSdCard() {
  static bool mounted = false;
  static bool attempted = false;
  SdLock lock;
  if (mounted) return true;
  if (attempted) return false;
  attempted = true;
  if (!SD_MMC.setPins(kSdClock, kSdCommand, kSdData0, -1, -1, -1)) return false;
  if (!setExpander(kSdD3Enable, true)) return false;
  delay(10);
  mounted = SD_MMC.begin("/sdcard", true, false);
  return mounted;
}

bool sdMounted() {
  return mountSdCard();
}

namespace {
SemaphoreHandle_t sdMutex() {
  static SemaphoreHandle_t mutex = xSemaphoreCreateRecursiveMutex();
  return mutex;
}
}  // namespace

void lockSd() {
  if (SemaphoreHandle_t mutex = sdMutex()) xSemaphoreTakeRecursive(mutex, portMAX_DELAY);
}

void unlockSd() {
  if (SemaphoreHandle_t mutex = sdMutex()) xSemaphoreGiveRecursive(mutex);
}

uint16_t *backBuffer() { return framebuffers[drawBuffer]; }

bool present() {
  if (!panel || !framebuffers[drawBuffer]) return false;
  const bool ok = esp_lcd_panel_draw_bitmap(panel, 0, 0, kWidth, kHeight, framebuffers[drawBuffer]) == ESP_OK;
  drawBuffer ^= 1;
  return ok;
}

void setBrightness(float brightness) {
  brightness = constrain(brightness, 0.05f, 1.0f);
  ledcWrite(kBacklight, brightness >= 1.0f ? 1023 : static_cast<uint32_t>(brightness * 1023));
}

namespace {
bool readTouch(uint16_t *x, uint16_t *y) {
  uint8_t data[6] = {};
  Wire.beginTransmission(kTouchAddress);
  Wire.write(0x01);
  if (Wire.endTransmission(true) != 0 || Wire.requestFrom(kTouchAddress, static_cast<uint8_t>(sizeof(data))) != sizeof(data)) return false;
  for (uint8_t &value : data) value = Wire.read();
  if (!data[1]) return false;
  if (x) *x = static_cast<uint16_t>(((data[2] & 0x0f) << 8) | data[3]);
  if (y) *y = static_cast<uint16_t>(((data[4] & 0x0f) << 8) | data[5]);
  return true;
}
}  // namespace

bool touched() {
  return readTouch(nullptr, nullptr);
}

bool touchPoint(uint16_t &x, uint16_t &y) {
  return readTouch(&x, &y);
}

void setBuzzer(bool enabled) { setExpander(kBuzzer, enabled); }
}  // namespace Board