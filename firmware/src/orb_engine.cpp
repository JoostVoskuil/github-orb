#include "orb_engine.h"
#include "permission_review.h"

namespace {
bool equalsIgnoreCase(const char *a, const char *b) {
  if (!a || !b) return false;
  while (*a && *b) {
    if (tolower(static_cast<unsigned char>(*a)) != tolower(static_cast<unsigned char>(*b))) return false;
    a++;
    b++;
  }
  return *a == '\0' && *b == '\0';
}

bool AlertMood(const char *kind, Mood &mood, const char *&clip, const char *&task) {
  if (!kind) return false;
  if (!strcmp(kind, "prAssigned")) {
    mood = Mood::PrAssigned;
    clip = "mona-pr";
    task = "PR assigned";
    return true;
  }
  if (!strcmp(kind, "reviewRequested")) {
    mood = Mood::ReviewRequested;
    clip = "mona-pr";
    task = "PR needs review";
    return true;
  }
  if (!strcmp(kind, "workflowFailure")) {
    mood = Mood::WorkflowFailure;
    clip = "mona-workflow";
    task = "Workflow failed";
    return true;
  }
  if (!strcmp(kind, "workflowUpdate")) {
    mood = Mood::WorkflowFailure;
    clip = "mona-workflow";
    task = "Workflow failed";
    return true;
  }
  if (!strcmp(kind, "githubNotification")) {
    mood = Mood::NeedsInput;
    clip = "mona-pr";
    task = "GitHub needs attention";
    return true;
  }
  if (!strcmp(kind, "securityAlert")) {
    mood = Mood::SecurityAlert;
    clip = "mona-security";
    task = "Security alert";
    return true;
  }
  if (!strcmp(kind, "criticalSecurity")) {
    mood = Mood::SecurityAlert;
    clip = "mona-security";
    task = "Security alert";
    return true;
  }
  return false;
}
}  // namespace

const char *OrbEngine::normalizeEvent(const char *name) {
  if (!name || !name[0]) return nullptr;
  if (equalsIgnoreCase(name, "sessionstart")) return "sessionStart";
  if (equalsIgnoreCase(name, "userpromptsubmit") ||
      equalsIgnoreCase(name, "userpromptsubmitted") ||
      equalsIgnoreCase(name, "userprompt")) return "userPrompt";
  if (equalsIgnoreCase(name, "pretooluse") || equalsIgnoreCase(name, "pretool")) return "preTool";
  if (equalsIgnoreCase(name, "posttooluse") || equalsIgnoreCase(name, "posttool")) return "postTool";
  if (equalsIgnoreCase(name, "notification") ||
      equalsIgnoreCase(name, "permissionrequest") ||
      equalsIgnoreCase(name, "needsinput")) return "needsInput";
  if (equalsIgnoreCase(name, "stop") || equalsIgnoreCase(name, "agentstop")) return "stop";
  if (equalsIgnoreCase(name, "erroroccurred") || equalsIgnoreCase(name, "error")) return "error";
  if (equalsIgnoreCase(name, "sessionend")) return "sessionEnd";
  if (equalsIgnoreCase(name, "subagentstart") ||
      equalsIgnoreCase(name, "subagentstop") ||
      equalsIgnoreCase(name, "precompact") ||
      equalsIgnoreCase(name, "thinking")) return "thinking";
  return nullptr;
}

uint8_t OrbEngine::sourceBit(const char *source) {
  if (!source) return 0;
  if (!strcmp(source, "vscode")) return kSourceVscode;
  if (!strcmp(source, "cli")) return kSourceCli;
  if (!strcmp(source, "sim")) return kSourceSim;
  return 0;
}

int OrbEngine::moodPriority(Mood mood) {
  switch (mood) {
    case Mood::NeedsInput: return 5;
    case Mood::Error: return 4;
    case Mood::Tool: return 3;
    case Mood::Thinking: return 2;
    case Mood::Done: return 1;
    case Mood::Idle: return 0;
    default: return -1;
  }
}

bool OrbEngine::isAskUserTool(const char *tool) {
  if (!tool || !tool[0]) return false;
  return !strcmp(tool, "vscode_askQuestions") ||
         !strcmp(tool, "ask_user") ||
         !strcmp(tool, "askQuestions");
}

bool OrbEngine::isApprovalIgnoredTool(const char *tool) {
  if (!tool || !tool[0]) return false;
  return !strcmp(tool, "runSubagent") ||
         !strcmp(tool, "execution_subagent") ||
         !strcmp(tool, "task");
}

