#include "renderer.h"

#include <ArduinoJson.h>
#include <SD_MMC.h>
#include <math.h>
#include <time.h>

#include "board.h"
#include "offline_indicator.h"
#include "ring_motion.h"
#include "sleeping_indicator.h"

namespace {
constexpr uint16_t kBlack = 0x0000;
constexpr uint32_t kBackground = 0x0d1117;
constexpr uint32_t kRingTrack = 0x30363d;
constexpr char kSoundPackPath[] = "/sounds.json";
constexpr const char *kSoundNames[] = {
  "copilotDone",
  "copilotNeedsInput",
  "monaPrAssigned",
  "monaReviewRequested",
  "monaWorkflow",
  "monaSecurity",
  "monaNotification"
};

uint32_t ringColor(Mood mood) {
  switch (mood) {
    case Mood::Idle: return 0x3fb950;
    case Mood::Thinking:
    case Mood::Tool: return 0x2f81f7;
    case Mood::NeedsInput: return 0xf0c020;
    case Mood::Done: return 0x3fb950;
    case Mood::Error:
    case Mood::WorkflowFailure:
    case Mood::SecurityAlert: return 0xf85149;
    case Mood::PrAssigned:
    case Mood::ReviewRequested: return 0xf0a020;
    case Mood::Disconnected: return 0x484f58;
  }
  return 0x484f58;
}

// Classic 5x7 column font for printable ASCII (0x20-0x7e); bit 0 is the top row.
const uint8_t kFont[95][5] = {
  {0x00, 0x00, 0x00, 0x00, 0x00}, {0x00, 0x00, 0x5f, 0x00, 0x00}, {0x00, 0x07, 0x00, 0x07, 0x00},
  {0x14, 0x7f, 0x14, 0x7f, 0x14}, {0x24, 0x2a, 0x7f, 0x2a, 0x12}, {0x23, 0x13, 0x08, 0x64, 0x62},
  {0x36, 0x49, 0x55, 0x22, 0x50}, {0x00, 0x05, 0x03, 0x00, 0x00}, {0x00, 0x1c, 0x22, 0x41, 0x00},
  {0x00, 0x41, 0x22, 0x1c, 0x00}, {0x14, 0x08, 0x3e, 0x08, 0x14}, {0x08, 0x08, 0x3e, 0x08, 0x08},
  {0x00, 0x50, 0x30, 0x00, 0x00}, {0x08, 0x08, 0x08, 0x08, 0x08}, {0x00, 0x60, 0x60, 0x00, 0x00},
  {0x20, 0x10, 0x08, 0x04, 0x02}, {0x3e, 0x51, 0x49, 0x45, 0x3e}, {0x00, 0x42, 0x7f, 0x40, 0x00},
  {0x42, 0x61, 0x51, 0x49, 0x46}, {0x21, 0x41, 0x45, 0x4b, 0x31}, {0x18, 0x14, 0x12, 0x7f, 0x10},
  {0x27, 0x45, 0x45, 0x45, 0x39}, {0x3c, 0x4a, 0x49, 0x49, 0x30}, {0x01, 0x71, 0x09, 0x05, 0x03},
  {0x36, 0x49, 0x49, 0x49, 0x36}, {0x06, 0x49, 0x49, 0x29, 0x1e}, {0x00, 0x36, 0x36, 0x00, 0x00},
  {0x00, 0x56, 0x36, 0x00, 0x00}, {0x08, 0x14, 0x22, 0x41, 0x00}, {0x14, 0x14, 0x14, 0x14, 0x14},
  {0x00, 0x41, 0x22, 0x14, 0x08}, {0x02, 0x01, 0x51, 0x09, 0x06}, {0x32, 0x49, 0x79, 0x41, 0x3e},
  {0x7e, 0x11, 0x11, 0x11, 0x7e}, {0x7f, 0x49, 0x49, 0x49, 0x36}, {0x3e, 0x41, 0x41, 0x41, 0x22},
  {0x7f, 0x41, 0x41, 0x22, 0x1c}, {0x7f, 0x49, 0x49, 0x49, 0x41}, {0x7f, 0x09, 0x09, 0x09, 0x01},
  {0x3e, 0x41, 0x49, 0x49, 0x7a}, {0x7f, 0x08, 0x08, 0x08, 0x7f}, {0x00, 0x41, 0x7f, 0x41, 0x00},
  {0x20, 0x40, 0x41, 0x3f, 0x01}, {0x7f, 0x08, 0x14, 0x22, 0x41}, {0x7f, 0x40, 0x40, 0x40, 0x40},
  {0x7f, 0x02, 0x0c, 0x02, 0x7f}, {0x7f, 0x04, 0x08, 0x10, 0x7f}, {0x3e, 0x41, 0x41, 0x41, 0x3e},
  {0x7f, 0x09, 0x09, 0x09, 0x06}, {0x3e, 0x41, 0x51, 0x21, 0x5e}, {0x7f, 0x09, 0x19, 0x29, 0x46},
  {0x46, 0x49, 0x49, 0x49, 0x31}, {0x01, 0x01, 0x7f, 0x01, 0x01}, {0x3f, 0x40, 0x40, 0x40, 0x3f},
  {0x1f, 0x20, 0x40, 0x20, 0x1f}, {0x3f, 0x40, 0x38, 0x40, 0x3f}, {0x63, 0x14, 0x08, 0x14, 0x63},
  {0x07, 0x08, 0x70, 0x08, 0x07}, {0x61, 0x51, 0x49, 0x45, 0x43}, {0x00, 0x7f, 0x41, 0x41, 0x00},
  {0x02, 0x04, 0x08, 0x10, 0x20}, {0x00, 0x41, 0x41, 0x7f, 0x00}, {0x04, 0x02, 0x01, 0x02, 0x04},
  {0x40, 0x40, 0x40, 0x40, 0x40}, {0x00, 0x01, 0x02, 0x04, 0x00}, {0x20, 0x54, 0x54, 0x54, 0x78},
  {0x7f, 0x48, 0x44, 0x44, 0x38}, {0x38, 0x44, 0x44, 0x44, 0x20}, {0x38, 0x44, 0x44, 0x48, 0x7f},
  {0x38, 0x54, 0x54, 0x54, 0x18}, {0x08, 0x7e, 0x09, 0x01, 0x02}, {0x0c, 0x52, 0x52, 0x52, 0x3e},
  {0x7f, 0x08, 0x04, 0x04, 0x78}, {0x00, 0x44, 0x7d, 0x40, 0x00}, {0x20, 0x40, 0x44, 0x3d, 0x00},
  {0x7f, 0x10, 0x28, 0x44, 0x00}, {0x00, 0x41, 0x7f, 0x40, 0x00}, {0x7c, 0x04, 0x18, 0x04, 0x78},
  {0x7c, 0x08, 0x04, 0x04, 0x78}, {0x38, 0x44, 0x44, 0x44, 0x38}, {0x7c, 0x14, 0x14, 0x14, 0x08},
  {0x08, 0x14, 0x14, 0x18, 0x7c}, {0x7c, 0x08, 0x04, 0x04, 0x08}, {0x48, 0x54, 0x54, 0x54, 0x20},
  {0x04, 0x3f, 0x44, 0x40, 0x20}, {0x3c, 0x40, 0x40, 0x20, 0x7c}, {0x1c, 0x20, 0x40, 0x20, 0x1c},
  {0x3c, 0x40, 0x30, 0x40, 0x3c}, {0x44, 0x28, 0x10, 0x28, 0x44}, {0x0c, 0x50, 0x50, 0x50, 0x3c},
  {0x44, 0x64, 0x54, 0x4c, 0x44}, {0x00, 0x08, 0x36, 0x41, 0x00}, {0x00, 0x00, 0x7f, 0x00, 0x00},
  {0x00, 0x41, 0x36, 0x08, 0x00}, {0x08, 0x04, 0x08, 0x10, 0x08}
};

// One glyph per UTF-8 code point; anything outside printable ASCII renders as '?'.
const uint8_t *glyph(unsigned char character) {
  if (character < 0x20 || character > 0x7e) character = '?';
  return kFont[character - 0x20];
}

constexpr int kCenter = 240;
// Shared with the simulator face: split-ring hit radius and card geometry.
constexpr int kArcHitRadius = 175;
constexpr uint32_t kAmber = 0xf0a020;

void formatAgo(uint32_t seconds, char *out, size_t size) {
  if (seconds < 60) snprintf(out, size, "just now");
  else if (seconds < 3600) snprintf(out, size, "%lum ago", static_cast<unsigned long>(seconds / 60));
  else snprintf(out, size, "%luh ago", static_cast<unsigned long>(seconds / 3600));
}

void formatDuration(uint32_t seconds, char *out, size_t size) {
  if (seconds < 60) snprintf(out, size, "%lus", static_cast<unsigned long>(seconds));
  else if (seconds < 3600) snprintf(out, size, "%lum %lus", static_cast<unsigned long>(seconds / 60), static_cast<unsigned long>(seconds % 60));
  else snprintf(out, size, "%luh %lum", static_cast<unsigned long>(seconds / 3600), static_cast<unsigned long>(seconds / 60 % 60));
}

void formatCount(uint32_t value, char *out, size_t size) {
  if (value < 1000) snprintf(out, size, "%lu", static_cast<unsigned long>(value));
  else if (value < 10000) snprintf(out, size, "%lu.%luk", static_cast<unsigned long>(value / 1000), static_cast<unsigned long>(value / 100 % 10));
  else if (value < 1000000) snprintf(out, size, "%luk", static_cast<unsigned long>(value / 1000));
  else snprintf(out, size, "%lu.%luM", static_cast<unsigned long>(value / 1000000), static_cast<unsigned long>(value / 100000 % 10));
  const size_t length = strlen(out);
  if (length > 3 && !strncmp(out + length - 3, ".0k", 3)) memmove(out + length - 3, "k", 2);
  else if (length > 3 && !strncmp(out + length - 3, ".0M", 3)) memmove(out + length - 3, "M", 2);
}

// Copies at most maxColumns code points, ending with ".." when shortened.
void fitColumns(const char *text, size_t maxColumns, char *out, size_t size) {
  size_t used = 0, count = 0;
  const char *p = text;
  while (*p && count < maxColumns) {
    const char *start = p++;
    while ((*p & 0xc0) == 0x80) p++;
    const size_t length = p - start;
    if (used + length + 1 > size) break;
    memcpy(out + used, start, length);
    used += length;
    count++;
  }
  out[used] = '\0';
  if (*p && maxColumns >= 3) {
    // Remove the last code point(s) to make room for "..".
    size_t keep = 0, columns = 0;
    for (const char *q = out; *q && columns < maxColumns - 2;) {
      const char *start = q++;
      while ((*q & 0xc0) == 0x80) q++;
      keep += q - start;
      columns++;
    }
    out[keep] = '\0';
    strlcat(out, "..", size);
  }
}

constexpr int kApprovalX = 56, kApprovalY = 76, kApprovalW = 368, kApprovalH = 328;
constexpr int kSessionX = 56, kSessionY = 86, kSessionW = 368, kSessionH = 308;
}

