#pragma once

#include <Arduino.h>

enum class Mood : uint8_t {
  Idle,
  Thinking,
  Tool,
  NeedsInput,
  Done,
  Error,
  PrAssigned,
  ReviewRequested,
  WorkflowFailure,
  SecurityAlert,
  Disconnected
};

enum class Activity : uint8_t { Thinking, Evaluating, Analysing };
// Allowlisted reasons a session needs the user; Question/Plan/Limits are display-only.
enum class AttentionKind : uint8_t { Shell, Write, Read, Url, Mcp, Memory, CustomTool, Other, Question, Plan, Limits };
enum class RingMode : uint8_t { Solid, Animated };
enum class RingAnimation : uint8_t { Solid, Chase };

struct OrbSettings {
  bool sound = false;
  float volume = 0.5f;
  float brightness = 1.0f;
  bool quietHoursEnabled = true;
  char quietStart[6] = "22:00";
  char quietEnd[6] = "08:00";
};

struct OrbState {
  Mood mood = Mood::Disconnected;
  bool mona = false;
  bool copilotNotification = false;
  char clip[16] = "";
  char task[25] = "OFFLINE";
  RingMode ringMode = RingMode::Solid;
  RingAnimation ringAnimation = RingAnimation::Solid;
  uint32_t ringColor = 0x484f58;
  float ringSpeed = 0;
  uint8_t ringWidth = 6;
  uint64_t presentationId = 0;
  // Bounded alert metadata; clients never need a GitHub credential.
  struct Alert {
    char id[48] = "";
    char kind[32] = "";
    char title[81] = "";
    char url[192] = "";
    char repository[65] = "";
    bool ownerIsOrganization = false;
  } alert;
  char tool[64] = "";
  char agent[25] = "";
  char model[33] = "";
  uint32_t inputTokens = 0;
  uint32_t outputTokens = 0;
  bool hasTokenUsage = false;
  // Live (not closed) sessions, including any hidden beyond the display slots.
  uint8_t sessionCount = 0;
  struct Attention {
    bool active = false;
    char id[17] = "";
    AttentionKind kind = AttentionKind::Other;
    char reason[81] = "";
    char preview[61] = "";
    uint8_t pending = 0;
  };
  // Up to three displayed sessions in sticky slot order; timestamps use the device millis() clock.
  static constexpr size_t kMaxSessionInfos = 3;
  struct SessionInfo {
    char source[8] = "";
    char sessionId[96] = "";
    char name[41] = "";
    char tool[25] = "";
    Activity activity = Activity::Thinking;
    Mood state = Mood::Idle;
    char agent[25] = "";
    char subagent[25] = "";
    char model[33] = "";
    uint32_t inputTokens = 0;
    uint32_t outputTokens = 0;
    bool hasTokenUsage = false;
    int8_t contextPercent = -1;
    bool busy = false;
    uint32_t busySinceMs = 0;
    bool ended = false;
    bool closed = false;
    bool finished = false;
    bool backgroundOnly = false;
    uint32_t endedAtMs = 0;
    uint32_t stateSinceMs = 0;
    Attention attention;
  };
  SessionInfo sessions[kMaxSessionInfos];
  uint8_t sessionInfoCount = 0;
  uint8_t primarySession = 0;
  uint8_t hiddenSessions = 0;
  uint8_t sourceMask = 0;
  uint64_t serverTimestamp = 0;
  uint32_t revision = 0;
  OrbSettings settings;
};

constexpr uint32_t kIdleRingAnimationMs = 120000UL;

inline bool workingSession(const OrbState::SessionInfo &info) {
  return !info.closed && (info.state == Mood::Thinking || info.state == Mood::Tool || info.state == Mood::NeedsInput);
}