const char *OrbEngine::defaultTaskForMood(Mood mood) {
  switch (mood) {
    case Mood::Idle: return "Resting";
    case Mood::Thinking: return "Working";
    case Mood::Tool: return "Executing";
    case Mood::NeedsInput: return "Input needed";
    case Mood::Done: return "Done";
    case Mood::Error: return "Error";
    case Mood::PrAssigned: return "PR assigned";
    case Mood::ReviewRequested: return "PR needs review";
    case Mood::WorkflowFailure: return "Workflow failed";
    case Mood::SecurityAlert: return "Security alert";
    case Mood::Disconnected: return "OFFLINE";
  }
  return "OFFLINE";
}

namespace {
// Collapses whitespace and control bytes, trims, and bounds to cap-1 bytes; false if nothing remains.
bool copyName(char *dst, size_t cap, const char *src) {
  if (!src) return false;
  size_t length = 0;
  bool pendingSpace = false;
  for (; *src && length + 1 < cap; src++) {
    const unsigned char c = static_cast<unsigned char>(*src);
    if (c <= 0x20 || c == 0x7f) {
      pendingSpace = length > 0;
      continue;
    }
    if (pendingSpace) {
      if (length + 2 >= cap) break;
      dst[length++] = ' ';
      pendingSpace = false;
    }
    dst[length++] = static_cast<char>(c);
  }
  dst[length] = '\0';
  return length > 0;
}
}  // namespace

bool OrbEngine::busyMood(Mood mood) {
  return mood == Mood::Thinking || mood == Mood::Tool || mood == Mood::NeedsInput;
}

// Moods change only through here so busy/ended bookkeeping stays consistent.
void OrbEngine::setMood(SessionEntry &entry, Mood mood, uint32_t nowMs) {
  if (busyMood(mood)) {
    entry.hasEnded = false;
    entry.finished = false;
  } else if (!entry.hasEnded) {
    entry.hasEnded = true;
    entry.endedAtMs = nowMs;
  }
  if (mood == Mood::Done) entry.finished = true;
  entry.state = mood;
}

void OrbEngine::closeEntry(SessionEntry &entry, uint32_t nowMs) {
  entry.active = false;
  entry.closed = true;
  entry.attention = OrbState::Attention{};
  entry.review = OrbState::PermissionReviewDetails{};
  entry.permissionDecision = PermissionDecision{};
  entry.decisionQueued = false;
  if (!entry.hasEnded) {
    entry.hasEnded = true;
    entry.endedAtMs = nowMs;
  }
}

bool OrbEngine::visible(const SessionEntry &entry, uint32_t nowMs) const {
  return (entry.active || entry.closed) && entry.uid &&
    ((entry.observer && !entry.hasEnded) ||
     nowMs - (entry.hasEnded ? entry.endedAtMs : entry.lastSeenMs) < timing_.endedRetentionMs);
}

int OrbEngine::rank(const SessionEntry &entry) const {
  return entry.closed ? -1 : moodPriority(entry.state);
}

uint32_t OrbEngine::recency(const SessionEntry &entry) const {
  return entry.hasEnded ? entry.endedAtMs : entry.observer ? entry.activityMs : entry.lastSeenMs;
}

OrbEngine::SessionEntry *OrbEngine::findByUid(uint32_t uid) {
  if (!uid) return nullptr;
  for (SessionEntry &entry : sessions_) {
    if (entry.uid == uid) return &entry;
  }
  return nullptr;
}

const OrbEngine::SessionEntry *OrbEngine::findByUid(uint32_t uid) const {
  if (!uid) return nullptr;
  for (const SessionEntry &entry : sessions_) {
    if (entry.uid == uid) return &entry;
  }
  return nullptr;
}

OrbEngine::SessionEntry *OrbEngine::allocate() {
  SessionEntry *target = nullptr;
  for (SessionEntry &entry : sessions_) {
    if (!entry.active && !entry.observer && !entry.closed) {
      target = &entry;
      break;
    }
  }
  // Prefer evicting the oldest closed entry, then the least recently seen one.
  for (int pass = 0; !target && pass < 2; pass++) {
    for (SessionEntry &entry : sessions_) {
      if (pass == 0 && !entry.closed) continue;
      if (!target || static_cast<int32_t>(entry.lastSeenMs - target->lastSeenMs) < 0) target = &entry;
    }
  }
  *target = SessionEntry{};
  target->uid = nextUid_++;
  if (!nextUid_) nextUid_ = 1;
  return target;
}

