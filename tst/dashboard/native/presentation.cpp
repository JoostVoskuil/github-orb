#include <cassert>
#include "orb_state.h"
#include "ring_motion.h"

int main() {
  for (uint32_t now : {0u, 100u, 1000u, 1500u, 2200u, 2300u, 0xffffffffu}) {
    uint8_t lit = 0;
    for (uint8_t position = 0; position < 23; position++) {
      const bool expected = (position + 23 - (now / 100) % 23) % 23 < 5;
      assert(runningSessionDot(position, now) == expected);
      if (runningSessionDot(position, now)) lit++;
    }
    assert(lit == 5);
  }
  assert(runningSessionDot(0, 0));
  assert(!runningSessionDot(0, 100));
  assert(runningSessionDot(0, 2200));
  assert(runningSessionDot(0, 2300));
  for (uint8_t count : {24, 36, 72}) {
    for (uint8_t dotCount : {1, 4}) {
      for (uint32_t now : {0u, 1000u, 9999u, 10000u, 0xffffffffu}) {
        uint8_t lit = 0;
        for (uint8_t position = 0; position < count; position++) {
          const uint32_t color = ringDotColor(position, count, dotCount, 0.1f, now);
          assert(color == 0 || color == 0xf85149 || color == 0xf0a020 || color == 0x3fb950 || color == 0x2f81f7);
          if (color) lit++;
        }
        assert(lit == dotCount * 2);
      }
    }
    for (uint8_t position = 0; position < count; position++) {
      assert(ringDotColor(position, count, 4, 0.1f, 0) ==
             ringDotColor(position, count, 4, 0.1f, 10000));
    }
    assert(ringDotColor(0, count, 4, 0.1f, 0) == 0xf85149);
    assert(ringDotColor(0, count, 4, 0.1f, 5000) == 0x3fb950);
  }
  OrbState previous;
  previous.mood = Mood::Thinking;
  previous.presentationId = 10;
  assert(!previous.mona);
  assert(!strcmp(stateClip(previous), "thinking"));
  OrbState next = previous;
  next.serverTimestamp++;
  next.revision++;
  next.sessionCount++;
  assert(!presentationChanged(previous, next));
  next.presentationId = 11;
  assert(presentationChanged(previous, next));
  next.presentationId = 9;
  assert(!presentationChanged(previous, next));
  next.mona = true;
  next.mood = Mood::PrAssigned;
  strcpy(next.task, "PR assigned");
  assert(presentationChanged(previous, next));
  assert(presentationMood(next) == Mood::PrAssigned);
  assert(!strcmp(stateClip(next), "mona-pr"));
  const struct { const char *clip; Mood mood; const char *task; } cases[] = {
    {"mona-pr", Mood::ReviewRequested, "PR needs review"},
    {"mona-workflow", Mood::WorkflowFailure, "Workflow failed"},
    {"mona-security", Mood::SecurityAlert, "Security alert"}
  };
  for (const auto &item : cases) {
    const char *clip = item.clip;
    assert(isMonaClip(clip));
    assert(strlen(clip) <= 15);
    strcpy(next.clip, clip);
    next.mood = item.mood;
    strcpy(next.task, item.task);
    assert(!strcmp(stateClip(next), clip));
    assert(presentationMood(next) == item.mood);
    previous = next;
    next.serverTimestamp++;
    assert(!presentationChanged(previous, next));
    next.presentationId++;
    assert(presentationChanged(previous, next));
  }
  assert(!isMonaClip("error"));
  next.clip[0] = 0;
  strcpy(next.alert.kind, "security");
  assert(!strcmp(stateClip(next), "mona-security"));
  strcpy(next.task, "Security alert");
  assert(!strcmp(alertLabel(next), "Security alert"));
  strcpy(next.alert.kind, "criticalSecurity");
  assert(!strcmp(next.alert.kind, "criticalSecurity"));
  assert(!strcmp(stateClip(next), "mona-security"));
  strcpy(next.alert.kind, "workflowFailure");
  assert(!strcmp(stateClip(next), "mona-workflow"));
  strcpy(next.alert.kind, "prAssigned");
  assert(!strcmp(stateClip(next), "mona-pr"));
  strcpy(next.task, "PR assigned");
  assert(!strcmp(alertLabel(next), "PR assigned"));
  next.mood = Mood::Disconnected;
  assert(presentationMood(next) == Mood::Disconnected);
  assert(sizeof(OrbState) < 2048); // Bounded session list and metadata for the touch overlay
}