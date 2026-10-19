#include <ArduinoJson.h>
#include <assert.h>
#include <math.h>
#include <string>

#include "orb_engine.h"
#include "permission_review.h"

using String = std::string;
constexpr int portMAX_DELAY = 0;
inline void xSemaphoreTake(int, int) {}
inline void xSemaphoreGive(int) {}
uint32_t clockMs = 10000;
inline uint32_t millis() { return clockMs; }

class OrbServer {
 public:
  OrbEngine engine;
  int status = 0;
  JsonDocument response;
  bool authenticated = true;
  struct {
    String body;
    String arg(const char *) { return body; }
  } server_;

  OrbServer() { engine.setOnline(true); }
  void handleEvent();
  void handlePermissionDecision();
  void decide(const char *json) {
    server_.body = json;
    handlePermissionDecision();
  }
  void post(const JsonDocument &request) {
    server_.body.clear();
    serializeJson(request, server_.body);
    handleEvent();
  }

 private:
  int engineMutex_ = 0;
  OrbEngine *engine_ = &engine;
  bool authorized() {
    if (authenticated) return true;
    status = 401;
    response.clear();
    response["error"] = "unauthorized";
    return false;
  }
  void sendJson(int code, const JsonDocument &doc) {
    status = code;
    response.set(doc);
  }
};

#include "event-handler.inc"
#include "permission-handler.inc"