// Sticky display slots: a session keeps its arc until it leaves or a more urgent session needs the space.
bool OrbEngine::assignSlots(uint32_t nowMs) {
  uint32_t previous[OrbState::kMaxSessionInfos];
  memcpy(previous, slots_, sizeof(previous));
  const uint8_t previousCount = slotCount_;
  const uint8_t previousHidden = hidden_;

  uint8_t kept = 0;
  for (uint8_t i = 0; i < slotCount_; i++) {
    const SessionEntry *entry = findByUid(slots_[i]);
    if (entry && visible(*entry, nowMs)) slots_[kept++] = slots_[i];
  }
  slotCount_ = kept;

  const SessionEntry *candidates[kMaxSessions];
  uint8_t candidateCount = 0;
  uint8_t visibleCount = 0;
  for (const SessionEntry &entry : sessions_) {
    if (!visible(entry, nowMs)) continue;
    visibleCount++;
    bool slotted = false;
    for (uint8_t i = 0; i < slotCount_; i++) slotted |= slots_[i] == entry.uid;
    if (!slotted) candidates[candidateCount++] = &entry;
  }
  auto before = [this](const SessionEntry *a, const SessionEntry *b) {
    return rank(*a) > rank(*b) || (rank(*a) == rank(*b) && static_cast<int32_t>(recency(*a) - recency(*b)) > 0);
  };
  for (uint8_t i = 1; i < candidateCount; i++) {
    for (uint8_t j = i; j > 0 && before(candidates[j], candidates[j - 1]); j--) {
      const SessionEntry *swap = candidates[j];
      candidates[j] = candidates[j - 1];
      candidates[j - 1] = swap;
    }
  }
  for (uint8_t c = 0; c < candidateCount; c++) {
    if (slotCount_ < OrbState::kMaxSessionInfos) {
      slots_[slotCount_++] = candidates[c]->uid;
      continue;
    }
    uint8_t worst = 0;
    for (uint8_t i = 1; i < slotCount_; i++) {
      if (before(findByUid(slots_[worst]), findByUid(slots_[i]))) worst = i;
    }
    if (rank(*candidates[c]) > rank(*findByUid(slots_[worst]))) slots_[worst] = candidates[c]->uid;
  }
  hidden_ = visibleCount - slotCount_;
  return previousCount != slotCount_ || previousHidden != hidden_ ||
    memcmp(previous, slots_, sizeof(uint32_t) * slotCount_) != 0;
}

bool OrbEngine::handleEvent(const char *source, const char *sessionId, const char *event, const char *tool, uint32_t nowMs,
                            const char *title, const char *project, const char *chat) {
  const char *kind = normalizeEvent(event);
  if (!kind || !sourceBit(source) || !sessionId || !sessionId[0]) return false;
  for (const SessionEntry &entry : sessions_) {
    if (entry.observer && !strcmp(entry.source, source) && !strcmp(entry.sessionId, sessionId)) return false;
  }

  SessionEntry *target = nullptr;
  for (SessionEntry &entry : sessions_) {
    if ((entry.active || entry.closed) && !strcmp(entry.source, source) && !strcmp(entry.sessionId, sessionId)) {
      target = &entry;
      break;
    }
  }

  if (!strcmp(kind, "sessionEnd")) {
    if (!target || target->closed) return false;
    agentFinished_ = false;
    closeEntry(*target, nowMs);
    target->lastSeenMs = nowMs;
    assignSlots(nowMs);
    revision_++;
    dirty_ = true;
    return true;
  }

  agentFinished_ = false;
  if (!target || target->closed) {
    if (target) {
      const uint32_t uid = target->uid;
      *target = SessionEntry{};
      target->uid = uid;
    } else {
      target = allocate();
    }
    target->active = true;
    strlcpy(target->source, source, sizeof(target->source));
    strlcpy(target->sessionId, sessionId, sizeof(target->sessionId));
    strlcpy(target->name, sessionId, 9);
    target->state = Mood::Idle;
    target->hasEnded = true;
    target->endedAtMs = nowMs;
    target->stateSinceMs = nowMs;
  }
  target->lastSeenMs = nowMs;
  char label[sizeof(target->name)];
  if (copyName(label, sizeof(label), chat)) {
    strlcpy(target->name, label, sizeof(target->name));
    target->nameRank = 3;
  } else if (target->nameRank < 2 && copyName(label, sizeof(label), title)) {
    strlcpy(target->name, label, sizeof(target->name));
    target->nameRank = 2;
  } else if (target->nameRank < 1 && copyName(label, sizeof(label), project)) {
    strlcpy(target->name, label, sizeof(target->name));
    target->nameRank = 1;
  }

  auto setSessionState = [&](Mood nextState, const char *toolName) {
    if (target->state != nextState) target->stateSinceMs = nowMs;
    setMood(*target, nextState, nowMs);
    strlcpy(target->tool, toolName ? toolName : "", sizeof(target->tool));
  };

  if (!strcmp(kind, "sessionStart")) {
    setSessionState(Mood::Idle, "");
  } else if (!strcmp(kind, "userPrompt") || !strcmp(kind, "thinking")) {
    setSessionState(Mood::Thinking, "");
    target->hasPending = false;
  } else if (!strcmp(kind, "preTool")) {
    if (isAskUserTool(tool)) setSessionState(Mood::NeedsInput, tool);
    else setSessionState(Mood::Tool, tool);
    target->pendingSinceMs = nowMs;
    target->hasPending = true;
  } else if (!strcmp(kind, "postTool")) {
    setSessionState(Mood::Thinking, "");
    target->hasPending = false;
  } else if (!strcmp(kind, "needsInput")) {
    setSessionState(Mood::NeedsInput, target->tool);
  } else if (!strcmp(kind, "stop")) {
    setSessionState(Mood::Done, "");
    target->hasPending = false;
  } else if (!strcmp(kind, "error")) {
    setSessionState(Mood::Error, target->tool);
    target->hasPending = false;
  }

  assignSlots(nowMs);
  if (!mona_) presentationId_++;
  revision_++;
  dirty_ = true;
  return true;
}