uint16_t Renderer::color565(uint32_t rgb) {
  return ((rgb >> 19) & 0x1f) << 11 | ((rgb >> 10) & 0x3f) << 5 | ((rgb >> 3) & 0x1f);
}

bool Renderer::begin() {
  state_.mood = Mood::Disconnected;
  if (!Board::mountSdCard()) {
    Serial.println("Animation SD card mount failed");
    return false;
  }
  {
    Board::SdLock lock;
    assetsReady_ = pack_.begin(SD_MMC);
  }
  Serial.println(assetsReady_ ? "Animation assets: SD card ready" : "Animation assets: missing or invalid on SD card");
  soundPatternsReady_ = loadSoundPatterns();
  Serial.println(soundPatternsReady_ ? "Notification sounds: SD card ready" : "Notification sounds: missing or invalid on SD card");
  return assetsReady_;
}

bool Renderer::loadSoundPatterns() {
  Board::SdLock lock;
  File file = SD_MMC.open(kSoundPackPath, FILE_READ);
  if (!file) {
    Serial.printf("Notification sounds: could not open %s\n", kSoundPackPath);
    return false;
  }

  JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, file);
  file.close();
  if (error) {
    Serial.printf("Notification sounds: invalid JSON: %s\n", error.c_str());
    return false;
  }
  if (doc["version"].as<uint8_t>() != 1) {
    Serial.println("Notification sounds: unsupported version");
    return false;
  }

  JsonObjectConst sounds = doc["sounds"].as<JsonObjectConst>();
  for (uint8_t i = 0; i < static_cast<uint8_t>(SoundId::Count); i++) {
    JsonArrayConst pulses = sounds[kSoundNames[i]].as<JsonArrayConst>();
    SoundPattern &pattern = soundPatterns_[i];
    if (pulses.isNull() || pulses.size() == 0 || pulses.size() > 4) {
      Serial.printf("Notification sounds: invalid pattern %s\n", kSoundNames[i]);
      return false;
    }
    uint16_t totalMs = 0;
    for (JsonVariantConst pulseValue : pulses) {
      JsonArrayConst pulse = pulseValue.as<JsonArrayConst>();
      if (pulse.size() != 2 || !pulse[0].is<uint16_t>() || !pulse[1].is<uint16_t>()) {
        Serial.printf("Notification sounds: invalid pulse in %s\n", kSoundNames[i]);
        return false;
      }
      const uint16_t onMs = pulse[0].as<uint16_t>();
      const uint16_t gapMs = pulse[1].as<uint16_t>();
      if (onMs < 30 || onMs > 180 || gapMs > 120) {
        Serial.printf("Notification sounds: pulse out of range in %s\n", kSoundNames[i]);
        return false;
      }
      totalMs += onMs + gapMs;
      if (totalMs > 700) {
        Serial.printf("Notification sounds: pattern too long %s\n", kSoundNames[i]);
        return false;
      }
      pattern.onMs[pattern.pulseCount] = onMs;
      pattern.gapMs[pattern.pulseCount] = gapMs;
      pattern.pulseCount++;
    }
  }
  return true;
}