inline void keepWorkingSessions(OrbState &state, uint32_t nowMs = 0) {
  const uint8_t primary = state.primarySession;
  bool hasWork = false;
  for (uint8_t i = 0; i < state.sessionInfoCount; i++) hasWork |= workingSession(state.sessions[i]);
  uint8_t count = 0;
  state.primarySession = 0;
  for (uint8_t i = 0; i < state.sessionInfoCount; i++) {
    auto &info = state.sessions[i];
    const bool working = workingSession(info);
    if (!working && !(hasWork && (info.state == Mood::Done || info.finished) && nowMs - info.endedAtMs < 120000UL)) continue;
    info.backgroundOnly = !working;
    if (i == primary && working) state.primarySession = count;
    if (count != i) state.sessions[count] = info;
    count++;
  }
  for (uint8_t i = count; i < state.sessionInfoCount; i++) state.sessions[i] = OrbState::SessionInfo{};
  state.sessionInfoCount = count;
  if (count && state.sessions[state.primarySession].backgroundOnly)
    for (uint8_t i = 0; i < count; i++) if (!state.sessions[i].backgroundOnly) { state.primarySession = i; break; }
}

inline bool idleRingAnimationExpired(Mood mood, uint32_t stateSinceMs, uint32_t nowMs) {
  return mood == Mood::Idle && nowMs - stateSinceMs >= kIdleRingAnimationMs;
}

inline Activity parseActivity(const char *activity) {
  if (activity && !strcmp(activity, "evaluating")) return Activity::Evaluating;
  if (activity && !strcmp(activity, "analysing")) return Activity::Analysing;
  return Activity::Thinking;
}

inline const char *activityLabel(Activity activity) {
  if (activity == Activity::Evaluating) return "Evaluating";
  if (activity == Activity::Analysing) return "Analysing";
  return "Working";
}

inline bool parseAttentionKind(const char *value, AttentionKind &kind) {
  static const char *const names[] = {"shell", "write", "read", "url", "mcp", "memory", "custom-tool", "other",
                                      "question", "plan", "limits"};
  if (!value) return false;
  for (uint8_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
    if (!strcmp(value, names[i])) {
      kind = static_cast<AttentionKind>(i);
      return true;
    }
  }
  return false;
}

inline const char *attentionKindName(AttentionKind kind) {
  static const char *const names[] = {"shell", "write", "read", "url", "mcp", "memory", "custom-tool", "other",
                                      "question", "plan", "limits"};
  return names[static_cast<uint8_t>(kind)];
}

inline bool displayOnlyAttention(AttentionKind kind) {
  return kind == AttentionKind::Question || kind == AttentionKind::Plan || kind == AttentionKind::Limits;
}

inline const char *attentionHeading(AttentionKind kind) {
  switch (kind) {
    case AttentionKind::Shell: return "Run shell command";
    case AttentionKind::Write: return "Edit file";
    case AttentionKind::Read: return "Read file";
    case AttentionKind::Url: return "Fetch URL";
    case AttentionKind::Mcp: return "Use MCP tool";
    case AttentionKind::Memory: return "Store memory";
    case AttentionKind::CustomTool: return "Use custom tool";
    case AttentionKind::Other: return "Approve action";
    case AttentionKind::Question: return "Question waiting";
    case AttentionKind::Plan: return "Plan ready for review";
    case AttentionKind::Limits: return "Session limit reached";
  }
  return "Needs input";
}

inline const char *moodName(Mood mood) {
  switch (mood) {
    case Mood::Idle: return "idle";
    case Mood::Thinking: return "thinking";
    case Mood::Tool: return "tool";
    case Mood::NeedsInput: return "needsInput";
    case Mood::Done: return "done";
    case Mood::Error: return "error";
    case Mood::PrAssigned: return "prAssigned";
    case Mood::ReviewRequested: return "reviewRequested";
    case Mood::WorkflowFailure: return "workflowFailure";
    case Mood::SecurityAlert: return "securityAlert";
    case Mood::Disconnected: return "disconnected";
  }
  return "disconnected";
}