const char *OrbEngine::handleObserver(const char *sessionId, const char *event, const char *instanceId,
                                     uint64_t startedAt, uint32_t sequence, const char *state,
                                     const char *tool, const char *activity, const char *project,
                                     const char *sessionName, uint32_t nowMs, const char *agent,
                                     const char *model, uint32_t inputTokens, uint32_t outputTokens,
                                     bool hasTokens, const ObserverExtras *extras) {
  const ObserverExtras none;
  const ObserverExtras &x = extras ? *extras : none;
  auto identifier = [](const char *value, size_t max, bool instance) {
    if (!value || !value[0] || strlen(value) > max || (instance && strlen(value) != 36)) return false;
    for (const char *c = value; *c; c++) {
      if (instance ? !( (*c >= '0' && *c <= '9') || (*c >= 'a' && *c <= 'f') || *c == '-')
                   : !((*c >= 'A' && *c <= 'Z') || (*c >= 'a' && *c <= 'z') ||
                       (*c >= '0' && *c <= '9') || *c == '_' || *c == '-')) return false;
    }
    return true;
  };
  auto label = [](const char *value, size_t max) {
    if (!value) return true;
    if (strlen(value) > max) return false;
    for (const unsigned char *c = reinterpret_cast<const unsigned char *>(value); *c; c++) {
      if (*c < 0x20 || *c == 0x7f) return false;
    }
    return true;
  };
  auto attentionId = [](const char *value) {
    if (!value || strlen(value) != 16) return false;
    for (const char *c = value; *c; c++) {
      if (!((*c >= '0' && *c <= '9') || (*c >= 'a' && *c <= 'f'))) return false;
    }
    return true;
  };
  const bool update = event && !strcmp(event, "observerState");
  const bool end = event && !strcmp(event, "observerEnd");
  const Mood mood = parseMood(state);
  const bool validActivity = !activity ||
    (update && mood == Mood::Thinking &&
      (!strcmp(activity, "thinking") || !strcmp(activity, "evaluating") ||
       !strcmp(activity, "analysing")));
  const bool validSessionName = !sessionName || (update && label(sessionName, 40));
  const bool validMetadata = (!agent || (update && label(agent, 24))) &&
    (!model || (update && label(model, 32))) &&
    (!hasTokens || update) &&
    (!x.subagent || (update && label(x.subagent, 24))) &&
    (x.contextPercent < 0 || (update && x.contextPercent <= 100)) &&
    (!x.hasBusy || update);
  AttentionKind kind = AttentionKind::Other;
  const bool validCommand = !x.command || PermissionReview::validCommand(x.command);
  const bool validAttention = !x.hasAttention ||
    (update && mood == Mood::NeedsInput && attentionId(x.attentionId) && parseAttentionKind(x.attentionKind, kind) &&
     label(x.reason, 80) && label(x.preview, 60) && x.pending >= 1 && x.pending <= 255 &&
     validCommand && (!displayOnlyAttention(kind) || (!x.reason && !x.preview && !x.actionable && !x.command)) &&
    (!x.actionable || x.command));
  if (!identifier(sessionId, 95, false) || !identifier(instanceId, 36, true) ||
      !startedAt || startedAt > 9007199254740991ULL || !sequence ||
      (!update && !end) || (update && (mood > Mood::Error || !state)) ||
      !validActivity || !validSessionName || !validMetadata || !validAttention ||
      (!x.hasAttention && (x.actionable || x.command)) ||
      !label(tool, 63) || !label(project, 40)) return "invalid_observer_event";
  tick(nowMs);

  SessionEntry *target = nullptr;
  for (SessionEntry &entry : sessions_) {
    if ((entry.active || entry.observer || entry.closed) && !strcmp(entry.source, "cli") &&
        !strcmp(entry.sessionId, sessionId)) {
      target = &entry;
      break;
    }
  }
  const bool ownerChanged = target && target->instanceId[0] && strcmp(target->instanceId, instanceId) != 0;
  if (target && target->observer) {
    const bool sameOwner = !strcmp(target->instanceId, instanceId);
    if (startedAt < target->startedAt || (startedAt == target->startedAt && !sameOwner) ||
        (sameOwner && (startedAt != target->startedAt || sequence <= target->sequence || !target->active))) return "observer_conflict";
    if (!sameOwner && !update) return "observer_missing";
  } else if (!update) return "observer_missing";
  if (!target) {
    target = allocate();
    strlcpy(target->source, "cli", sizeof(target->source));
    strlcpy(target->sessionId, sessionId, sizeof(target->sessionId));
    strlcpy(target->name, sessionId, 9);
    target->hasEnded = true;
    target->endedAtMs = nowMs;
  }
  target->lastSeenMs = nowMs;
  target->sequence = sequence;
  if (end) {
    closeEntry(*target, nowMs);
    assignSlots(nowMs);
    revision_++;
    dirty_ = true;
    return nullptr;
  }

  agentFinished_ = false;
  bool metadataChanged = ownerChanged;
  if (ownerChanged) {
    target->agent[0] = '\0';
    target->model[0] = '\0';
    target->inputTokens = 0;
    target->outputTokens = 0;
    target->hasTokenUsage = false;
    target->contextPercent = -1;
  }
  const char *nextTool = (mood == Mood::Tool || mood == Mood::NeedsInput) && tool ? tool : "";
  const char *nextActivity = mood == Mood::Thinking && activity ? activity : "";
  const char *nextAttention = x.hasAttention ? x.attentionId : "";
  const bool revived = target->closed;
  const bool changed = !target->observer || !target->active || revived || target->observedState != mood ||
    strcmp(target->observedTool, nextTool) || strcmp(target->activity, nextActivity) ||
    strcmp(target->attention.id, nextAttention);
  char agentBuffer[sizeof(target->agent)];
  if (agent && copyName(agentBuffer, sizeof(agentBuffer), agent) && strcmp(target->agent, agentBuffer)) {
    strlcpy(target->agent, agentBuffer, sizeof(target->agent));
    metadataChanged = true;
  }
  char modelBuffer[sizeof(target->model)];
  if (model && copyName(modelBuffer, sizeof(modelBuffer), model) && strcmp(target->model, modelBuffer)) {
    strlcpy(target->model, modelBuffer, sizeof(target->model));
    metadataChanged = true;
  }
  if (hasTokens && (!target->hasTokenUsage || target->inputTokens != inputTokens ||
                    target->outputTokens != outputTokens)) {
    target->inputTokens = inputTokens;
    target->outputTokens = outputTokens;
    target->hasTokenUsage = true;
    metadataChanged = true;
  }
  char subagentBuffer[sizeof(target->subagent)] = "";
  if (x.subagent) copyName(subagentBuffer, sizeof(subagentBuffer), x.subagent);
  if (strcmp(target->subagent, subagentBuffer)) {
    strlcpy(target->subagent, subagentBuffer, sizeof(target->subagent));
    metadataChanged = true;
  }
  if (x.contextPercent >= 0 && target->contextPercent != x.contextPercent) {
    target->contextPercent = static_cast<int8_t>(x.contextPercent);
    metadataChanged = true;
  }
  if (target->hasBusy != x.hasBusy) metadataChanged = true;
  target->hasBusy = x.hasBusy;
  if (x.hasBusy) target->busySinceMs = nowMs - x.busyForMs;

  OrbState::Attention attention;
  OrbState::PermissionReviewDetails review;
  if (x.hasAttention) {
    attention.active = true;
    strlcpy(attention.id, x.attentionId, sizeof(attention.id));
    attention.kind = kind;
    strlcpy(attention.reason, x.reason ? x.reason : "", sizeof(attention.reason));
    strlcpy(attention.preview, x.preview ? x.preview : "", sizeof(attention.preview));
    attention.pending = static_cast<uint8_t>(x.pending);
    attention.actionable = x.actionable;
    if (x.command && x.command[0]) {
      review.command = !strcmp(x.command, target->review.commandText()) ? target->review.command :
        std::make_shared<const OrbState::PermissionReviewDetails::Command>(x.command);
    }
  }
  if (ownerChanged || attention.active != target->attention.active || strcmp(attention.id, target->attention.id) ||
      attention.kind != target->attention.kind || strcmp(attention.reason, target->attention.reason) ||
      strcmp(attention.preview, target->attention.preview) ||
      attention.actionable != target->attention.actionable || strcmp(review.commandText(), target->review.commandText()) ||
      attention.pending != target->attention.pending) {
    if (attention.active) {
      review.token = nextAttentionToken_++;
      if (!nextAttentionToken_) nextAttentionToken_ = 1;
    }
    target->attention = attention;
    target->review = review;
    target->permissionDecision = PermissionDecision{};
    target->decisionQueued = false;
    metadataChanged = true;
  }

  bool renamed = false;
  char labelBuffer[sizeof(target->name)];
  if (sessionName && copyName(labelBuffer, sizeof(labelBuffer), sessionName)) {
    renamed = strcmp(target->name, labelBuffer) != 0;
    if (renamed || target->nameRank < 3) {
      strlcpy(target->name, labelBuffer, sizeof(target->name));
      target->nameRank = 3;
      renamed = true;
    }
  } else if (target->nameRank <= 1 && project && copyName(labelBuffer, sizeof(labelBuffer), project)) {
    renamed = strcmp(target->name, labelBuffer) != 0;
    if (renamed) {
      strlcpy(target->name, labelBuffer, sizeof(target->name));
      target->nameRank = 1;
    }
  }
  target->active = target->observer = true;
  target->closed = false;
  target->startedAt = startedAt;
  strlcpy(target->instanceId, instanceId, sizeof(target->instanceId));
  target->observedState = mood;
  strlcpy(target->observedTool, nextTool, sizeof(target->observedTool));
  target->hasPending = false;
  if (changed) {
    if (revived) target->hasEnded = false;
    target->activityMs = nowMs;
    setMood(*target, mood, nowMs);
    strlcpy(target->tool, nextTool, sizeof(target->tool));
    strlcpy(target->activity, nextActivity, sizeof(target->activity));
    target->stateSinceMs = nowMs;
    if (!mona_) presentationId_++;
  }
  const bool slotsChanged = assignSlots(nowMs);
  if (changed || renamed || metadataChanged || slotsChanged) {
    revision_++;
    dirty_ = true;
  }
  return nullptr;
}

