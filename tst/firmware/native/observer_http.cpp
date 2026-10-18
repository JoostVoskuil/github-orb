#include <ArduinoJson.h>
#include <assert.h>
#include <math.h>
#include <string>

#include "orb_engine.h"

using String = std::string;
constexpr int portMAX_DELAY = 0;
inline void xSemaphoreTake(int, int) {}
inline void xSemaphoreGive(int) {}
inline uint32_t millis() { return 10000; }

class OrbServer {
 public:
  OrbEngine engine;
  int status = 0;
  JsonDocument response;
  struct {
    String body;
    String arg(const char *) { return body; }
  } server_;

  OrbServer() { engine.setOnline(true); }
  void handleEvent();
  void post(const JsonDocument &request) {
    server_.body.clear();
    serializeJson(request, server_.body);
    handleEvent();
  }

 private:
  int engineMutex_ = 0;
  OrbEngine *engine_ = &engine;
  bool authorized() { return true; }
  void sendJson(int code, const JsonDocument &doc) {
    status = code;
    response.set(doc);
  }
};

#include "event-handler.inc"

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

  message["sequence"] = 5;
  message["state"] = "invalid";
  message.remove("attention");
  server.post(message);
  assert(server.status == 400);
  assert(server.response["error"] == "invalid_observer_event");

  message["sequence"] = 6;
  message["state"] = "done";
  server.post(message);
  assert(server.status == 202);
  assert(server.engine.snapshot(millis()).mood == Mood::Done);

  JsonDocument end;
  deserializeJson(end, R"({
    "source":"cli","event":"observerEnd","observerVersion":1,
    "sessionId":"http-session","instanceId":"12345678-1234-1234-1234-123456789abc",
    "startedAt":1792331680688,"sequence":7
  })");
  server.post(end);
  assert(server.status == 202);
  assert(server.engine.snapshot(millis()).sessionCount == 0);
}
