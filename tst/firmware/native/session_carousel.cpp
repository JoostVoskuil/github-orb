#include "session_carousel.h"
#include <cassert>
#include <cmath>

int main() {
  {
    OrbState display;
    display.sessionInfoCount = 3;
    display.primarySession = 2;
    display.sessions[0].state = Mood::Done;
    display.sessions[1].state = Mood::Idle;
    display.sessions[2].state = Mood::NeedsInput;
    strlcpy(display.sessions[2].sessionId, "active", sizeof(display.sessions[2].sessionId));
    keepWorkingSessions(display);
    assert(display.sessionInfoCount == 2 && display.primarySession == 1);
    assert(display.sessions[0].backgroundOnly);
    assert(!strcmp(display.sessions[1].sessionId, "active"));
    keepWorkingSessions(display, 120000);
    assert(display.sessionInfoCount == 1 && display.primarySession == 0);
    display.sessions[0].closed = true;
    keepWorkingSessions(display);
    assert(display.sessionInfoCount == 0);
    display.sessionInfoCount = 3;
    display.sessions[0].state = Mood::Thinking;
    display.sessions[1].state = Mood::Tool;
    display.sessions[2].state = Mood::Error;
    keepWorkingSessions(display);
    assert(display.sessionInfoCount == 2);
  }
  {
    OrbState display;
    display.sessionInfoCount = 2;
    for (int i = 0; i < 2; i++) {
      strlcpy(display.sessions[i].source, "cli", sizeof(display.sessions[i].source));
      display.sessions[i].sessionId[0] = 'a' + i;
      display.sessions[i].state = Mood::Thinking;
    }
    SessionCarousel carousel;
    carousel.update(display, 0, false);
    carousel.select(display, 0, 1, true);
    display.sessions[0].state = Mood::Done;
    display.sessions[0].finished = true;
    display.sessions[0].endedAtMs = 10;
    keepWorkingSessions(display, 10);
    assert(carousel.update(display, 10, true));
    assert(carousel.selected(display) == 1);
    assert(carousel.pose(0, 1, 710).size == 112);
    assert(!carousel.select(display, 0, 800, true));
    keepWorkingSessions(display, 120009);
    assert(display.sessionInfoCount == 2);
    keepWorkingSessions(display, 120010);
    assert(display.sessionInfoCount == 1);
    display.sessions[0].state = Mood::Done;
    keepWorkingSessions(display, 120011);
    assert(display.sessionInfoCount == 0);
  }
  SessionCarousel carousel;
  OrbState state;
  assert(!carousel.update(state, 0, false));
  state.sessionInfoCount = 3;
  for (int i = 0; i < 3; i++) {
    strlcpy(state.sessions[i].source, "cli", sizeof(state.sessions[i].source));
    state.sessions[i].sessionId[0] = 'a' + i;
    state.sessions[i].sessionId[1] = 0;
    state.sessions[i].state = Mood::Thinking;
  }
  carousel.update(state, 0, false);
  assert(carousel.selected(state) == 0);
  assert(carousel.hit(state, 394, 258, 0) == 1);
  assert(carousel.hit(state, 86, 258, 0) == 2);
  state.sessions[1].state = Mood::Tool;
  state.sessions[2].state = Mood::Done;
  carousel.update(state, 1000, false);
  carousel.update(state, 3999, false);
  assert(carousel.selected(state) == 0);
  assert(carousel.update(state, 4000, false));
  assert(carousel.selected(state) == 1);
  auto pose = carousel.pose(1, 1, 4350);
  assert(std::abs(pose.x - 317) < 0.01 && std::abs(pose.size - 184) < 0.01);
  carousel.update(state, 8000, false);
  assert(carousel.selected(state) == 2);
  carousel.update(state, 60000, false);
  assert(carousel.selected(state) == 2);
  state.sessions[0].state = Mood::Error;
  carousel.update(state, 60001, false);
  assert(carousel.selected(state) == 0);
  state.sessions[1].state = Mood::NeedsInput;
  carousel.update(state, 60002, false);
  assert(carousel.selected(state) == 1);
  carousel.select(state, 2, 60010, true);
  carousel.update(state, 66009, false);
  assert(carousel.selected(state) == 2);
  carousel.update(state, 66010, false);
  assert(carousel.selected(state) == 1);
  state.sessions[0].state = Mood::Thinking;
  state.sessions[1].state = Mood::Thinking;
  carousel.update(state, 70010, true);
  assert(carousel.selected(state) == 1);
  carousel.update(state, 70011, false);
  assert(carousel.selected(state) == 0);
  // Reordering keeps selection attached to identity, not the array slot.
  const auto swap = state.sessions[0];
  state.sessions[0] = state.sessions[2];
  state.sessions[2] = swap;
  carousel.update(state, 70012, false);
  assert(carousel.selected(state) == 2);
  state.sessionInfoCount = 0;
  assert(carousel.update(state, 70013, false));
  assert(!carousel.update(state, 70014, false));
  // Dwell arithmetic remains valid across the device millis() rollover.
  state.sessionInfoCount = 3;
  SessionCarousel rollover;
  rollover.update(state, UINT32_MAX - 2000, false);
  state.sessions[1].state = Mood::Tool;
  rollover.update(state, UINT32_MAX - 1000, false);
  rollover.update(state, 1998, false);
  assert(rollover.selected(state) == 0);
  rollover.update(state, 1999, false);
  assert(rollover.selected(state) == 1);
}