bool OrbEngine::queuePermissionDecision(const char *sessionId, const char *attentionId, const char *decision,
                                        uint32_t nowMs, uint32_t displayedToken) {
  if (!sessionId || !attentionId || !decision || (strcmp(decision, "approve") && strcmp(decision, "deny"))) return false;
  tick(nowMs);
  for (SessionEntry &entry : sessions_) {
    if (!entry.observer || !entry.active || entry.closed || strcmp(entry.sessionId, sessionId) ||
        entry.state != Mood::NeedsInput || !entry.attention.active || !entry.attention.actionable ||
        displayOnlyAttention(entry.attention.kind) || strcmp(entry.attention.id, attentionId) ||
        (displayedToken && entry.review.token != displayedToken) || entry.attention.decisionPending ||
        nowMs - entry.lastSeenMs >= kPermissionTtlMs) continue;
    strlcpy(entry.permissionDecision.attentionId, attentionId, sizeof(entry.permissionDecision.attentionId));
    strlcpy(entry.permissionDecision.decision, decision, sizeof(entry.permissionDecision.decision));
    entry.decisionAtMs = nowMs;
    entry.decisionQueued = true;
    entry.attention.decisionPending = true;
    revision_++;
    dirty_ = true;
    return true;
  }
  return false;
}

