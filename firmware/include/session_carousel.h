#pragma once

#include "orb_state.h"

// Presentation only: never changes session aggregation or observer ownership.
class SessionCarousel {
 public:
  struct Pose { float x, y, size; };
  static constexpr uint32_t kDwellMs = 4000, kManualMs = 6000, kTransitionMs = 700;

  int selected(const OrbState &state) const {
    for (uint8_t i = 0; i < state.sessionInfoCount; i++)
      if (same(state.sessions[i], source_, session_)) return i;
    return -1;
  }

  bool update(const OrbState &state, uint32_t now, bool suspended) {
    Entry next[OrbState::kMaxSessionInfos];
    bool membershipChanged = count_ != state.sessionInfoCount;
    for (uint8_t i = 0; i < state.sessionInfoCount; i++) {
      const auto &info = state.sessions[i];
      Entry &entry = next[i];
      int previous = -1;
      for (uint8_t j = 0; j < count_; j++)
        if (same(info, entries_[j].info.source, entries_[j].info.sessionId)) previous = j;
      membershipChanged |= previous != i;
      if (previous >= 0) entry = entries_[previous];
      const bool changed = previous < 0 || displayMood(entry.info) != displayMood(info) || entry.info.closed != info.closed ||
        strcmp(entry.info.tool, info.tool) || entry.info.activity != info.activity ||
        strcmp(entry.info.attention.id, info.attention.id);
      if (info.backgroundOnly) entry.pending = 0;
      else if (count_ && changed && !same(info, source_, session_) && !entry.pending) entry.pending = ++order_;
      entry.info = info;
    }
    count_ = state.sessionInfoCount;
    for (uint8_t i = 0; i < count_; i++) entries_[i] = next[i];
    int front = selected(state);
    bool moved = false;
    if (front < 0) {
      moved = count_ || source_[0] || session_[0];
      source_[0] = session_[0] = '\0';
      if (count_) {
        front = state.primarySession < count_ ? state.primarySession : 0;
        strlcpy(source_, entries_[front].info.source, sizeof(source_));
        strlcpy(session_, entries_[front].info.sessionId, sizeof(session_));
      }
      selectedAt_ = now;
      manual_ = false;
    }
    if (membershipChanged) {
      for (uint8_t i = 0; i < count_; i++) from_[i] = target(i, front);
      movedAt_ = now - kTransitionMs;
    }
    if (front >= 0 && entries_[front].info.backgroundOnly) {
      int replacement = state.primarySession;
      if (replacement >= count_ || entries_[replacement].info.backgroundOnly) {
        replacement = -1;
        for (uint8_t i = 0; i < count_; i++) if (!entries_[i].info.backgroundOnly) { replacement = i; break; }
      }
      if (replacement >= 0) {
        moved |= select(state, replacement, now);
        front = replacement;
        manual_ = false;
      }
    }
    if (front >= 0) entries_[front].pending = 0;
    if (suspended || (manual_ && now - manualAt_ < kManualMs)) return moved;
    int urgent = -1, pending = -1;
    for (uint8_t i = 0; i < count_; i++) {
      if (!entries_[i].info.backgroundOnly && urgency(entries_[i].info) && (urgent < 0 || urgency(entries_[i].info) > urgency(entries_[urgent].info))) urgent = i;
      if (entries_[i].pending && (pending < 0 || entries_[i].pending < entries_[pending].pending)) pending = i;
    }
    if (urgent >= 0) {
      if (front < 0 || urgency(entries_[urgent].info) > urgency(entries_[front].info))
        return select(state, urgent, now) || moved;
    } else if (pending >= 0 && now - selectedAt_ >= kDwellMs) {
      return select(state, pending, now) || moved;
    }
    return moved;
  }

  bool select(const OrbState &state, uint8_t index, uint32_t now, bool manual = false) {
    if (index >= count_ || entries_[index].info.backgroundOnly) return false;
    if (manual) { manual_ = true; manualAt_ = now; }
    entries_[index].pending = 0;
    const int front = selected(state);
    if (front == index) return false;
    for (uint8_t i = 0; i < count_; i++) from_[i] = pose(i, front, now);
    strlcpy(source_, entries_[index].info.source, sizeof(source_));
    strlcpy(session_, entries_[index].info.sessionId, sizeof(session_));
    selectedAt_ = movedAt_ = now;
    return true;
  }

  Pose pose(uint8_t index, int front, uint32_t now) const {
    const Pose to = target(index, front);
    const uint32_t elapsed = now - movedAt_;
    float t = (elapsed < kTransitionMs ? elapsed : kTransitionMs) / static_cast<float>(kTransitionMs);
    t = t * t * (3 - 2 * t);
    return {from_[index].x + (to.x - from_[index].x) * t,
            from_[index].y + (to.y - from_[index].y) * t,
            from_[index].size + (to.size - from_[index].size) * t};
  }

  int hit(const OrbState &state, int x, int y, uint32_t now) const {
    int found = -1;
    float largest = 0;
    for (uint8_t i = 0; i < count_; i++) {
      const Pose p = pose(i, selected(state), now);
      if (x >= p.x - p.size / 2 && x <= p.x + p.size / 2 &&
          y >= p.y - p.size / 2 && y <= p.y + p.size / 2 && p.size > largest) {
        found = i;
        largest = p.size;
      }
    }
    return found;
  }

 private:
  struct Entry { OrbState::SessionInfo info; uint32_t pending = 0; };
  Entry entries_[OrbState::kMaxSessionInfos];
  Pose from_[OrbState::kMaxSessionInfos] = {};
  uint8_t count_ = 0;
  char source_[8] = "", session_[96] = "";
  uint32_t order_ = 0, selectedAt_ = 0, movedAt_ = 0, manualAt_ = 0;
  bool manual_ = false;

  static bool same(const OrbState::SessionInfo &info, const char *source, const char *session) {
    return !strcmp(info.source, source) && !strcmp(info.sessionId, session);
  }
  static int urgency(const OrbState::SessionInfo &info) {
    return info.closed ? 0 : info.state == Mood::NeedsInput ? 2 : info.state == Mood::Error ? 1 : 0;
  }
  static Mood displayMood(const OrbState::SessionInfo &info) {
    return info.closed || info.state == Mood::Idle ? Mood::Done : info.state;
  }
  Pose target(uint8_t index, int front) const {
    if (count_ < 2) return {240, 246, 320};
    const int role = (index - front + count_) % count_;
    return role == 0 ? Pose{240, 246, 256} : Pose{role == 1 ? 394.0f : 86.0f, 258, 112};
  }
};