void Renderer::setState(const OrbState &state) {
  const OrbState previous = state_;
  const int previousOverlay = sessionIndex(overlaySource_, overlaySession_);
  const bool overlayWasWorking = previousOverlay >= 0 && !state_.sessions[previousOverlay].backgroundOnly;
  incoming_ = state;
  keepWorkingSessions(incoming_, millis());
  state_ = incoming_;
  if (overlay_ != OverlayMode::None && overlay_ != OverlayMode::Notification &&
      (sessionIndex(overlaySource_, overlaySession_) < 0 ||
       (overlayWasWorking && state_.sessions[sessionIndex(overlaySource_, overlaySession_)].backgroundOnly))) overlay_ = OverlayMode::None;
  if (overlay_ == OverlayMode::Notification &&
      (!state_.mona || strcmp(state_.alert.id, overlayAlertId_))) overlay_ = OverlayMode::None;
  const uint32_t now = millis();
  carousel_.update(incoming_, now, state_.mona || state_.copilotNotification || state_.mood == Mood::Disconnected || overlay_ != OverlayMode::None);
  const int selected = carousel_.selected(incoming_);
  if (selected >= 0 && !state_.mona && !state_.copilotNotification && state_.mood != Mood::Disconnected) {
    const auto &info = state_.sessions[selected];
    state_.primarySession = selected;
    state_.presentationId = previous.presentationId;
    state_.mood = info.closed || info.state == Mood::Idle ? Mood::Done : info.state;
    strlcpy(state_.clip, info.closed || info.state == Mood::Idle ? "idle" : moodName(state_.mood), sizeof(state_.clip));
    strlcpy(state_.tool, info.tool, sizeof(state_.tool));
    strlcpy(state_.task, state_.mood == Mood::Thinking ? activityLabel(info.activity) : moodName(state_.mood), sizeof(state_.task));
    setMoodRingDefaults(state_);
  }
  const bool changed = !stateReceived_ || presentationChanged(previous, state_) || (!state_.mona && (
    strcmp(previous.sessions[previous.primarySession].sessionId, state_.sessions[state_.primarySession].sessionId) ||
    strcmp(previous.sessions[previous.primarySession].source, state_.sessions[state_.primarySession].source) ||
    (selected >= 0 && state_.sessions[selected].state != Mood::Idle &&
     previous.sessions[previous.primarySession].stateSinceMs != state_.sessions[selected].stateSinceMs)));
  stateReceived_ = true;
  Board::setBrightness(state_.settings.brightness * (state_.mood == Mood::Idle ? 0.6f : state_.mood == Mood::Disconnected ? 0.4f : 1.0f));
  if (changed) {
    clipStartedMs_ = millis();
    clip_ = {};
    {
      Board::SdLock lock;
      clipReady_ = assetsReady_ && pack_.findClip(stateClip(state_), clip_);
    }
    if (assetsReady_ && !clipReady_) Serial.printf("Animation clip missing: %s\n", stateClip(state_));
    triggerSound(state_.mood);
  }
  forceRender_ = true;
}

void Renderer::loop() {
  const uint32_t now = millis();
  updateSound(now);
  for (uint8_t i = 0; i < incoming_.sessionInfoCount; i++) {
    if (incoming_.sessions[i].backgroundOnly && now - incoming_.sessions[i].endedAtMs >= 120000UL) {
      setState(incoming_);
      break;
    }
  }
  if (overlay_ != OverlayMode::None && overlay_ != OverlayMode::Notification &&
      static_cast<int32_t>(overlayUntilMs_ - now) <= 0) {
    overlay_ = OverlayMode::None;
    pressActive_ = false;
    forceRender_ = true;
  }
  if (carousel_.update(incoming_, now, state_.mona || state_.copilotNotification || state_.mood == Mood::Disconnected || overlay_ != OverlayMode::None))
    setState(incoming_);
  const uint32_t interval = clip_.fps100 ? 100000 / clip_.fps100 : 83;
  if (forceRender_ || now - lastFrameMs_ >= interval) render(now);
  if (!state_.mona && state_.mood == Mood::NeedsInput &&
      now - lastInputReminderMs_ >= 30000) {
    lastInputReminderMs_ = now;
    triggerSound(Mood::NeedsInput);
  }
}