bool OrbEngine::permissionReview(const char *sessionId, const char *attentionId, uint32_t nowMs,
                                 OrbState::PermissionReviewDetails &out) const {
  out = OrbState::PermissionReviewDetails{};
  if (!sessionId || !attentionId) return false;
  for (const SessionEntry &entry : sessions_) {
    if (entry.active && entry.observer && !entry.closed && entry.state == Mood::NeedsInput &&
        entry.attention.active && !strcmp(entry.sessionId, sessionId) && !strcmp(entry.attention.id, attentionId) &&
        nowMs - entry.lastSeenMs < kPermissionTtlMs) {
      out = entry.review;
      return true;
    }
  }
  return false;
}

bool OrbEngine::permissionDecision(const char *sessionId, const char *instanceId, uint64_t startedAt,
                                   uint32_t nowMs, PermissionDecision &out) const {
  out = PermissionDecision{};
  if (!sessionId || !instanceId) return false;
  for (const SessionEntry &entry : sessions_) {
    if (entry.observer && entry.active && !entry.closed && entry.state == Mood::NeedsInput &&
        entry.attention.active && entry.attention.actionable && !displayOnlyAttention(entry.attention.kind) &&
        entry.decisionQueued && nowMs - entry.decisionAtMs < kPermissionTtlMs &&
        nowMs - entry.lastSeenMs < kPermissionTtlMs && !strcmp(entry.sessionId, sessionId) &&
        !strcmp(entry.instanceId, instanceId) && entry.startedAt == startedAt &&
        !strcmp(entry.attention.id, entry.permissionDecision.attentionId)) {
      out = entry.permissionDecision;
      return true;
    }
  }
  return false;
}