int main() {
  OrbServer server;
  JsonDocument message;
  deserializeJson(message, R"({
    "source":"cli","event":"observerState","observerVersion":1,
    "sessionId":"http-session","instanceId":"12345678-1234-1234-1234-123456789abc",
    "startedAt":1792331680688,"sequence":1,"state":"thinking","tool":null
  })");
  server.post(message);
  assert(server.status == 202);
  assert(server.response["accepted"] == true);
  assert(server.engine.snapshot(millis()).mood == Mood::Thinking);

  message["sequence"] = 2;
  message["activity"] = "analysing";
  message["project"] = "orb-project";
  message["sessionName"] = "Check live Orb";
  message["agent"] = "Copilot";
  message["model"] = "test-model";
  message["subagent"] = "Reviewer";
  server.post(message);
  assert(server.status == 202);
  auto state = server.engine.snapshot(millis());
  assert(state.sessions[0].activity == Activity::Analysing);
  assert(!strcmp(state.sessions[0].name, "Check live Orb"));
  assert(!strcmp(state.sessions[0].agent, "Copilot"));
  assert(!strcmp(state.sessions[0].model, "test-model"));
  assert(!strcmp(state.sessions[0].subagent, "Reviewer"));

  message["sequence"] = 3;
  message["state"] = "tool";
  message["tool"] = "bash";
  message.remove("activity");
  server.post(message);
  assert(server.status == 202);
  assert(!strcmp(server.engine.snapshot(millis()).tool, "bash"));

  message["sequence"] = 4;
  message["state"] = "needsInput";
  message["tool"] = nullptr;
  auto attention = message["attention"].to<JsonObject>();
  attention["id"] = "1234567890abcdef";
  attention["kind"] = "shell";
  attention["reason"] = "Run a harmless command";
  attention["preview"] = "List files";
  attention["pending"] = 1;
  server.post(message);
  assert(server.status == 202);
  state = server.engine.snapshot(millis());
  assert(state.sessions[0].attention.active);
  assert(!strcmp(state.sessions[0].attention.reason, "Run a harmless command"));
  assert(!strcmp(state.sessions[0].attention.preview, "List files"));

  const char *approve = R"({"sessionId":"http-session","attentionId":"1234567890abcdef","decision":"approve"})";
  server.decide(approve);
  assert(server.status == 409); // optional actionable defaults false
  message["attention"]["actionable"] = "true";
  message["sequence"] = 5;
  server.post(message);
  assert(server.status == 400);
  message["attention"]["actionable"] = true;
  message["attention"]["command"] = "printf 'one'\nprintf 'two'";
  server.post(message);
  assert(server.status == 202);
  assert(server.response["permissionDecision"].isUnbound());
  server.authenticated = false;
  server.decide(approve);
  assert(server.status == 401);
  server.authenticated = true;
  server.decide(R"({"sessionId":"http-session","attentionId":"1234567890abcdef","decision":"allow"})");
  assert(server.status == 400);
  server.decide(R"({"sessionId":"http-session","attentionId":"1234567890abcdef","decision":true})");
  assert(server.status == 400);
  server.decide(R"({"sessionId":"http-session","attentionId":"1234567890abcdef","decision":"approve\u0000deny"})");
  assert(server.status == 400);
  server.decide(R"({"sessionId":"http-session","attentionId":"0000000000000000","decision":"approve"})");
  assert(server.status == 409);
  server.decide(approve);
  assert(server.status == 202 && server.response["accepted"] == true);
  server.decide(approve);
  assert(server.status == 409);
  message["sequence"] = 6;
  server.post(message);
  assert(server.status == 202);
  assert(server.response["permissionDecision"]["attentionId"] == "1234567890abcdef");
  assert(server.response["permissionDecision"]["decision"] == "approve");
  message["sequence"] = 7;
  server.post(message);
  assert(server.status == 202 && server.response["permissionDecision"]["decision"] == "approve");
  server.post(message); // rejected sequence never delivers a decision
  assert(server.status == 409 && server.response["permissionDecision"].isUnbound());
  clockMs += 30000;
  message["sequence"] = 8;
  server.post(message);
  assert(server.status == 202 && server.response["permissionDecision"].isUnbound());
  message["sequence"] = 9;
  message["instanceId"] = "22222222-2222-2222-2222-222222222222";
  message["startedAt"] = 1792331680689ULL;
  server.post(message);
  assert(server.status == 202 && server.response["permissionDecision"].isUnbound());
  server.decide(approve);
  assert(server.status == 202);
  message["sequence"] = 10;
  message["attention"]["id"] = "fedcba9876543210";
  server.post(message);
  assert(server.status == 202 && server.response["permissionDecision"].isUnbound());
  server.decide(approve);
  assert(server.status == 409);
  message["sequence"] = 11;
  message["attention"]["command"] = std::string(1024, '\x01'); // JSON expands beyond 4096 bytes
  server.post(message);
  assert(server.status == 400);
  message["attention"]["command"] = std::string("printf '") + std::string(1013, '\t') + "'\r\n";
  server.post(message);
  assert(server.status == 202);
  OrbState::PermissionReviewDetails review;
  assert(server.engine.permissionReview("http-session", "fedcba9876543210", millis(), review));
  assert(strlen(review.commandText()) == 1024);
  assert(!strcmp(review.commandText(), message["attention"]["command"].as<const char *>()));
  const auto validToken = review.token;
  message["sequence"] = 12;
  message["attention"]["command"] = std::string(1025, 'a');
  server.post(message);
  assert(server.status == 400);
  server.server_.body = R"({"source":"cli","event":"observerState","observerVersion":1,"sessionId":"http-session","instanceId":"22222222-2222-2222-2222-222222222222","startedAt":1792331680689,"sequence":12,"state":"needsInput","attention":{"id":"fedcba9876543210","kind":"shell","pending":1,"actionable":true,"command":"a\u0000b"}})";
  server.handleEvent();
  assert(server.status == 400);
  for (const char *invalid : {"", " \t\n\r", "\xc2\xa0", "bad\x01", "bad\x7f", "bad\xc2\x80",
      "bad\xc2\x9f", "bad\xff", "bad\xc0\xaf", "bad\xed\xa0\x80", "bad\xf4\x90\x80\x80", "bad\xe2\x82"}) {
    message["attention"]["command"] = invalid;
    server.post(message);
    assert(server.status == 400);
    assert(server.engine.permissionReview("http-session", "fedcba9876543210", millis(), review));
    assert(review.token == validToken && strlen(review.commandText()) == 1024);
  }
  // Non-shell structured reviews must be complete too; every accepted byte is retained.
  uint32_t seq = 12;
  for (const char *kind : {"shell", "write", "read", "url", "mcp", "memory", "custom-tool", "other"}) {
    message["sequence"] = seq++;
    message["attention"]["kind"] = kind;
    message["attention"].remove("command");
    server.post(message);
    assert(server.status == 400);
    message["attention"]["command"] = "{\"details\":\"café 🐙\",\n\"action\":\"review\"}";
    server.post(message);
    assert(server.status == 202);
    assert(server.engine.permissionReview("http-session", "fedcba9876543210", millis(), review));
    assert(!strcmp(review.commandText(), message["attention"]["command"].as<const char *>()));
  }
  message["sequence"] = seq;
  for (const char *kind : {"question", "plan", "limits"}) {
    message["attention"]["kind"] = kind;
    message["attention"].remove("command");
    message["attention"].remove("reason");
    message["attention"].remove("preview");
    server.post(message);
    assert(server.status == 400);
    message["attention"]["actionable"] = false;
    server.post(message);
    assert(server.status == 202);
    server.decide(R"({"sessionId":"http-session","attentionId":"fedcba9876543210","decision":"deny"})");
    assert(server.status == 409);
    message["sequence"] = message["sequence"].as<unsigned>() + 1;
    message["attention"]["actionable"] = true;
  }

  message["sequence"] = seq + 3;
  message["state"] = "invalid";
  message.remove("attention");
  server.post(message);
  assert(server.status == 400);
  assert(server.response["error"] == "invalid_observer_event");

  message["sequence"] = seq + 4;
  message["state"] = "done";
  server.post(message);
  assert(server.status == 202);
  assert(server.engine.snapshot(millis()).mood == Mood::Done);

  JsonDocument end;
  deserializeJson(end, R"({
    "source":"cli","event":"observerEnd","observerVersion":1,
    "sessionId":"http-session","instanceId":"22222222-2222-2222-2222-222222222222",
    "startedAt":1792331680689,"sequence":17
  })");
  end["sequence"] = seq + 5;
  server.post(end);
  assert(server.status == 202);
  assert(server.engine.snapshot(millis()).sessionCount == 0);
}