void Renderer::render(uint32_t now) {
  uint16_t *buffer = Board::backBuffer();
  if (!buffer) return;
  drawBackground(buffer, now);
  bool rendered = false;
  const bool showAvatar = state_.mona || state_.mood == Mood::Idle || state_.mood == Mood::Done ||
    state_.copilotNotification || state_.sessionInfoCount > 0;
  const bool carousel = splitRing() && state_.sessionInfoCount > 1;
  if (carousel) {
    drawCarousel(buffer, now);
    rendered = true;
  } else if (showAvatar && clipReady_ && clip_.frameCount) {
    const uint32_t elapsed = now - clipStartedMs_;
    uint32_t frame = static_cast<uint64_t>(elapsed) * clip_.fps100 / 100000;
    if (clip_.loop) frame %= clip_.frameCount;
    else frame = min<uint32_t>(frame, clip_.frameCount - 1);
    {
      Board::SdLock lock;
      rendered = pack_.drawFrame(clip_, frame, buffer, Board::kWidth, Board::kHeight, (Board::kWidth - pack_.width()) / 2, 62);
    }
    if (!rendered) {
      Serial.printf("Animation frame read/decode failed: %s frame %lu\n", clip_.name, static_cast<unsigned long>(frame));
      clipReady_ = false;
      drawBackground(buffer, now); // Discard any partially decoded frame.
    }
  }
  if (!rendered && state_.mona) drawMona(buffer);
  else if (!rendered && showAvatar) drawCopilot(buffer, {240, 246, 320}, state_.mood);
  if (state_.mood == Mood::Idle || (state_.mood == Mood::Done && strcmp(stateClip(state_), "done"))) drawSleepingIndicator(buffer, Board::kWidth, Board::kHeight, now - clipStartedMs_);
  drawTopBadge(buffer);
  if (splitRing()) drawCaption(buffer);
  else drawLabel(buffer);
  drawOverlay(buffer, now);
  if (state_.mood == Mood::Disconnected) drawOfflineIndicator(buffer, Board::kWidth, Board::kHeight, color565(0x8b949e));
  Board::present();
  renderedMood_ = state_.mood;
  lastFrameMs_ = now;
  forceRender_ = false;
  if (carousel) {
    const uint32_t duration = millis() - now;
    carouselRenderMs_ += duration;
    carouselMaxMs_ = max(carouselMaxMs_, duration);
    if (++carouselFrames_ == 120) {
      Serial.printf("Session carousel: %u avatars, render avg %lu ms, max %lu ms (12 fps budget: 83 ms)\n",
        state_.sessionInfoCount, static_cast<unsigned long>(carouselRenderMs_ / carouselFrames_),
        static_cast<unsigned long>(carouselMaxMs_));
      carouselFrames_ = carouselRenderMs_ = carouselMaxMs_ = 0;
    }
  }
}

void Renderer::drawCarousel(uint16_t *buffer, uint32_t now) {
  for (uint8_t i = 0; i < state_.sessionInfoCount; i++) {
    const auto &info = state_.sessions[i];
    const Mood mood = info.closed || info.state == Mood::Idle ? Mood::Done : info.state;
    const bool resting = info.closed || info.state == Mood::Idle;
    Avatar &avatar = avatars_[i];
    if (strcmp(avatar.source, info.source) || strcmp(avatar.session, info.sessionId) || avatar.mood != mood ||
        avatar.resting != resting) {
      strlcpy(avatar.source, info.source, sizeof(avatar.source));
      strlcpy(avatar.session, info.sessionId, sizeof(avatar.session));
      avatar.mood = mood;
      avatar.resting = resting;
      avatar.startedMs = now;
      Board::SdLock lock;
      avatar.ready = assetsReady_ && pack_.findClip(resting ? "idle" : moodName(mood), avatar.clip);
      if (assetsReady_ && !avatar.ready) Serial.printf("Animation clip missing: %s\n", moodName(mood));
    }
  }
  // Only the selected session is drawn, always at the front pose.
  const int selected = carousel_.selected(incoming_);
  for (uint8_t depth = 0; depth < 1 && selected >= 0; depth++) {
    const uint8_t index = selected;
    Avatar &avatar = avatars_[index];
    const SessionCarousel::Pose pose{240, 246, 320};
    bool rendered = false;
    if (avatar.ready) {
      uint32_t frame = static_cast<uint64_t>(now - avatar.startedMs) * avatar.clip.fps100 / 100000;
      frame = avatar.clip.loop ? frame % avatar.clip.frameCount : min<uint32_t>(frame, avatar.clip.frameCount - 1);
      {
        Board::SdLock lock;
        rendered = pack_.drawFrame(avatar.clip, frame, buffer, Board::kWidth, Board::kHeight,
          lroundf(pose.x - pose.size / 2), lroundf(pose.y - pose.size / 2), lroundf(pose.size));
      }
      if (!rendered) {
        Serial.printf("Animation frame read/decode failed: %s frame %lu\n", avatar.clip.name, static_cast<unsigned long>(frame));
        avatar.ready = false;
        // Remove partial pixels and redraw the complete scene with this avatar's fallback.
        drawBackground(buffer, now);
        drawCarousel(buffer, now);
        return;
      }
    }
    if (!rendered) drawCopilot(buffer, pose, avatar.mood);
  }
}

void Renderer::drawCopilot(uint16_t *buffer, const SessionCarousel::Pose &pose, Mood mood) {
  const float scale = pose.size / 320;
  auto rect = [&](int x, int y, int w, int h, int radius, uint32_t color) {
    fillRoundRect(buffer, lroundf(pose.x + x * scale), lroundf(pose.y + y * scale),
      lroundf(w * scale), lroundf(h * scale), lroundf(radius * scale), color565(color));
  };
  rect(-120, -94, 240, 188, 45, 0xc9b8f5);
  rect(-104, -64, 208, 124, 30, 0x2f81f7);
  rect(-94, -54, 188, 104, 24, 0x0d1740);
  const bool flat = mood == Mood::Done || mood == Mood::Idle || mood == Mood::Disconnected;
  rect(-62, flat ? -5 : -22, 32, flat ? 9 : 42, 8, 0x56dfff);
  rect(30, flat ? -5 : -22, 32, flat ? 9 : 42, 8, 0x56dfff);
  if (mood == Mood::Error) {
    rect(-51, -30, 9, 58, 3, 0x56dfff);
    rect(42, -30, 9, 58, 3, 0x56dfff);
  }
}

void Renderer::drawBackground(uint16_t *buffer, uint32_t now) {
  const uint16_t background = color565(kBackground);
  const int outer = 234;
  const int center = Board::kWidth / 2;
  for (int y = 0; y < Board::kHeight; y++) {
    const int dy = y - center;
    for (int x = 0; x < Board::kWidth; x++) {
      const int dx = x - center;
      const int distance = dx * dx + dy * dy;
      buffer[y * Board::kWidth + x] = distance <= outer * outer ? background : kBlack;
    }
  }
  if (splitRing()) drawSessionArcs(buffer, now);
  else drawProgressRing(buffer, now);
}

void Renderer::drawDot(uint16_t *buffer, int dotX, int dotY, uint16_t color) {
  constexpr int kDotRadius = 4;
  for (int dy = -kDotRadius; dy <= kDotRadius; dy++) {
    for (int dx = -kDotRadius; dx <= kDotRadius; dx++) {
      if (dx * dx + dy * dy > kDotRadius * kDotRadius) continue;
      const int x = dotX + dx;
      const int y = dotY + dy;
      if (x >= 0 && x < Board::kWidth && y >= 0 && y < Board::kHeight) buffer[y * Board::kWidth + x] = color;
    }
  }
}

