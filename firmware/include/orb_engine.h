#pragma once

#include <Arduino.h>
#include <ctype.h>
#include <stdint.h>
#include <string.h>

#include "orb_state.h"

class OrbEngine {
 public:
  static constexpr size_t kMaxSessions = 16;
  static constexpr uint8_t kSourceVscode = 1;
  static constexpr uint8_t kSourceCli = 2;
  static constexpr uint8_t kSourceSim = 4;

  struct TimingConfig {
    uint32_t doneMs = 10000;
    uint32_t errorMs = 30000;
    uint32_t sessionTimeoutMs = 15UL * 60UL * 1000UL;
    uint32_t approvalDelayMs = 8000;
    uint32_t endedRetentionMs = 2UL * 60UL * 1000UL;
  };

  // Optional observer fields beyond the original v1 message; validated by handleObserver.
  struct ObserverExtras {
    const char *subagent = nullptr;
    int contextPercent = -1;
    bool hasBusy = false;
    uint32_t busyForMs = 0;
    bool hasAttention = false;
    const char *attentionId = nullptr;
    const char *attentionKind = nullptr;
    const char *reason = nullptr;
    const char *preview = nullptr;
    uint32_t pending = 0;
    bool actionable = false;
    const char *command = nullptr;
  };

  struct PermissionDecision {
    char attentionId[17] = "";
    char decision[8] = "";
  };
  static constexpr uint32_t kPermissionTtlMs = 30000;

  struct SessionEntry {
    // Live session: counts toward sessionCount and mood selection.
    bool active = false;
    uint32_t uid = 0;
    char source[8] = "";
    char sessionId[96] = "";
    // 0 = id fallback, 1 = project folder, 2 = first-prompt label, 3 = chat title (always wins, may be renamed).
    char name[41] = "";
    uint8_t nameRank = 0;
    Mood state = Mood::Idle;
    char tool[64] = "";
    char activity[16] = "";
    char agent[25] = "";
    char subagent[25] = "";
    char model[33] = "";
    uint32_t inputTokens = 0;
    uint32_t outputTokens = 0;
    bool hasTokenUsage = false;
    int8_t contextPercent = -1;
    bool hasBusy = false;
    uint32_t busySinceMs = 0;
    OrbState::Attention attention;
    OrbState::PermissionReviewDetails review;
    PermissionDecision permissionDecision;
    uint32_t decisionAtMs = 0;
    bool decisionQueued = false;
    // Set when the session stops working (idle/done/error) or closes; drives the display retention.
    bool hasEnded = false;
    uint32_t endedAtMs = 0;
    bool closed = false;
    bool finished = false;
    uint32_t stateSinceMs = 0;
    uint32_t pendingSinceMs = 0;
    bool hasPending = false;
    uint32_t lastSeenMs = 0;
    // Observer ownership; a closed entry that keeps it is an end tombstone.
    bool observer = false;
    char instanceId[37] = "";
    uint64_t startedAt = 0;
    uint32_t sequence = 0;
    Mood observedState = Mood::Idle;
    char observedTool[64] = "";
    uint32_t activityMs = 0;
  };

  const char *handleObserver(const char *sessionId, const char *event, const char *instanceId,
                            uint64_t startedAt, uint32_t sequence, const char *state, const char *tool,
                            const char *activity, const char *project, const char *sessionName, uint32_t nowMs,
                            const char *agent = nullptr, const char *model = nullptr,
                            uint32_t inputTokens = 0, uint32_t outputTokens = 0, bool hasTokens = false,
                            const ObserverExtras *extras = nullptr);
  bool handleEvent(const char *source, const char *sessionId, const char *event, const char *tool, uint32_t nowMs,
                   const char *title = nullptr, const char *project = nullptr,
                   const char *chat = nullptr);
  bool handleGitHubAlert(const OrbState::Alert &alert, uint32_t nowMs);
  bool acknowledgeAlert(const char *id);
  bool queuePermissionDecision(const char *sessionId, const char *attentionId, const char *decision,
                               uint32_t nowMs, uint32_t displayedToken = 0);
  bool permissionDecision(const char *sessionId, const char *instanceId, uint64_t startedAt,
                          uint32_t nowMs, PermissionDecision &out) const;
  bool permissionReview(const char *sessionId, const char *attentionId, uint32_t nowMs,
                        OrbState::PermissionReviewDetails &out) const;
  bool tick(uint32_t nowMs);
  void setOnline(bool online);
  void setSettings(const OrbSettings &settings);
  const OrbSettings &settings() const { return settings_; }
  OrbState snapshot(uint32_t nowMs) const;
  bool takeStateIfDirty(OrbState &out, uint32_t nowMs);

  const SessionEntry *sessions() const { return sessions_; }
  const char *activeSource(uint32_t nowMs) const;
  TimingConfig &timing() { return timing_; }

  static const char *normalizeEvent(const char *name);
  static uint8_t sourceBit(const char *source);

 private:
  static int moodPriority(Mood mood);
  static bool isAskUserTool(const char *tool);
  static bool isApprovalIgnoredTool(const char *tool);
  static const char *defaultTaskForMood(Mood mood);
  static bool busyMood(Mood mood);
  static void setMood(SessionEntry &entry, Mood mood, uint32_t nowMs);
  static void closeEntry(SessionEntry &entry, uint32_t nowMs);
  bool visible(const SessionEntry &entry, uint32_t nowMs) const;
  int rank(const SessionEntry &entry) const;
  uint32_t recency(const SessionEntry &entry) const;
  bool assignSlots(uint32_t nowMs);
  SessionEntry *allocate();
  SessionEntry *findByUid(uint32_t uid);
  const SessionEntry *findByUid(uint32_t uid) const;
  const SessionEntry *topSession() const;

  SessionEntry sessions_[kMaxSessions];
  uint32_t slots_[OrbState::kMaxSessionInfos] = {};
  uint8_t slotCount_ = 0;
  uint8_t hidden_ = 0;
  uint32_t nextUid_ = 1;
  uint32_t nextAttentionToken_ = 1;
  TimingConfig timing_;
  OrbSettings settings_;
  bool mona_ = false;
  bool agentFinished_ = false;
  uint32_t agentFinishedAtMs_ = 0;
  OrbState::Alert alert_;
  uint64_t presentationId_ = 0;
  uint32_t revision_ = 0;
  bool online_ = false;
  bool dirty_ = true;
};
