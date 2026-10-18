#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "orb_engine.h"

int main() {
  OrbEngine engine;
  engine.setOnline(true);

  OrbState state = engine.snapshot(100);
  assert(state.mood == Mood::Idle);
  assert(!state.mona);
  assert(!strcmp(state.task, "Resting"));
  assert(state.ringMode == RingMode::Animated);
  assert(state.ringAnimation == RingAnimation::Chase);
  assert(!idleRingAnimationExpired(state.mood, 100, 120099));
  assert(idleRingAnimationExpired(state.mood, 100, 120100));
  assert(!idleRingAnimationExpired(Mood::Thinking, 100, 200000));

  // Unknown events and sources are rejected.
  assert(!engine.handleEvent("vscode", "s1", "unknownEvent", nullptr, 100));
  assert(!engine.handleEvent("unknown", "s1", "userPromptSubmit", nullptr, 100));

  // User prompt -> thinking; tool -> dynamic tool label.
  assert(engine.handleEvent("vscode", "s1", "UserPromptSubmit", nullptr, 200));
  state = engine.snapshot(200);
  assert(state.mood == Mood::Thinking);
  assert(!strcmp(state.task, "Working"));
  assert(state.sessionCount == 1);
  assert(state.sourceMask == OrbEngine::kSourceVscode);

  assert(engine.handleEvent("vscode", "s1", "PreToolUse", "run_in_terminal", 300));
  state = engine.snapshot(300);
  assert(state.mood == Mood::Tool);
  assert(!strcmp(state.task, "Executing"));
  assert(!strcmp(state.tool, "run_in_terminal"));

  // Pending tool promotes to needsInput after approvalDelayMs (8000ms).
  assert(!engine.tick(8200));
  assert(engine.tick(8301));
  state = engine.snapshot(8301);
  assert(state.mood == Mood::NeedsInput);
  assert(!strcmp(state.task, "Input needed"));

  // Ignored subagent tools never trigger needsInput via approval delay.
  assert(engine.handleEvent("cli", "s2", "preToolUse", "execution_subagent", 9000));
  assert(engine.handleEvent("vscode", "s1", "postToolUse", nullptr, 9000));
  assert(!engine.tick(20000));
  state = engine.snapshot(20000);
  assert(state.mood == Mood::Tool);
  assert(!strcmp(state.task, "Executing"));
  assert(state.sourceMask == (OrbEngine::kSourceVscode | OrbEngine::kSourceCli));

  // Ask-user tools immediately enter needsInput and outrank working sessions.
  assert(engine.handleEvent("vscode", "s1", "PreToolUse", "vscode_askQuestions", 20100));
  state = engine.snapshot(20100);
  assert(state.mood == Mood::NeedsInput);

  // Sticky Mona alert masks Copilot sessions until locally acknowledged.
  OrbState::Alert alert;
  strlcpy(alert.id, "pr:1", sizeof(alert.id));
  strlcpy(alert.kind, "reviewRequested", sizeof(alert.kind));
  strlcpy(alert.title, "Fix ESP32 standalone mode", sizeof(alert.title));
  strlcpy(alert.url, "https://github.com/octocat/hello/pull/1", sizeof(alert.url));
  strlcpy(alert.repository, "octocat/hello", sizeof(alert.repository));
  alert.ownerIsOrganization = false;
  const uint64_t beforeAlertId = state.presentationId;
  assert(engine.handleGitHubAlert(alert, 21000));
  state = engine.snapshot(21000);
  assert(state.mona);
  assert(state.mood == Mood::ReviewRequested);
  assert(!strcmp(stateClip(state), "mona-pr"));
  assert(!strcmp(state.task, "PR needs review"));
  assert(state.presentationId == beforeAlertId + 1);
  assert(state.sessionCount == 2);
  assert(!state.alert.ownerIsOrganization);

  // sessionEnd removes a session but does NOT switch sticky Mona back to Copilot.
  assert(engine.handleEvent("cli", "s2", "sessionEnd", nullptr, 22000));
  state = engine.snapshot(22000);
  assert(state.mona);
  assert(state.sessionCount == 1);

  // Offline preserves mascot identity and clip while showing OFFLINE.
  engine.setOnline(false);
  state = engine.snapshot(22500);
  assert(state.mood == Mood::Disconnected);
  assert(state.mona);
  assert(!strcmp(stateClip(state), "mona-pr"));
  assert(!strcmp(state.task, "OFFLINE"));
  engine.setOnline(true);

  // Copilot events update underneath Mona without restarting the alert clip.
  assert(engine.handleEvent("vscode", "s1", "Stop", nullptr, 23000));
  state = engine.snapshot(23000);
  assert(state.mona);
  assert(state.presentationId == beforeAlertId + 1);
  assert(!engine.acknowledgeAlert("wrong"));
  assert(engine.acknowledgeAlert(alert.id));
  assert(!engine.acknowledgeAlert(alert.id));
  state = engine.snapshot(23000);
  assert(!state.mona);
  assert(state.mood == Mood::Done);
  assert(state.ringMode == RingMode::Solid);

  OrbEngine mapping;
  mapping.setOnline(true);
  assert(mapping.handleEvent("vscode", "s1", "UserPromptSubmit", nullptr, 1000));

  OrbState::Alert genericAlert;
  strlcpy(genericAlert.id, "other:1", sizeof(genericAlert.id));
  strlcpy(genericAlert.kind, "githubNotification", sizeof(genericAlert.kind));
  strlcpy(genericAlert.title, "Issue mentioned", sizeof(genericAlert.title));
  strlcpy(genericAlert.url, "https://github.com/octocat/hello", sizeof(genericAlert.url));
  strlcpy(genericAlert.repository, "octocat/hello", sizeof(genericAlert.repository));
  assert(mapping.handleGitHubAlert(genericAlert, 2000));
  state = mapping.snapshot(2000);
  assert(state.mona && state.mood == Mood::NeedsInput);
  assert(!strcmp(stateClip(state), "mona-pr"));
  assert(!strcmp(state.task, "GitHub needs attention"));
  assert(mapping.acknowledgeAlert(genericAlert.id));

  OrbState::Alert workflowAlert;
  strlcpy(workflowAlert.id, "ci:1", sizeof(workflowAlert.id));
  strlcpy(workflowAlert.kind, "workflowFailure", sizeof(workflowAlert.kind));
  strlcpy(workflowAlert.title, "CI activity", sizeof(workflowAlert.title));
  strlcpy(workflowAlert.url, "https://github.com/octocat/hello/actions", sizeof(workflowAlert.url));
  strlcpy(workflowAlert.repository, "octocat/hello", sizeof(workflowAlert.repository));
  assert(mapping.handleGitHubAlert(workflowAlert, 2200));
  state = mapping.snapshot(2200);
  assert(state.mona && state.mood == Mood::WorkflowFailure);
  assert(!strcmp(stateClip(state), "mona-workflow"));
  assert(!strcmp(state.task, "Workflow failed"));
  assert(mapping.acknowledgeAlert(workflowAlert.id));

  OrbState::Alert securityAlert;
  strlcpy(securityAlert.id, "security:1", sizeof(securityAlert.id));
  strlcpy(securityAlert.kind, "securityAlert", sizeof(securityAlert.kind));
  strlcpy(securityAlert.title, "Security alert", sizeof(securityAlert.title));
  strlcpy(securityAlert.url, "https://github.com/octocat/hello/security", sizeof(securityAlert.url));
  strlcpy(securityAlert.repository, "octocat/hello", sizeof(securityAlert.repository));
  assert(mapping.handleGitHubAlert(securityAlert, 2400));
  state = mapping.snapshot(2400);
  assert(state.mona && state.mood == Mood::SecurityAlert);
  assert(!strcmp(stateClip(state), "mona-security"));
  assert(mapping.acknowledgeAlert(securityAlert.id));

  OrbState::Alert finishedAlert;
  strlcpy(finishedAlert.id, "finished:1", sizeof(finishedAlert.id));
  strlcpy(finishedAlert.kind, "agentSessionFinished", sizeof(finishedAlert.kind));
  assert(mapping.handleGitHubAlert(finishedAlert, 3000));
  state = mapping.snapshot(3000);
  assert(!state.mona && state.mood == Mood::Done && !strcmp(state.clip, "done"));
  assert(state.copilotNotification);
  assert(mapping.tick(13000));
  state = mapping.snapshot(13000);
  assert(state.mood == Mood::Thinking);

  // Completed sessions keep the done presentation until the two-minute sleep boundary.
  assert(engine.tick(33001));
  state = engine.snapshot(33001);
  assert(state.mood == Mood::Done);
  assert(state.sessions[state.primarySession].stateSinceMs == 33001);
  assert(engine.tick(33001 + 15UL * 60UL * 1000UL + 1));
  state = engine.snapshot(33001 + 15UL * 60UL * 1000UL + 1);
  assert(state.sessionCount == 0);

  // Names upgrade id -> project -> title, never downgrade, and are bounded.
  OrbEngine named;
  const uint32_t t = 100000;
  assert(named.handleEvent("vscode", "a21332e3-bd5a-4370", "SessionStart", nullptr, t));
  state = named.snapshot(t);
  assert(state.sessionInfoCount == 1 && !strcmp(state.sessions[0].name, "a21332e3"));
  assert(named.handleEvent("vscode", "a21332e3-bd5a-4370", "PreToolUse", "run_in_terminal", t + 1, nullptr, "copilotesp32"));
  state = named.snapshot(t + 1);
  assert(!strcmp(state.sessions[0].name, "copilotesp32"));
  assert(!strcmp(state.sessions[0].tool, "run_in_terminal"));
  assert(named.handleEvent("vscode", "a21332e3-bd5a-4370", "UserPromptSubmit", nullptr, t + 2, "  Fix\nthe   build  ", "copilotesp32"));
  state = named.snapshot(t + 2);
  assert(!strcmp(state.sessions[0].name, "Fix the build"));
  assert(named.handleEvent("vscode", "a21332e3-bd5a-4370", "UserPromptSubmit", nullptr, t + 3, "Second prompt", "other"));
  state = named.snapshot(t + 3);
  assert(!strcmp(state.sessions[0].name, "Fix the build"));
  assert(named.handleEvent("cli", "long", "UserPromptSubmit", nullptr, t + 4,
                           "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"));
  state = named.snapshot(t + 4);
  assert(state.sessionInfoCount == 2 && strlen(state.sessions[1].name) == 40);

  // A chat title always wins over prompt labels and follows renames.
  assert(named.handleEvent("vscode", "a21332e3-bd5a-4370", "Stop", nullptr, t + 5, nullptr, nullptr,
                           "Simulate mode behavior adjustments"));
  state = named.snapshot(t + 5);
  assert(!strcmp(state.sessions[0].name, "Simulate mode behavior adjustments"));
  assert(named.handleEvent("vscode", "a21332e3-bd5a-4370", "UserPromptSubmit", nullptr, t + 6, "Third prompt", "x"));
  state = named.snapshot(t + 6);
  assert(!strcmp(state.sessions[0].name, "Simulate mode behavior adjustments"));
  assert(state.sessions[state.primarySession].state == Mood::Thinking);

  OrbEngine observer;
  observer.setOnline(true);
  const char *owner = "11111111-1111-1111-1111-111111111111";
  const char *nextOwner = "22222222-2222-2222-2222-222222222222";
  assert(!observer.handleObserver("one", "observerState", owner, 1000, 1, "tool", "bash", nullptr, "test",
                                  "Initial session title", 0, "Code reviewer", "GPT-5.4", 120, 34, true));
  assert(!strcmp(observer.snapshot(0).sessions[0].name, "Initial session title"));
  state = observer.snapshot(0);
  assert(!strcmp(state.agent, "Code reviewer"));
  assert(!strcmp(state.model, "GPT-5.4"));
  assert(state.hasTokenUsage && state.inputTokens == 120 && state.outputTokens == 34);
  observer.tick(9000);
  assert(observer.snapshot(9000).mood == Mood::Tool);
  assert(!observer.handleEvent("cli", "one", "Stop", nullptr, 9001));
  const uint64_t original = observer.snapshot(9001).presentationId;
  assert(observer.snapshot(10000).presentationId == original);
  assert(observer.handleObserver("one", "observerState", owner, 1000, 1, "done", nullptr, nullptr, nullptr, nullptr, 10001));
  assert(!observer.handleObserver("one", "observerState", nextOwner, 2000, 1, "done", nullptr, nullptr, nullptr, nullptr, 11000));
  state = observer.snapshot(11000);
  assert(state.sessionCount == 1);
  assert(!state.hasTokenUsage && state.model[0] == '\0' && state.inputTokens == 0);
  assert(observer.handleObserver("one", "observerState", owner, 1000, 3, "error", nullptr, nullptr, nullptr, nullptr, 11001));
  assert(!observer.handleObserver("one", "observerState", nextOwner, 2000, 2, "done", nullptr, nullptr, nullptr, nullptr, 20000));
  observer.tick(21001);
  assert(observer.snapshot(21001).mood == Mood::Done);
  assert(!observer.handleObserver("one", "observerState", nextOwner, 2000, 3, "done", nullptr, nullptr, nullptr, nullptr, 22000));
  assert(observer.snapshot(22000).mood == Mood::Done);
  assert(observer.handleGitHubAlert(alert, 23000));
  const uint64_t newsId = observer.snapshot(23000).presentationId;
  assert(!observer.handleObserver("one", "observerState", nextOwner, 2000, 5, "done", nullptr, nullptr, "rename", nullptr, 25000));
  assert(observer.snapshot(25000).mona);
  assert(observer.snapshot(25000).presentationId == newsId);
  assert(!strcmp(observer.snapshot(25000).sessions[0].name, "Initial session title"));
  assert(!observer.handleObserver("one", "observerState", nextOwner, 2000, 6, "thinking", nullptr, "thinking", nullptr, nullptr, 26000));
  assert(observer.snapshot(26000).mona);
  assert(observer.snapshot(26000).presentationId == newsId);
  assert(observer.acknowledgeAlert(alert.id));
  assert(observer.snapshot(26000).mood == Mood::Thinking);
  assert(!strcmp(observer.snapshot(26000).task, "Working"));
  assert(!observer.snapshot(26000).mona);
  assert(!observer.handleObserver("one", "observerState", nextOwner, 2000, 7, "thinking", nullptr, "evaluating", nullptr, "Updated session title", 26500));
  assert(observer.snapshot(26500).mood == Mood::Thinking);
  assert(!strcmp(observer.snapshot(26500).task, "Evaluating"));
  assert(observer.snapshot(26500).sessions[0].activity == Activity::Evaluating);
  assert(!strcmp(observer.snapshot(26500).sessions[0].name, "Updated session title"));
  assert(!observer.handleObserver("one", "observerState", nextOwner, 2000, 8, "thinking", nullptr, "analysing", nullptr, nullptr, 26600));
  assert(!strcmp(observer.snapshot(26600).task, "Analysing"));
  assert(observer.snapshot(26600).sessions[0].activity == Activity::Analysing);
  assert(observer.handleObserver("one", "observerState", nextOwner, 2000, 9, "thinking", nullptr, "private intent", nullptr, nullptr, 26700));
  assert(!observer.handleObserver("one", "observerEnd", nextOwner, 2000, 10, nullptr, nullptr, nullptr, nullptr, nullptr, 27000));
  assert(observer.snapshot(27000).sessionCount == 0);
  assert(observer.handleObserver("one", "observerState", nextOwner, 2000, 11, "tool", nullptr, nullptr, nullptr, nullptr, 28000));
  assert(observer.handleObserver("missing", "observerPing", owner, 1000, 1, nullptr, nullptr, nullptr, nullptr, nullptr, 29000));
  assert(observer.handleObserver("bad/id", "observerState", owner, 1000, 1, "idle", nullptr, nullptr, nullptr, nullptr, 29000));
  assert(observer.handleObserver("new", "observerState", owner, 1000, 1, "disconnected", nullptr, nullptr, nullptr, nullptr, 29000));
  observer.tick(72001);
  assert(observer.snapshot(72001).sessionCount == 0);

  OrbEngine sessionList;
  sessionList.setOnline(true);
  for (uint8_t i = 0; i < OrbEngine::kMaxSessions; i++) {
    char id[8];
    snprintf(id, sizeof(id), "s%u", i);
    assert(sessionList.handleEvent("sim", id, "UserPromptSubmit", nullptr, 30000 + i));
  }
  state = sessionList.snapshot(30020);
  assert(state.sessionCount == OrbEngine::kMaxSessions);
  assert(state.sessionInfoCount == OrbState::kMaxSessionInfos);
  // Completed sessions stay visible for two minutes, then their display entry is freed.
  const uint32_t MIN = 60000;
  OrbEngine ended;
  ended.setOnline(true);
  assert(!ended.handleObserver("a", "observerState", owner, 1000, 1, "thinking", nullptr, nullptr, nullptr, "Work", 0));
  assert(!ended.handleObserver("a", "observerState", owner, 1000, 2, "done", nullptr, nullptr, nullptr, nullptr, 1000));
  state = ended.snapshot(1000);
  assert(state.sessionInfoCount == 1 && state.sessions[0].ended && state.sessions[0].finished && !state.sessions[0].closed);
  ended.tick(2 * MIN + 999);
  state = ended.snapshot(2 * MIN + 999);
  assert(state.sessionInfoCount == 1 && state.mood == Mood::Done);
  ended.tick(2 * MIN + 1000);
  state = ended.snapshot(2 * MIN + 1000);
  assert(state.sessionInfoCount == 0 && state.sessionCount == 1 && state.mood == Mood::Idle);

  // Closing shows finished dots for two minutes and then frees the entry.
  OrbEngine closing;
  closing.setOnline(true);
  assert(!closing.handleObserver("a", "observerState", owner, 1000, 1, "tool", "bash", nullptr, nullptr, nullptr, 0));
  assert(!closing.handleObserver("a", "observerEnd", owner, 1000, 2, nullptr, nullptr, nullptr, nullptr, nullptr, 1000));
  state = closing.snapshot(2000);
  assert(state.sessionInfoCount == 1 && state.sessions[0].closed && state.sessionCount == 0 && state.mood == Mood::Done);
  closing.tick(1000 + 2 * MIN);
  assert(closing.snapshot(1000 + 2 * MIN).sessionInfoCount == 0);

  OrbEngine inactivity;
  inactivity.setOnline(true);
  assert(inactivity.handleEvent("sim", "a", "SessionStart", nullptr, 100));
  inactivity.tick(120099);
  assert(inactivity.snapshot(120099).mood == Mood::Done);
  inactivity.tick(120100);
  assert(inactivity.snapshot(120100).sessionInfoCount == 0);
  assert(inactivity.snapshot(120100).mood == Mood::Idle);
  assert(inactivity.handleEvent("sim", "a", "Thinking", nullptr, 121000));
  assert(inactivity.snapshot(121000).mood == Mood::Thinking);

  OrbEngine persistentObserver;
  persistentObserver.setOnline(true);
  assert(!persistentObserver.handleObserver("a", "observerState", owner, 1000, 1, "thinking", nullptr, nullptr, nullptr, nullptr, 1000));
  persistentObserver.tick(15UL * 60UL * 1000UL);
  state = persistentObserver.snapshot(15UL * 60UL * 1000UL);
  assert(state.sessionCount == 1 && state.sessionInfoCount == 1 && !state.sessions[0].closed);
  assert(!persistentObserver.handleObserver("a", "observerEnd", owner, 1000, 2, nullptr, nullptr, nullptr, nullptr, nullptr,
                                            15UL * 60UL * 1000UL + 1));
  state = persistentObserver.snapshot(15UL * 60UL * 1000UL + 1);
  assert(state.sessionCount == 0 && state.sessions[0].closed);
  assert(!strcmp(persistentObserver.handleObserver("a", "observerPing", owner, 1000, 3,
                                                   nullptr, nullptr, nullptr, nullptr, nullptr, 15UL * 60UL * 1000UL + 2),
                 "invalid_observer_event"));

  // At most three sticky slots; urgent sessions displace ended ones.
  OrbEngine slots;
  slots.setOnline(true);
  assert(!slots.handleObserver("a", "observerState", owner, 1000, 1, "thinking", nullptr, nullptr, nullptr, nullptr, 0));
  assert(!slots.handleObserver("b", "observerState", owner, 1000, 1, "thinking", nullptr, nullptr, nullptr, nullptr, 1));
  assert(!slots.handleObserver("c", "observerState", owner, 1000, 1, "done", nullptr, nullptr, nullptr, nullptr, 2));
  assert(!slots.handleObserver("d", "observerState", owner, 1000, 1, "idle", nullptr, nullptr, nullptr, nullptr, 3));
  state = slots.snapshot(10);
  assert(state.sessionInfoCount == 3 && state.hiddenSessions == 1);
  assert(!strcmp(state.sessions[0].sessionId, "a") && !strcmp(state.sessions[1].sessionId, "b") &&
         !strcmp(state.sessions[2].sessionId, "c"));
  assert(!slots.handleObserver("b", "observerState", owner, 1000, 2, "tool", "bash", nullptr, nullptr, nullptr, 20));
  state = slots.snapshot(20);
  assert(!strcmp(state.sessions[1].sessionId, "b") && state.primarySession == 1);
  assert(!slots.handleObserver("d", "observerState", owner, 1000, 2, "needsInput", nullptr, nullptr, nullptr, nullptr, 30));
  state = slots.snapshot(30);
  assert(!strcmp(state.sessions[2].sessionId, "d") && state.primarySession == 2 && state.mood == Mood::NeedsInput);

  // Per-session metadata and attention details.
  OrbEngine meta;
  meta.setOnline(true);
  OrbEngine::ObserverExtras extras;
  extras.subagent = "explore";
  extras.contextPercent = 42;
  extras.hasBusy = true;
  extras.busyForMs = 61000;
  extras.hasAttention = true;
  extras.attentionId = "0123456789abcdef";
  extras.attentionKind = "shell";
  extras.reason = "Run the unit tests";
  extras.preview = "npm test";
  extras.pending = 1;
  assert(!meta.handleObserver("a", "observerState", owner, 1000, 1, "needsInput", nullptr, nullptr, nullptr, "Fix",
                              1000000, "Planner", "GPT-5.4", 100, 7, true, &extras));
  state = meta.snapshot(1010000);
  const OrbState::SessionInfo &info = state.sessions[0];
  assert(!strcmp(info.agent, "Planner") && !strcmp(info.subagent, "explore") && !strcmp(info.model, "GPT-5.4"));
  assert(info.contextPercent == 42 && info.busy && 1010000 - info.busySinceMs == 71000);
  assert(info.attention.active && info.attention.kind == AttentionKind::Shell);
  assert(!strcmp(info.attention.preview, "npm test"));
  assert(!meta.handleObserver("a", "observerState", owner, 1000, 2, "thinking", nullptr, nullptr, nullptr, nullptr, 1000006));
  assert(meta.snapshot(1000007).sessions[0].subagent[0] == '\0');

  // Attention validation mirrors the observer protocol privacy rules.
  OrbEngine invalid;
  OrbEngine::ObserverExtras bad = extras;
  bad.attentionId = "SDK-REQUEST-ID!!";
  assert(invalid.handleObserver("a", "observerState", owner, 1000, 1, "needsInput", nullptr, nullptr, nullptr, nullptr, 0,
                                nullptr, nullptr, 0, 0, false, &bad));
  bad = extras;
  bad.attentionKind = "question";
  assert(invalid.handleObserver("a", "observerState", owner, 1000, 1, "needsInput", nullptr, nullptr, nullptr, nullptr, 0,
                                nullptr, nullptr, 0, 0, false, &bad));
  bad.reason = nullptr;
  bad.preview = nullptr;
  assert(!invalid.handleObserver("a", "observerState", owner, 1000, 1, "needsInput", nullptr, nullptr, nullptr, nullptr, 0,
                                 nullptr, nullptr, 0, 0, false, &bad));
  bad = extras;
  assert(invalid.handleObserver("a", "observerState", owner, 1000, 2, "thinking", nullptr, nullptr, nullptr, nullptr, 0,
                                nullptr, nullptr, 0, 0, false, &bad));
  bad.hasAttention = false;
  bad.contextPercent = 101;
  assert(invalid.handleObserver("a", "observerState", owner, 1000, 2, "thinking", nullptr, nullptr, nullptr, nullptr, 0,
                                nullptr, nullptr, 0, 0, false, &bad));

  // A finished session celebrates with the done clip, then rests with the idle clip.
  OrbEngine celebrate;
  celebrate.setOnline(true);
  assert(!celebrate.handleObserver("c", "observerState", owner, 1000, 1, "tool", "bash", nullptr, nullptr, nullptr, 5000));
  assert(!celebrate.handleObserver("c", "observerState", owner, 1000, 2, "done", nullptr, nullptr, nullptr, nullptr, 6000));
  state = celebrate.snapshot(6000);
  assert(state.mood == Mood::Done && !strcmp(state.clip, "done") && !strcmp(stateClip(state), "done"));
  celebrate.tick(6000 + celebrate.timing().doneMs);
  state = celebrate.snapshot(6000 + celebrate.timing().doneMs);
  assert(state.mood == Mood::Done && !strcmp(state.clip, "idle") && !strcmp(stateClip(state), "idle"));
  return 0;
}
