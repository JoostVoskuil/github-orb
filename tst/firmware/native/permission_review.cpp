#include <assert.h>
#include <string>
#include "orb_engine.h"
#include "permission_review.h"

int main() {
  static_assert(sizeof(OrbState) < 2048, "Keep review text out of compact state snapshots");
  const char *owner = "11111111-1111-1111-1111-111111111111";
  const char *replacement = "22222222-2222-2222-2222-222222222222";
  OrbEngine engine;
  engine.setOnline(true);
  OrbEngine::ObserverExtras x;
  x.hasAttention = true;
  x.attentionId = "0123456789abcdef";
  x.attentionKind = "shell";
  x.pending = 1;
  x.command = "printf 'hello'\nprintf 'world'\n";
  uint32_t sequence = 0;
  auto update = [&](uint32_t now) {
    return engine.handleObserver("a", "observerState", owner, 1000, ++sequence, "needsInput",
      nullptr, nullptr, nullptr, nullptr, now, nullptr, nullptr, 0, 0, false, &x);
  };
  assert(!update(100));
  assert(!engine.snapshot(100).sessions[0].attention.actionable); // optional false default
  assert(!engine.queuePermissionDecision("a", x.attentionId, "approve", 101));
  x.actionable = true;
  assert(!update(102));
  OrbState::PermissionReviewDetails review;
  assert(engine.permissionReview("a", x.attentionId, 102, review));
  const auto token = review.token;
  assert(token);
  assert(!strcmp(review.commandText(), x.command));
  assert(!engine.queuePermissionDecision("missing", x.attentionId, "approve", 103));
  assert(!engine.queuePermissionDecision("a", "1111111111111111", "approve", 103));
  assert(!engine.queuePermissionDecision("a", x.attentionId, "allow", 103));
  assert(!engine.queuePermissionDecision("a", x.attentionId, "approve", 103, token + 1));
  assert(engine.queuePermissionDecision("a", x.attentionId, "approve", 103, token));
  assert(!engine.queuePermissionDecision("a", x.attentionId, "deny", 104, token));
  OrbEngine::PermissionDecision decision;
  assert(!engine.permissionDecision("a", replacement, 1000, 104, decision));
  assert(!engine.permissionDecision("a", owner, 1001, 104, decision));
  assert(engine.permissionDecision("a", owner, 1000, 104, decision));
  assert(!strcmp(decision.decision, "approve"));
  assert(!update(105));
  assert(engine.permissionDecision("a", owner, 1000, 105, decision)); // retry reply until changed
  assert(engine.permissionReview("a", x.attentionId, 105, review) && review.token == token);
  engine.tick(30103);
  assert(!engine.permissionDecision("a", owner, 1000, 30103, decision));
  assert(!update(30104));
  assert(!engine.queuePermissionDecision("a", x.attentionId, "deny", 30105)); // one-shot even after expiry

  x.attentionId = "fedcba9876543210";
  assert(!update(30106));
  assert(!engine.queuePermissionDecision("a", x.attentionId, "approve", 60106)); // stale observer
  assert(!update(60107));
  assert(engine.queuePermissionDecision("a", x.attentionId, "deny", 60108));
  assert(engine.permissionReview("a", x.attentionId, 60108, review));
  const auto replacedToken = review.token;
  assert(!engine.handleObserver("a", "observerState", replacement, 2000, 1, "needsInput",
    nullptr, nullptr, nullptr, nullptr, 60109, nullptr, nullptr, 0, 0, false, &x));
  // A retained review owns its old immutable text even after replacement/removal.
  const auto retained = review;
  assert(!strcmp(retained.commandText(), "printf 'hello'\nprintf 'world'\n"));
  assert(!engine.permissionDecision("a", owner, 1000, 60109, decision));
  assert(!engine.permissionDecision("a", replacement, 2000, 60109, decision));
  assert(!engine.queuePermissionDecision("a", x.attentionId, "approve", 60110, replacedToken));
  assert(engine.queuePermissionDecision("a", x.attentionId, "deny", 60111));
  assert(!engine.handleObserver("a", "observerEnd", replacement, 2000, 2, nullptr,
    nullptr, nullptr, nullptr, nullptr, 60112));
  assert(!engine.permissionDecision("a", replacement, 2000, 60112, decision));
  assert(!engine.queuePermissionDecision("a", x.attentionId, "approve", 60113));

  for (const char *kind : {"question", "plan", "limits"}) {
    OrbEngine only;
    x.attentionKind = kind;
    x.command = nullptr;
    assert(only.handleObserver("b", "observerState", owner, 1000, 1, "needsInput",
      nullptr, nullptr, nullptr, nullptr, 0, nullptr, nullptr, 0, 0, false, &x));
    x.actionable = false;
    assert(!only.handleObserver("b", "observerState", owner, 1000, 1, "needsInput",
      nullptr, nullptr, nullptr, nullptr, 0, nullptr, nullptr, 0, 0, false, &x));
    assert(!only.queuePermissionDecision("b", x.attentionId, "approve", 1));
    x.actionable = true;
  }

  OrbEngine bounded;
  x.attentionKind = "shell";
  std::string command(1024, 'x');
  command[25] = '\n';
  x.command = command.c_str();
  assert(!bounded.handleObserver("b", "observerState", owner, 1000, 1, "needsInput",
    nullptr, nullptr, nullptr, nullptr, 0, nullptr, nullptr, 0, 0, false, &x));
  assert(bounded.permissionReview("b", x.attentionId, 0, review));
  assert(strlen(review.commandText()) == 1024);
  command += 'x';
  x.command = command.c_str();
  assert(bounded.handleObserver("b", "observerState", owner, 1000, 2, "needsInput",
    nullptr, nullptr, nullptr, nullptr, 1, nullptr, nullptr, 0, 0, false, &x));
  assert(!bounded.handleObserver("b", "observerState", owner, 1000, 2, "thinking",
    nullptr, nullptr, nullptr, nullptr, 1));
  assert(!bounded.queuePermissionDecision("b", x.attentionId, "approve", 2));

  // All actionable kinds require complete review text, not just shell commands.
  for (const char *kind : {"shell", "write", "read", "url", "mcp", "memory", "custom-tool", "other"}) {
    OrbEngine typed;
    x.attentionKind = kind;
    x.command = nullptr;
    x.actionable = true;
    auto send = [&](uint32_t seq) {
      return typed.handleObserver("b", "observerState", owner, 1000, seq, "needsInput",
        nullptr, nullptr, nullptr, nullptr, 0, nullptr, nullptr, 0, 0, false, &x);
    };
    assert(send(1));
    x.actionable = false;
    assert(!send(1)); // legacy read-only attention remains accepted
    x.actionable = true;
    x.command = "{\"kind\":\"review\",\n\"details\":\"complete UTF-8: café 🐙\"}";
    assert(!send(2));
    assert(typed.permissionReview("b", x.attentionId, 0, review));
    assert(!strcmp(review.commandText(), x.command));
    const auto validToken = review.token;
    for (const char *invalid : {"", " \t\n\r", "\xc2\xa0\xe3\x80\x80", "bad\x01", "bad\x7f",
        "bad\xc2\x80", "bad\xc2\x9f", "bad\xc0\xaf", "bad\xed\xa0\x80", "bad\xf4\x90\x80\x80",
        "bad\x80", "bad\xe2\x82", "bad\xe2(\xa1"}) {
      x.command = invalid;
      assert(send(3));
      assert(typed.permissionReview("b", x.attentionId, 0, review) && review.token == validToken);
      assert(strstr(review.commandText(), "complete UTF-8"));
    }
  }

  using namespace PermissionReview;
  assert(validCommand("printf '\\n'\n\tprintf 'café 🐙'\r\n"));
  for (unsigned c = 1; c <= 0x9f; c++) {
    if (c > 0x1f && c < 0x7f) continue;
    std::string text = "x";
    if (c >= 0x80) { text += '\xc2'; text += static_cast<char>(c); }
    else text += static_cast<char>(c);
    assert(validCommand(text.c_str()) == (c == '\t' || c == '\n' || c == '\r'));
  }
  std::string utf8;
  for (size_t i = 0; i < 256; i++) utf8 += "🐙";
  assert(utf8.size() == 1024 && validCommand(utf8.c_str()));
  utf8 += 'x';
  assert(!validCommand(utf8.c_str()));
  TapMotion motion;
  motion.begin(300, 350);
  motion.update(312, 350);
  assert(!motion.cancelled); // exactly 12 pixels is still a tap
  motion.update(312, 351);
  assert(motion.cancelled);
  motion.update(300, 350);
  assert(motion.cancelled); // returning to Approve does not re-arm
  motion.begin(300, 350);
  assert(!motion.cancelled);
  motion.update(0, 0);
  assert(motion.cancelled);
  motion.begin(0, 0);
  motion.update(65535, 65535);
  assert(motion.cancelled); // no squared-distance overflow
  assert(hit(100, 350) == Hit::Deny);
  assert(hit(380, 350) == Hit::Approve); // outside ring's inner radius: controls must win
    assert(hit(100, 300) == Hit::None);
    assert(hit(300, 300) == Hit::None);
  assert(hit(240, 240) == Hit::None);
    assert(canApprove(true, false, false)); // no confirmation or page-review gate
    assert(!canApprove(true, true, false));
    assert(!canApprove(true, false, true));
  auto p = page("one\ntwo", 0);
  assert(!strcmp(p.lines[0], "one") && !strcmp(p.lines[1], "two"));
  p = page("\\\t\r\x1b\xc3\xa9", 0);
  assert(!strcmp(p.lines[0], "\\\\\\x09\\x0D\\x1B\\xC3\\xA9"));
  std::string full(1024, 'z'), reviewed;
  const size_t count = page(full.c_str(), 0).count;
  assert(count == 7);
  for (size_t i = 0; i < count; i++) {
    p = page(full.c_str(), i);
    assert(p.count == count);
    for (const auto &line : p.lines) reviewed += line;
  }
  assert(reviewed == full); // no silent truncation at page or command boundaries
  full.assign(1024, '\n');
  assert(page(full.c_str(), 0).count == 171); // size_t, not a small page counter
}