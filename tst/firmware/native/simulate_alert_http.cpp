#include <ArduinoJson.h>
#include <assert.h>
#include <stdio.h>
#include <string>

#include "orb_engine.h"

using String = std::string;
constexpr int portMAX_DELAY = 0;
inline void xSemaphoreTake(int, int) {}
inline void xSemaphoreGive(int) {}
inline uint32_t millis() { return 12345; }

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
  void handleSimulateAlert();
  void post(const char *body) {
    server_.body = body;
    handleSimulateAlert();
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

#include "simulate-handler.inc"

int main() {
  OrbServer server;
  server.post(R"({"kind":"criticalSecurity","title":"Critical vulnerability","repository":"octo-org/shop","organization":true})");
  assert(server.status == 202);
  assert(server.response["id"] == "demo-12345");
  OrbState state = server.engine.snapshot(millis());
  assert(state.mona);
  assert(state.mood == Mood::SecurityAlert);
  assert(!strcmp(state.alert.title, "Critical vulnerability"));
  assert(!strcmp(state.alert.repository, "octo-org/shop"));
  assert(state.alert.ownerIsOrganization);
  assert(server.engine.acknowledgeAlert("demo-12345"));
  assert(!server.engine.snapshot(millis()).mona);

  server.post(R"({"kind":"unknown","title":"x","repository":"a/b"})");
  assert(server.status == 400);
  assert(server.response["error"] == "invalid_alert_kind");

  server.post(R"({"kind":"agentSessionFinished","title":"x","repository":"a/b"})");
  assert(server.status == 400);
  assert(server.response["error"] == "invalid_alert_kind");

  server.post(R"({"kind":"securityAlert","title":"","repository":"a/b"})");
  assert(server.status == 400);
  assert(server.response["error"] == "invalid_alert");

  server.post(R"({"kind":"securityAlert","title":"bad\nline","repository":"a/b"})");
  assert(server.status == 400);
  assert(server.response["error"] == "invalid_alert");

  server.post(R"({"kind":"securityAlert","title":"x","repository":"a/b","organization":"yes"})");
  assert(server.status == 400);

  server.post("not json");
  assert(server.status == 400);
  assert(server.response["error"] == "invalid_json");
  assert(!server.engine.snapshot(millis()).mona);
}