void Renderer::drawProgressRing(uint16_t *buffer, uint32_t now) {
  constexpr uint8_t kDotCount = 72;
  constexpr int kRadius = 230;
  const int centerX = Board::kWidth / 2;
  const int centerY = Board::kHeight / 2;
  for (uint8_t i = 0; i < kDotCount; i++) {
    const float angle = i * (2.0f * PI / kDotCount);
    const int dotX = centerX + static_cast<int>(lroundf(cosf(angle) * kRadius));
    const int dotY = centerY + static_cast<int>(lroundf(sinf(angle) * kRadius));
    drawDot(buffer, dotX, dotY, color565(kRingTrack));
  }
}

bool Renderer::splitRing() const {
  return !state_.mona && !state_.copilotNotification && state_.mood != Mood::Disconnected && state_.sessionInfoCount > 0;
}

uint32_t Renderer::sessionColor(const OrbState::SessionInfo &info) const {
  return info.closed ? 0x3fb950 : ringColor(info.state);
}

void Renderer::drawSessionArcs(uint16_t *buffer, uint32_t now) {
  constexpr uint8_t kDotCount = 72;
  constexpr int kRadius = 230;
  const uint8_t count = state_.sessionInfoCount;
  constexpr uint8_t span = kDotCount / OrbState::kMaxSessionInfos;
  for (uint8_t i = 0; i < kDotCount; i++) {
    const uint8_t fromTop = (i + kDotCount - 54) % kDotCount;
    const uint8_t position = (fromTop + span / 2) % kDotCount;
    const uint8_t slot = position / span;
    const uint8_t within = position % span;
    if (within == 0) continue;
    const bool asking = slot < count && !state_.sessions[slot].closed && state_.sessions[slot].state == Mood::NeedsInput;
    const bool running = slot < count && !state_.sessions[slot].closed &&
      (state_.sessions[slot].state == Mood::Thinking || state_.sessions[slot].state == Mood::Tool);
    const uint32_t rgb = slot >= count || (asking && (now / 500) % 2) ||
      (running && !runningSessionDot(within - 1, now))
      ? kRingTrack : sessionColor(state_.sessions[slot]);
    const float angle = i * (2.0f * PI / kDotCount);
    drawDot(buffer, kCenter + static_cast<int>(lroundf(cosf(angle) * kRadius)),
            kCenter + static_cast<int>(lroundf(sinf(angle) * kRadius)), color565(rgb));
  }
  for (uint8_t slot = 0; slot < count; slot++) {
    const auto &info = state_.sessions[slot];
    if (info.closed || info.state != Mood::NeedsInput) continue;
    const float angle = -PI / 2 + slot * 2.0f * PI / OrbState::kMaxSessionInfos;
    const int x = kCenter + lroundf(cosf(angle) * kRadius);
    const int y = kCenter + lroundf(sinf(angle) * kRadius);
    fillRoundRect(buffer, x - 10, y - 15, 20, 30, 0, color565(kBackground));
    drawText(buffer, x - 7, y - 10, "?", color565((now / 500) % 2 ? kRingTrack : sessionColor(info)), 3);
  }
}

void Renderer::drawMona(uint16_t *buffer) {
  // Cat ears, oval head and four curled arms: compact identity-only fallback.
  const uint16_t shell = color565(0xc9b8f5);
  const uint16_t face = color565(kBackground);
  const uint16_t eye = color565(0xf0f6fc);
  auto ellipse = [&](int cx, int cy, int rx, int ry, uint16_t color) {
    for (int y = -ry; y <= ry; y++) for (int x = -rx; x <= rx; x++) {
      if (x * x * ry * ry + y * y * rx * rx > rx * rx * ry * ry) continue;
      const int px = cx + x, py = cy + y;
      if (px >= 0 && px < Board::kWidth && py >= 0 && py < Board::kHeight) buffer[py * Board::kWidth + px] = color;
    }
  };
  for (int side : {-1, 1}) {
    for (int y = 102; y <= 175; y++) {
      const int half = (y - 102) / 3;
      for (int x = -half; x <= half; x++) buffer[y * Board::kWidth + 240 + side * 70 + x] = shell;
    }
  }
  for (int arm : {-66, -22, 22, 66}) {
    for (int step = 0; step <= 60; step += 4) {
      ellipse(240 + arm + arm * step / 100, 275 + step - step * step / 100, 11, 11, shell);
    }
  }
  ellipse(240, 210, 100, 86, shell);
  ellipse(240, 215, 70, 54, face);
  ellipse(213, 211, 10, 18, eye);
  ellipse(267, 211, 10, 18, eye);
}

void Renderer::fillRoundRect(uint16_t *buffer, int x, int y, int w, int h, int r, uint16_t color) {
  for (int row = 0; row < h; row++) for (int col = 0; col < w; col++) {
    const int cx = col < r ? r - col : col >= w - r ? col - (w - r - 1) : 0;
    const int cy = row < r ? r - row : row >= h - r ? row - (h - r - 1) : 0;
    if (cx * cx + cy * cy > r * r) continue;
    const int px = x + col, py = y + row;
    if (px >= 0 && px < Board::kWidth && py >= 0 && py < Board::kHeight) buffer[py * Board::kWidth + px] = color;
  }
}

void Renderer::drawCard(uint16_t *buffer, const Box &box, uint32_t border) {
  // Large corner radius keeps the card inside the round display.
  fillRoundRect(buffer, box.x, box.y, box.w, box.h, 56, color565(border));
  fillRoundRect(buffer, box.x + 4, box.y + 4, box.w - 8, box.h - 8, 52, color565(kBackground));
}

void Renderer::drawTopBadge(uint16_t *buffer) {
  if (state_.mona) {
    for (int y = -7; y <= 7; y++) for (int x = -7; x <= 7; x++) if (x * x + y * y <= 49) buffer[(34 + y) * Board::kWidth + 240 + x] = color565(0xf0f6fc);
    return; // GitHub source, not the underlying Copilot session sources.
  }
}

void Renderer::sessionStatus(const OrbState::SessionInfo &info, uint32_t now, char *out, size_t size) const {
  char ago[16];
  formatAgo((now - info.endedAtMs) / 1000, ago, sizeof(ago));
  if (info.closed) {
    snprintf(out, size, "Closed %s", ago);
    return;
  }
  switch (info.state) {
    case Mood::NeedsInput:
      if (info.attention.active && displayOnlyAttention(info.attention.kind)) snprintf(out, size, "%s", attentionHeading(info.attention.kind));
      else if (info.attention.active) snprintf(out, size, "%s", "Needs approval");
      else if (info.tool[0]) snprintf(out, size, "Approve %s?", info.tool);
      else snprintf(out, size, "Needs input");
      return;
    case Mood::Tool: snprintf(out, size, "Executing %s", info.tool[0] ? info.tool : "tool"); return;
    case Mood::Thinking: snprintf(out, size, "%s", activityLabel(info.activity)); return;
    case Mood::Done: snprintf(out, size, "Done"); return;
    case Mood::Error: snprintf(out, size, "Error"); return;
    default:
      if (info.finished) snprintf(out, size, "Done %s", ago);
      else snprintf(out, size, "Idle");
      return;
  }
}

