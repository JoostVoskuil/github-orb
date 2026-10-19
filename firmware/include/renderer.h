#pragma once

#include <Arduino.h>

#include "animation_pack.h"
#include "orb_state.h"
#include "permission_review.h"
#include "session_carousel.h"

class Renderer {
 public:
  bool begin();
  void setState(const OrbState &state);
  void loop();
  // Polled touch state; derives taps.
  void touch(bool down, uint16_t x, uint16_t y, uint32_t now);
  bool takeAlertAcknowledgement(char *id, size_t size);
  bool takePermissionDecision(OrbState::PermissionIntent &intent);
  using ReviewProvider = bool (*)(const char *, const char *, OrbState::PermissionReviewDetails &, void *);
  void setReviewProvider(ReviewProvider provider, void *context) { reviewProvider_ = provider; reviewContext_ = context; }
  bool assetsReady() const { return assetsReady_; }
  const char *testSound();

 private:
  struct Box {
    int x, y, w, h;
    bool contains(int px, int py) const { return px >= x && px <= x + w && py >= y && py <= y + h; }
  };
  enum class OverlayMode : uint8_t { None, Session, Approval, Notification };
  enum class SoundId : uint8_t {
    CopilotDone,
    CopilotNeedsInput,
    MonaPrAssigned,
    MonaReviewRequested,
    MonaWorkflow,
    MonaSecurity,
    MonaNotification,
    Count
  };
  struct SoundPattern {
    uint16_t onMs[4] = {};
    uint16_t gapMs[4] = {};
    uint8_t pulseCount = 0;
  };

  void render(uint32_t now);
  void drawBackground(uint16_t *buffer, uint32_t now);
  void drawProgressRing(uint16_t *buffer, uint32_t now);
  void drawSessionArcs(uint16_t *buffer, uint32_t now);
  void drawDot(uint16_t *buffer, int cx, int cy, uint16_t color);
  void drawMona(uint16_t *buffer);
  void drawCopilot(uint16_t *buffer, const SessionCarousel::Pose &pose, Mood mood);
  void drawCarousel(uint16_t *buffer, uint32_t now);
  void fillRoundRect(uint16_t *buffer, int x, int y, int w, int h, int r, uint16_t color);
  void drawCard(uint16_t *buffer, const Box &box, uint32_t border);
  void drawTopBadge(uint16_t *buffer);
  void drawCaption(uint16_t *buffer);
  void drawOverlay(uint16_t *buffer, uint32_t now);
  void drawSessionCard(uint16_t *buffer, const OrbState::SessionInfo &info, uint32_t now);
  void drawApprovalCard(uint16_t *buffer, const OrbState::SessionInfo &info);
  void drawNotificationCard(uint16_t *buffer);
  void drawLabel(uint16_t *buffer);
  void drawText(uint16_t *buffer, int x, int y, const char *text, uint16_t color, uint8_t scale = 2);
  void drawCentered(uint16_t *buffer, int y, const char *text, uint16_t color, uint8_t scale, int maxWidth);
  int drawWrapped(uint16_t *buffer, int y, const char *text, uint16_t color, uint8_t scale, int maxWidth, int maxLines);
  bool splitRing() const;
  int sessionIndex(const char *source, const char *sessionId) const;
  int arcSlot(int x, int y) const;
  void tap(uint16_t x, uint16_t y, uint32_t now);
  void open(uint8_t index, uint32_t now);
  void pointerDown(uint16_t x, uint16_t y, uint32_t now);
  void pointerUp(uint32_t now, int x = -1, int y = -1);
  void sessionStatus(const OrbState::SessionInfo &info, uint32_t now, char *out, size_t size) const;
  uint32_t sessionColor(const OrbState::SessionInfo &info) const;
  void triggerSound(Mood mood);
  void updateSound(uint32_t now);
  bool loadSoundPatterns();
  bool quietNow() const;
  static uint16_t color565(uint32_t rgb);
  static size_t columns(const char *text);

  AnimationPack pack_;
  AnimationClip clip_;
  OrbState state_;
  OrbState incoming_;
  SessionCarousel carousel_;
  struct Avatar {
    char source[8] = "", session[96] = "";
    Mood mood = Mood::Disconnected;
    bool resting = false;
    AnimationClip clip;
    uint32_t startedMs = 0;
    bool ready = false;
  } avatars_[OrbState::kMaxSessionInfos];
  uint32_t carouselFrames_ = 0, carouselRenderMs_ = 0, carouselMaxMs_ = 0;
  Mood renderedMood_ = Mood::Disconnected;
  uint32_t clipStartedMs_ = 0;
  uint32_t lastFrameMs_ = 0;
  uint32_t lastInputReminderMs_ = 0;
  uint32_t nextBuzzMs_ = 0;
  uint8_t soundPulseIndex_ = 0;
  int8_t playingSound_ = -1;
  SoundPattern soundPatterns_[static_cast<uint8_t>(SoundId::Count)] = {};
  bool buzzerOn_ = false;
  bool soundPatternsReady_ = false;
  bool assetsReady_ = false;
  bool clipReady_ = false;
  bool stateReceived_ = false;
  bool forceRender_ = true;

  OverlayMode overlay_ = OverlayMode::None;
  char overlaySession_[96] = "";
  char overlaySource_[8] = "";
  char overlayAlertId_[48] = "";
  char pendingAlertId_[48] = "";
  uint32_t overlayUntilMs_ = 0;
  uint32_t overlayToken_ = 0;
  char overlayAttentionId_[17] = "";
  OrbState::PermissionReviewDetails review_;
  ReviewProvider reviewProvider_ = nullptr;
  void *reviewContext_ = nullptr;
  bool decisionPending_ = false;
  bool hasPermissionIntent_ = false;
  OrbState::PermissionIntent permissionIntent_;

  bool touching_ = false;
  bool pressActive_ = false;
  uint16_t pressX_ = 0, pressY_ = 0;
  PermissionReview::TapMotion pressMotion_;
  uint32_t pressAtMs_ = 0;
  uint32_t pressToken_ = 0;
  OverlayMode pressOverlay_ = OverlayMode::None;
};