bool OrbEngine::handleGitHubAlert(const OrbState::Alert &alert, uint32_t nowMs) {
  if (!strcmp(alert.kind, "agentSessionFinished")) {
    mona_ = false;
    alert_ = OrbState::Alert{};
    agentFinished_ = true;
    agentFinishedAtMs_ = nowMs;
    presentationId_++;
    revision_++;
    dirty_ = true;
    return true;
  }
  Mood mood = Mood::Idle;
  const char *clip = nullptr;
  const char *task = nullptr;
  if (!AlertMood(alert.kind, mood, clip, task)) return false;
  agentFinished_ = false;
  mona_ = true;
  alert_ = alert;
  presentationId_++;
  revision_++;
  dirty_ = true;
  return true;
}

bool OrbEngine::acknowledgeAlert(const char *id) {
  if (!id || !id[0] || !mona_ || strcmp(alert_.id, id)) return false;
  mona_ = false;
  alert_ = OrbState::Alert{};
  presentationId_++;
  revision_++;
  dirty_ = true;
  return true;
}

bool OrbEngine::tick(uint32_t nowMs) {
  bool changed = false;
  if (agentFinished_ && nowMs - agentFinishedAtMs_ >= timing_.doneMs) {
    agentFinished_ = false;
    changed = true;
  }
  for (SessionEntry &entry : sessions_) {
    if (!entry.active && !entry.observer && !entry.closed) continue;
    if (entry.decisionQueued && nowMs - entry.decisionAtMs >= kPermissionTtlMs) {
      entry.decisionQueued = false;
      entry.permissionDecision = PermissionDecision{};
      changed = true;
    }
    if (entry.active && !entry.observer && nowMs - entry.lastSeenMs > timing_.sessionTimeoutMs) {
      closeEntry(entry, entry.lastSeenMs);
      changed = true;
    }
    if (entry.closed && entry.hasEnded && nowMs - entry.endedAtMs >= timing_.endedRetentionMs) {
      entry = SessionEntry{};
      changed = true;
      continue;
    }
    if (entry.closed) continue;
    const uint32_t ageMs = nowMs - entry.stateSinceMs;
    if (!entry.observer && entry.state == Mood::Tool &&
        entry.hasPending &&
        !isApprovalIgnoredTool(entry.tool) &&
        nowMs - entry.pendingSinceMs > timing_.approvalDelayMs) {
      setMood(entry, Mood::NeedsInput, nowMs);
      entry.stateSinceMs = nowMs;
      changed = true;
    } else if ((entry.state == Mood::Done && (entry.observer ? ageMs >= timing_.doneMs : ageMs > timing_.doneMs)) ||
               (entry.state == Mood::Error && (entry.observer ? ageMs >= timing_.errorMs : ageMs > timing_.errorMs))) {
      setMood(entry, Mood::Idle, nowMs);
      entry.tool[0] = '\0';
      entry.stateSinceMs = nowMs;
      changed = true;
    }
  }
  if (assignSlots(nowMs)) changed = true;
  if (changed) {
    revision_++;
    dirty_ = true;
  }
  return changed;
}

void OrbEngine::setOnline(bool online) {
  if (online_ == online) return;
  online_ = online;
  revision_++;
  dirty_ = true;
}

void OrbEngine::setSettings(const OrbSettings &settings) {
  settings_ = settings;
  revision_++;
  dirty_ = true;
}

const OrbEngine::SessionEntry *OrbEngine::topSession() const {
  const SessionEntry *best = nullptr;
  auto consider = [&](const SessionEntry &entry) {
    if (!best) {
      best = &entry;
      return;
    }
    const int prio = rank(entry);
    const int bestPrio = rank(*best);
    const uint32_t activity = entry.observer ? entry.activityMs : entry.lastSeenMs;
    const uint32_t bestActivity = best->observer ? best->activityMs : best->lastSeenMs;
    if (prio > bestPrio || (prio == bestPrio && static_cast<int32_t>(activity - bestActivity) > 0)) best = &entry;
  };
  // The mascot follows the most urgent displayed session, so it always matches an arc.
  for (uint8_t i = 0; i < slotCount_; i++) {
    const SessionEntry *entry = findByUid(slots_[i]);
    if (entry) consider(*entry);
  }
  return best;
}