void Renderer::drawCaption(uint16_t *buffer) {
  if (state_.primarySession >= state_.sessionInfoCount) return;
  const OrbState::SessionInfo &info = state_.sessions[state_.primarySession];
  char status[48];
  if (info.closed || info.state == Mood::Idle) strlcpy(status, "Done", sizeof(status));
  else if (info.state == Mood::Tool) strlcpy(status, "Executing", sizeof(status));
  else if (info.state == Mood::NeedsInput) strlcpy(status, "Ask", sizeof(status));
  else sessionStatus(info, millis(), status, sizeof(status));
  drawCentered(buffer, 54, status, color565(sessionColor(info)), 3, 300);
  if (info.tool[0] && !info.closed) drawCentered(buffer, 84, info.tool, color565(0x8b949e), 2, 270);
  drawWrapped(buffer, 398, info.name, color565(0xc9d1d9), 2, 250, 2);
}

int Renderer::sessionIndex(const char *source, const char *sessionId) const {
  for (uint8_t i = 0; i < state_.sessionInfoCount; i++) {
    if (!strcmp(state_.sessions[i].source, source) && !strcmp(state_.sessions[i].sessionId, sessionId)) return i;
  }
  return -1;
}

int Renderer::arcSlot(int x, int y) const {
  const int dx = x - kCenter, dy = y - kCenter;
  const uint8_t count = state_.sessionInfoCount;
  const int radiusSquared = dx * dx + dy * dy;
  if (!count || radiusSquared < kArcHitRadius * kArcHitRadius || radiusSquared > kCenter * kCenter) return -1;
  const float span = 2.0f * PI / OrbState::kMaxSessionInfos;
  const float angle = fmodf(atan2f(dy, dx) + PI / 2 + 2.0f * PI, 2.0f * PI);
  const int slot = static_cast<int>((angle + span / 2) / span) % OrbState::kMaxSessionInfos;
  return slot < count ? slot : -1;
}

void Renderer::open(uint8_t index, uint32_t now) {
  const OrbState::SessionInfo &info = state_.sessions[index];
  const bool approval = info.state == Mood::NeedsInput && info.attention.active;
  overlay_ = approval ? OverlayMode::Approval : OverlayMode::Session;
  strlcpy(overlaySession_, info.sessionId, sizeof(overlaySession_));
  strlcpy(overlaySource_, info.source, sizeof(overlaySource_));
  overlayUntilMs_ = now + (approval ? 30000 : 10000);
  forceRender_ = true;
}

void Renderer::tap(uint16_t x, uint16_t y, uint32_t now) {
  if (state_.mona && state_.alert.id[0]) {
    const Box card{kApprovalX, kApprovalY, kApprovalW, kApprovalH};
    if (overlay_ != OverlayMode::Notification) {
      overlay_ = OverlayMode::Notification;
      strlcpy(overlayAlertId_, state_.alert.id, sizeof(overlayAlertId_));
    } else if (card.contains(x, y)) {
      strlcpy(pendingAlertId_, overlayAlertId_, sizeof(pendingAlertId_));
      overlay_ = OverlayMode::None;
    } else {
      overlay_ = OverlayMode::None;
    }
    forceRender_ = true;
    return;
  }
  if (state_.mona || state_.copilotNotification || state_.mood == Mood::Disconnected || !state_.sessionInfoCount) return;
  const int arc = arcSlot(x, y);
  const int slot = arc;
  if (slot >= 0) {
    if (state_.sessions[slot].backgroundOnly || carousel_.selected(incoming_) == slot) open(slot, now);
    else {
      carousel_.select(incoming_, slot, now, true);
      overlay_ = OverlayMode::None;
      setState(incoming_);
    }
    return;
  }
  if (overlay_ != OverlayMode::None) {
    const Box card = overlay_ == OverlayMode::Approval ? Box{kApprovalX, kApprovalY, kApprovalW, kApprovalH}
                                                       : Box{kSessionX, kSessionY, kSessionW, kSessionH};
    const int index = sessionIndex(overlaySource_, overlaySession_);
    if (!card.contains(x, y) || index < 0) {
      overlay_ = OverlayMode::None;
      forceRender_ = true;
      return;
    }
    open((index + 1) % state_.sessionInfoCount, now);
    return;
  }
  open(state_.primarySession < state_.sessionInfoCount ? state_.primarySession : 0, now);
}

bool Renderer::takeAlertAcknowledgement(char *id, size_t size) {
  if (!pendingAlertId_[0] || !id || size < sizeof(pendingAlertId_)) return false;
  strlcpy(id, pendingAlertId_, size);
  pendingAlertId_[0] = '\0';
  return true;
}

void Renderer::touch(bool down, uint16_t x, uint16_t y, uint32_t now) {
  if (down && !touching_) {
    touching_ = true;
    pointerDown(x, y, now);
  } else if (!down && touching_) {
    touching_ = false;
    pointerUp(now);
  }
}

void Renderer::pointerDown(uint16_t x, uint16_t y, uint32_t now) {
  pressActive_ = true;
  pressX_ = x;
  pressY_ = y;
  pressAtMs_ = now;
}

void Renderer::pointerUp(uint32_t now) {
  if (!pressActive_) return;
  pressActive_ = false;
  forceRender_ = true;
  if (now - pressAtMs_ < 800) tap(pressX_, pressY_, now);
}

void Renderer::drawOverlay(uint16_t *buffer, uint32_t now) {
  if (overlay_ == OverlayMode::None) return;
  if (overlay_ == OverlayMode::Notification) {
    if (!state_.mona || strcmp(state_.alert.id, overlayAlertId_)) {
      overlay_ = OverlayMode::None;
      return;
    }
    for (int i = 0; i < Board::kWidth * Board::kHeight; i++) buffer[i] = (buffer[i] >> 2) & 0x39E7;
    drawNotificationCard(buffer);
    return;
  }
  const int index = sessionIndex(overlaySource_, overlaySession_);
  const bool stale = index < 0 || state_.mona || state_.mood == Mood::Disconnected ||
    (overlay_ == OverlayMode::Approval &&
     (state_.sessions[index].state != Mood::NeedsInput || !state_.sessions[index].attention.active));
  if (stale) {
    overlay_ = OverlayMode::None;
    pressActive_ = false;
    return;
  }
  // Dim the whole face (and caption) so the card never competes with it.
  for (int i = 0; i < Board::kWidth * Board::kHeight; i++) buffer[i] = (buffer[i] >> 2) & 0x39E7;
  drawSessionArcs(buffer, now);
  if (overlay_ == OverlayMode::Approval) drawApprovalCard(buffer, state_.sessions[index]);
  else drawSessionCard(buffer, state_.sessions[index], now);
}