inline Mood parseMood(const char *value) {
  if (!value) return Mood::Disconnected;
  if (!strcmp(value, "idle")) return Mood::Idle;
  if (!strcmp(value, "thinking")) return Mood::Thinking;
  if (!strcmp(value, "tool")) return Mood::Tool;
  if (!strcmp(value, "needsInput")) return Mood::NeedsInput;
  if (!strcmp(value, "done")) return Mood::Done;
  if (!strcmp(value, "error")) return Mood::Error;
  if (!strcmp(value, "prAssigned")) return Mood::PrAssigned;
  if (!strcmp(value, "reviewRequested")) return Mood::ReviewRequested;
  if (!strcmp(value, "workflowFailure")) return Mood::WorkflowFailure;
  if (!strcmp(value, "securityAlert")) return Mood::SecurityAlert;
  return Mood::Disconnected;
}

inline void setMoodRingDefaults(OrbState &state) {
  RingMode mode = RingMode::Solid;
  RingAnimation animation = RingAnimation::Solid;
  uint32_t color = 0x484f58;
  float speed = 0;
  uint8_t width = 6;
  switch (state.mood) {
    case Mood::Idle: mode = RingMode::Animated; animation = RingAnimation::Chase; color = 0x6e40c9; speed = 0.1f; width = 8; break;
    case Mood::Thinking: mode = RingMode::Animated; animation = RingAnimation::Chase; color = 0x2f81f7; speed = 0.12f; width = 8; break;
    case Mood::Tool: mode = RingMode::Animated; animation = RingAnimation::Chase; color = 0x2f81f7; speed = 0.18f; width = 8; break;
    case Mood::NeedsInput: mode = RingMode::Animated; animation = RingAnimation::Chase; color = 0xf0c020; speed = 0.2f; width = 9; break;
    case Mood::PrAssigned:
    case Mood::ReviewRequested: mode = RingMode::Animated; animation = RingAnimation::Chase; color = 0xf0a020; speed = 0.2f; width = 9; break;
    case Mood::Done: color = 0x3fb950; width = 12; break;
    case Mood::Error:
    case Mood::WorkflowFailure:
    case Mood::SecurityAlert: color = 0xf85149; width = 12; break;
    case Mood::Disconnected: break;
  }
  state.ringMode = mode;
  state.ringAnimation = animation;
  state.ringColor = color;
  state.ringSpeed = speed;
  state.ringWidth = width;
}

inline bool isMonaClip(const char *name) {
  return name && (!strcmp(name, "mona-idle") || !strcmp(name, "mona-thinking") ||
                  !strcmp(name, "mona-tool") || !strcmp(name, "mona-pr") ||
                  !strcmp(name, "mona-done") || !strcmp(name, "mona-workflow") ||
                  !strcmp(name, "mona-security") || !strcmp(name, "mona-offline"));
}

inline const char *stateClip(const OrbState &state) {
  if (!state.mona) return state.mood == Mood::Done && strcmp(state.clip, "done") ? "idle" : moodName(state.mood);
  if (isMonaClip(state.clip)) return state.clip;
  if (!strcmp(state.alert.kind, "workflow") || !strcmp(state.alert.kind, "workflowFailure")) return "mona-workflow";
  if (!strcmp(state.alert.kind, "security") || !strcmp(state.alert.kind, "criticalSecurity")) return "mona-security";
  return "mona-pr";
}

inline Mood presentationMood(const OrbState &state) {
  return state.mood;
}

inline bool presentationChanged(const OrbState &previous, const OrbState &next) {
  return previous.mona != next.mona || previous.mood != next.mood || strcmp(stateClip(previous), stateClip(next)) ||
    strcmp(previous.task, next.task) || previous.ringMode != next.ringMode ||
    previous.ringAnimation != next.ringAnimation || previous.ringColor != next.ringColor ||
    previous.ringSpeed != next.ringSpeed || previous.ringWidth != next.ringWidth || next.presentationId > previous.presentationId;
}

inline const char *alertLabel(const OrbState &state) {
  if (state.task[0]) return state.task;
  const char *clip = stateClip(state);
  if (!strcmp(clip, "mona-workflow")) return "WORKFLOW FAILED";
  if (!strcmp(clip, "mona-security")) return "SECURITY ALERT";
  if (!strcmp(state.alert.kind, "prAssigned")) return "PR ASSIGNED";
  return "PR NEEDS REVIEW";
}