const char *OrbEngine::activeSource(uint32_t /*nowMs*/) const {
  if (mona_ && alert_.kind[0]) return "github";
  const SessionEntry *top = topSession();
  return top ? top->source : nullptr;
}

OrbState OrbEngine::snapshot(uint32_t nowMs) const {
  OrbState state;
  state.settings = settings_;
  state.presentationId = presentationId_;
  state.revision = revision_;
  state.serverTimestamp = nowMs;
  state.mona = mona_;

  const SessionEntry *top = topSession();
  if (top && top->observer) {
    strlcpy(state.agent, top->agent[0] ? top->agent : "Copilot", sizeof(state.agent));
    strlcpy(state.model, top->model, sizeof(state.model));
    state.inputTokens = top->inputTokens;
    state.outputTokens = top->outputTokens;
    state.hasTokenUsage = top->hasTokenUsage;
  }
  uint8_t count = 0;
  uint8_t mask = 0;
  for (const SessionEntry &entry : sessions_) {
    if (!entry.active) continue;
    count++;
    mask |= sourceBit(entry.source);
  }
  state.sessionCount = count;
  state.sourceMask = mask;
  for (uint8_t i = 0; i < slotCount_; i++) {
    const SessionEntry *entry = findByUid(slots_[i]);
    if (!entry) continue;
    OrbState::SessionInfo &info = state.sessions[state.sessionInfoCount];
    strlcpy(info.source, entry->source, sizeof(info.source));
    strlcpy(info.sessionId, entry->sessionId, sizeof(info.sessionId));
    strlcpy(info.name, entry->name, sizeof(info.name));
    strlcpy(info.tool, entry->tool, sizeof(info.tool));
    info.activity = parseActivity(entry->activity);
    info.state = entry->state;
    strlcpy(info.agent, entry->agent, sizeof(info.agent));
    strlcpy(info.subagent, entry->closed ? "" : entry->subagent, sizeof(info.subagent));
    strlcpy(info.model, entry->model, sizeof(info.model));
    info.inputTokens = entry->inputTokens;
    info.outputTokens = entry->outputTokens;
    info.hasTokenUsage = entry->hasTokenUsage;
    info.contextPercent = entry->contextPercent;
    info.busy = entry->hasBusy && !entry->hasEnded;
    info.busySinceMs = entry->busySinceMs;
    info.ended = entry->hasEnded;
    info.closed = entry->closed;
    info.finished = entry->finished;
    info.endedAtMs = entry->endedAtMs;
    info.stateSinceMs = entry->stateSinceMs;
    if (entry->state == Mood::NeedsInput && !entry->closed && entry->attention.active) {
      info.attention = entry->attention;
    }
    if (entry == top) state.primarySession = state.sessionInfoCount;
    state.sessionInfoCount++;
  }
  state.hiddenSessions = hidden_;

  const bool agentFinished = agentFinished_ && nowMs - agentFinishedAtMs_ < timing_.doneMs;
  state.copilotNotification = agentFinished;
  Mood mood = agentFinished ? Mood::Done :
    top ? (top->closed || top->state == Mood::Idle ? Mood::Done : top->state) : Mood::Idle;
  // Resting (idle/closed) sessions share the Done mood but keep the sleeping clip; only real completion celebrates.
  const char *clip = !agentFinished && top && (top->closed || top->state == Mood::Idle) ? "idle" : moodName(mood);
  const char *task = mood == Mood::Thinking && top && top->activity[0]
    ? activityLabel(parseActivity(top->activity))
    : defaultTaskForMood(mood);

  if (mona_ && alert_.kind[0]) {
    AlertMood(alert_.kind, mood, clip, task);
    state.alert = alert_;
    state.tool[0] = '\0';
  } else if (!agentFinished && top && top->tool[0]) {
    strlcpy(state.tool, top->tool, sizeof(state.tool));
  }

  if (!online_) {
    state.mood = Mood::Disconnected;
    if (mona_ && clip && isMonaClip(clip)) {
      strlcpy(state.clip, clip, sizeof(state.clip));
    } else {
      state.clip[0] = '\0';
    }
    strlcpy(state.task, "OFFLINE", sizeof(state.task));
    setMoodRingDefaults(state);
    return state;
  }

  state.mood = mood;
  strlcpy(state.clip, clip ? clip : "", sizeof(state.clip));
  strlcpy(state.task, task ? task : "", sizeof(state.task));
  setMoodRingDefaults(state);
  return state;
}

bool OrbEngine::takeStateIfDirty(OrbState &out, uint32_t nowMs) {
  if (!dirty_) return false;
  out = snapshot(nowMs);
  dirty_ = false;
  return true;
}