void Renderer::drawNotificationCard(uint16_t *buffer) {
  const uint16_t foreground = color565(0xf0f6fc);
  const uint16_t muted = color565(0x8b949e);
  const uint32_t accent = ringColor(state_.mood);
  drawCard(buffer, Box{kApprovalX, kApprovalY, kApprovalW, kApprovalH}, accent);
  drawCentered(buffer, kApprovalY + 28, state_.task, color565(accent), 2, 312);
  char metadata[96];
  const char *separator = strchr(state_.alert.repository, '/');
  const char *ownerLabel = state_.alert.ownerIsOrganization ? "Organization" : "Owner";
  const int ownerLength = separator ? static_cast<int>(separator - state_.alert.repository) : static_cast<int>(strlen(state_.alert.repository));
  snprintf(metadata, sizeof(metadata), "%s: %.*s", ownerLabel, ownerLength, state_.alert.repository);
  drawCentered(buffer, kApprovalY + 58, metadata, muted, 1, 340);
  snprintf(metadata, sizeof(metadata), "Repository: %s", separator ? separator + 1 : "");
  drawCentered(buffer, kApprovalY + 76, metadata, muted, 1, 340);
  drawWrapped(buffer, kApprovalY + 103, state_.alert.title, foreground, 2, 312, 3);
  drawCentered(buffer, kApprovalY + 250, "Tap card to dismiss", muted, 2, 312);
}

void Renderer::drawSessionCard(uint16_t *buffer, const OrbState::SessionInfo &info, uint32_t now) {
  const uint32_t accent = sessionColor(info);
  const uint16_t background = color565(kBackground);
  const uint16_t foreground = color565(0xf0f6fc);
  const uint16_t muted = color565(0x8b949e);
  drawCard(buffer, Box{kSessionX, kSessionY, kSessionW, kSessionH}, accent);
  drawCentered(buffer, kSessionY + 26, info.name, foreground, 2, 312);

  char line[48];
  sessionStatus(info, now, line, sizeof(line));
  char chip[27];
  fitColumns(line, 24, chip, sizeof(chip));
  const int chipWidth = static_cast<int>(columns(chip)) * 12 - 2;
  fillRoundRect(buffer, kCenter - chipWidth / 2 - 16, kSessionY + 54, chipWidth + 32, 30, 15, color565(accent));
  drawText(buffer, kCenter - chipWidth / 2, kSessionY + 62, chip, background, 2);

  int y = kSessionY + 110;
  auto row = [&](const char *label, const char *value) {
    drawText(buffer, 84, y, label, muted, 2);
    char fitted[24];
    fitColumns(value, 18, fitted, sizeof(fitted));
    drawText(buffer, 180, y, fitted, foreground, 2);
    y += 28;
  };
  row("Agent", info.agent[0] ? info.agent : "Copilot");
  if (info.subagent[0]) row("Sub", info.subagent);
  row("Model", info.model[0] ? info.model : "not reported");
  if (info.hasTokenUsage) {
    char in[12], out[12];
    formatCount(info.inputTokens, in, sizeof(in));
    formatCount(info.outputTokens, out, sizeof(out));
    snprintf(line, sizeof(line), "%s in %s out", in, out);
    row("Tokens", line);
  } else {
    row("Tokens", "not reported yet");
  }
  if (info.contextPercent >= 0) {
    snprintf(line, sizeof(line), "%d%%", info.contextPercent);
    const int barY = y + 4;
    row("Context", line);
    fillRoundRect(buffer, 250, barY, 140, 8, 4, color565(0x30363d));
    const int filled = 140 * info.contextPercent / 100;
    if (filled > 0) fillRoundRect(buffer, 250, barY, filled, 8, 4, color565(info.contextPercent >= 85 ? 0xf85149 : 0x2f81f7));
  }
  if (info.busy) {
    formatDuration((now - info.busySinceMs) / 1000, line, sizeof(line));
    row("Working", line);
  } else if (info.ended) {
    formatAgo((now - info.endedAtMs) / 1000, line, sizeof(line));
    row(info.closed ? "Closed" : "Ended", line);
  }
}

void Renderer::drawApprovalCard(uint16_t *buffer, const OrbState::SessionInfo &info) {
  const OrbState::Attention &attention = info.attention;
  const uint16_t foreground = color565(0xf0f6fc);
  const uint16_t muted = color565(0x8b949e);
  drawCard(buffer, Box{kApprovalX, kApprovalY, kApprovalW, kApprovalH}, kAmber);
  drawCentered(buffer, kApprovalY + 22, attentionHeading(attention.kind), color565(kAmber), 2, 312);
  drawCentered(buffer, kApprovalY + 48, info.name, muted, 2, 312);
  if (attention.reason[0]) drawWrapped(buffer, kApprovalY + 80, attention.reason, foreground, 2, 312, 2);
  if (attention.preview[0]) {
    fillRoundRect(buffer, 76, kApprovalY + 128, 328, 56, 10, color565(0x161b22));
    drawWrapped(buffer, kApprovalY + 138, attention.preview, color565(0xc9d1d9), 2, 300, 2);
  }
  if (attention.pending > 1) {
    char more[24];
    snprintf(more, sizeof(more), "+%u more waiting", attention.pending - 1);
    drawCentered(buffer, kApprovalY + 196, more, muted, 2, 300);
  }
  drawCentered(buffer, kApprovalY + 245, "Answer on computer", muted, 2, 312);
}

size_t Renderer::columns(const char *text) {
  size_t count = 0;
  for (const unsigned char *p = reinterpret_cast<const unsigned char *>(text); *p; p++) {
    if ((*p & 0xc0) != 0x80) count++;
  }
  return count;
}

void Renderer::drawText(uint16_t *buffer, int x, int y, const char *text, uint16_t color, uint8_t scale) {
  for (const unsigned char *p = reinterpret_cast<const unsigned char *>(text); *p; p++) {
    if ((*p & 0xc0) == 0x80) continue; // UTF-8 continuation byte: drawn as one '?' with its lead byte.
    const uint8_t *glyphColumns = glyph(*p);
    for (int column = 0; column < 5; column++) for (int row = 0; row < 7; row++) {
      if (!(glyphColumns[column] & (1 << row))) continue;
      for (int sy = 0; sy < scale; sy++) for (int sx = 0; sx < scale; sx++) {
        const int px = x + column * scale + sx;
        const int py = y + row * scale + sy;
        if (px >= 0 && px < Board::kWidth && py >= 0 && py < Board::kHeight) buffer[py * Board::kWidth + px] = color;
      }
    }
    x += 6 * scale;
  }
}

void Renderer::drawCentered(uint16_t *buffer, int y, const char *text, uint16_t color, uint8_t scale, int maxWidth) {
  char fitted[64];
  fitColumns(text, maxWidth / (6 * scale), fitted, sizeof(fitted));
  const int width = static_cast<int>(columns(fitted)) * 6 * scale - scale;
  drawText(buffer, kCenter - width / 2, y, fitted, color, scale);
}

// Word-wraps centred lines; the last line ends with ".." when text remains.
int Renderer::drawWrapped(uint16_t *buffer, int y, const char *text, uint16_t color, uint8_t scale, int maxWidth,
                          int maxLines) {
  const size_t perLine = maxWidth / (6 * scale);
  const char *p = text;
  int lines = 0;
  while (*p && lines < maxLines) {
    while (*p == ' ') p++;
    const char *end = p;
    const char *lastBreak = nullptr;
    size_t count = 0;
    while (*end && count < perLine) {
      if (*end == ' ') lastBreak = end;
      end++;
      while ((*end & 0xc0) == 0x80) end++;
      count++;
    }
    if (*end && lastBreak && lastBreak > p && *end != ' ') end = lastBreak;
    char line[64];
    const size_t length = min<size_t>(end - p, sizeof(line) - 1);
    memcpy(line, p, length);
    line[length] = '\0';
    p = end;
    lines++;
    if (lines == maxLines && *p) {
      char fitted[64];
      char extended[72];
      snprintf(extended, sizeof(extended), "%s%s", line, " ...");
      fitColumns(extended, perLine, fitted, sizeof(fitted));
      drawCentered(buffer, y, fitted, color, scale, maxWidth);
    } else {
      drawCentered(buffer, y, line, color, scale, maxWidth);
    }
    y += 10 * scale + 2;
  }
  return lines;
}

void Renderer::drawLabel(uint16_t *buffer) {
  const char *label = state_.task[0] ? state_.task : moodName(state_.mood);
  const size_t length = min<size_t>(strlen(label), 18);
  char display[19] = {};
  memcpy(display, label, length);
  const uint8_t scale = length > 11 ? 1 : 2;
  const int width = length * 6 * scale - scale;
  drawText(buffer, (Board::kWidth - width) / 2, 425, display, color565(0xe6e1f5), scale);
  if (state_.mona && state_.alert.title[0]) {
    char title[31] = {};
    strlcpy(title, state_.alert.title, sizeof(title));
    drawText(buffer, (Board::kWidth - strlen(title) * 6) / 2, 411, title, color565(0xc9d1d9), 1);
  }
}

bool Renderer::quietNow() const {
  if (!state_.settings.quietHoursEnabled) return false;
  time_t timestamp = time(nullptr);
  if (timestamp < 100000) return false;
  tm local = {};
  localtime_r(&timestamp, &local);
  const int now = local.tm_hour * 60 + local.tm_min;
  const int start = atoi(state_.settings.quietStart) * 60 + atoi(state_.settings.quietStart + 3);
  const int end = atoi(state_.settings.quietEnd) * 60 + atoi(state_.settings.quietEnd + 3);
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

void Renderer::triggerSound(Mood mood) {
  if (!soundPatternsReady_ || !state_.settings.sound || state_.settings.volume <= 0.01f || quietNow()) return;
  int8_t sound = -1;
  if (state_.mona) {
    if (!strcmp(state_.alert.kind, "prAssigned")) sound = static_cast<int8_t>(SoundId::MonaPrAssigned);
    else if (!strcmp(state_.alert.kind, "reviewRequested")) sound = static_cast<int8_t>(SoundId::MonaReviewRequested);
    else if (!strcmp(state_.alert.kind, "workflowFailure") || !strcmp(state_.alert.kind, "workflowUpdate")) {
      sound = static_cast<int8_t>(SoundId::MonaWorkflow);
    } else if (!strcmp(state_.alert.kind, "securityAlert") || !strcmp(state_.alert.kind, "criticalSecurity")) {
      sound = static_cast<int8_t>(SoundId::MonaSecurity);
    } else if (!strcmp(state_.alert.kind, "githubNotification")) {
      sound = static_cast<int8_t>(SoundId::MonaNotification);
    }
  } else if (mood == Mood::Done) {
    sound = static_cast<int8_t>(SoundId::CopilotDone);
  } else if (mood == Mood::NeedsInput) {
    sound = static_cast<int8_t>(SoundId::CopilotNeedsInput);
  }
  if (sound < 0 || !soundPatterns_[sound].pulseCount) return;
  if (buzzerOn_) Board::setBuzzer(false);
  buzzerOn_ = false;
  playingSound_ = sound;
  soundPulseIndex_ = 0;
  nextBuzzMs_ = 0;
}

const char *Renderer::testSound() {
  if (!soundPatternsReady_) return "sound_assets_unavailable";
  if (!state_.settings.sound || state_.settings.volume <= 0.01f) return "sound_muted";
  if (quietNow()) return "quiet_hours_active";
  if (playingSound_ >= 0) return "audio_busy";
  playingSound_ = static_cast<int8_t>(SoundId::CopilotDone);
  soundPulseIndex_ = 0;
  nextBuzzMs_ = 0;
  Serial.println("Notification sounds: physical buzzer test scheduled");
  return nullptr;
}

void Renderer::updateSound(uint32_t now) {
  if (playingSound_ >= 0 && (!state_.settings.sound || state_.settings.volume <= 0.01f || quietNow())) {
    Board::setBuzzer(false);
    buzzerOn_ = false;
    playingSound_ = -1;
    nextBuzzMs_ = 0;
  }
  if (playingSound_ < 0 || (nextBuzzMs_ && static_cast<int32_t>(now - nextBuzzMs_) < 0)) return;
  const SoundPattern &pattern = soundPatterns_[playingSound_];
  if (!buzzerOn_) {
    buzzerOn_ = true;
    Board::setBuzzer(true);
    nextBuzzMs_ = now + pattern.onMs[soundPulseIndex_];
    return;
  }
  buzzerOn_ = false;
  Board::setBuzzer(false);
  soundPulseIndex_++;
  if (soundPulseIndex_ >= pattern.pulseCount) {
    playingSound_ = -1;
    nextBuzzMs_ = 0;
    return;
  }
  nextBuzzMs_ = now + pattern.gapMs[soundPulseIndex_ - 1];
}
