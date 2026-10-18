#include "github_poller.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <SD_MMC.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <ctype.h>
#include <time.h>

#include "board.h"

namespace {
constexpr char kApiOrigin[] = "https://api.github.com";
constexpr char kNotificationsPath[] = "/notifications?all=false&participating=false&per_page=30&page=1";
constexpr char kStatePath[] = "/github-state.json";
constexpr char kStateTempPath[] = "/github-state.tmp";

int alertPriority(const char *kind) {
  if (!kind) return 0;
  if (!strcmp(kind, "securityAlert")) return 4;
  if (!strcmp(kind, "workflowFailure") || !strcmp(kind, "workflowUpdate")) return 3;
  if (!strcmp(kind, "prAssigned") || !strcmp(kind, "reviewRequested")) return 2;
  if (!strcmp(kind, "agentSessionFinished")) return 1;
  return 0;
}

bool validRepoFullName(const char *repo) {
  if (!repo || !repo[0]) return false;
  const char *slash = strchr(repo, '/');
  if (!slash || slash == repo || !slash[1] || strchr(slash + 1, '/')) return false;
  for (const char *p = repo; *p; p++) {
    if (p == slash) continue;
    const char c = *p;
    if (!isalnum(static_cast<unsigned char>(c)) && c != '_' && c != '.' && c != '-') return false;
  }
  return true;
}

bool validHtmlUrl(const char *url) {
  return url && !strncmp(url, "https://github.com/", 19) && !strchr(url, '@');
}

bool startsWith(const char *str, const char *prefix) {
  return str && prefix && !strncmp(str, prefix, strlen(prefix));
}

bool allDigits(const char *str) {
  if (!str || !str[0]) return false;
  for (const char *p = str; *p; p++) {
    if (!isdigit(static_cast<unsigned char>(*p))) return false;
  }
  return true;
}

struct HttpResponseInfo {
  int status = -1;
  int pollIntervalSec = 0;
  int retryAfterSec = 0;
  int rateLimitRemaining = -1;
  char etag[96] = "";
};

bool githubGetNotifications(const char *token,
                   const char *ifNoneMatch,
                   const JsonDocument &filter,
                   JsonDocument &outDoc,
                   HttpResponseInfo &info) {
  const String fullUrl = String(kApiOrigin) + kNotificationsPath;

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(15);

  HTTPClient http;
  http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
  http.setTimeout(15000);
  if (!http.begin(client, fullUrl)) return false;

  const char *headerKeys[] = {"X-Poll-Interval", "Retry-After", "X-RateLimit-Remaining", "ETag"};
  http.collectHeaders(headerKeys, 4);
  http.addHeader("Accept", "application/vnd.github+json");
  http.addHeader("Authorization", String("Bearer ") + token);
  http.addHeader("X-GitHub-Api-Version", "2022-11-28");
  http.addHeader("User-Agent", "github-orb-esp32");
  if (ifNoneMatch && ifNoneMatch[0]) {
    http.addHeader("If-None-Match", ifNoneMatch);
  }

  info.status = http.GET();
  if (http.hasHeader("X-Poll-Interval")) info.pollIntervalSec = http.header("X-Poll-Interval").toInt();
  if (http.hasHeader("Retry-After")) info.retryAfterSec = http.header("Retry-After").toInt();
  if (http.hasHeader("X-RateLimit-Remaining")) info.rateLimitRemaining = http.header("X-RateLimit-Remaining").toInt();
  if (http.hasHeader("ETag")) strlcpy(info.etag, http.header("ETag").c_str(), sizeof(info.etag));

  if (info.status == 304) {
    http.end();
    return true;
  }
  if (info.status < 200 || info.status >= 300) {
    http.end();
    return false;
  }

  WiFiClient *stream = http.getStreamPtr();
  const DeserializationError err = deserializeJson(
      outDoc, *stream, DeserializationOption::Filter(filter), DeserializationOption::NestingLimit(12));
  http.end();
  return !err;
}
}  // namespace

void GitHubPoller::begin(const char *token, uint16_t pollSec, AlertCallback callback, void *context) {
  if (!mutex_) mutex_ = xSemaphoreCreateMutex();
  callback_ = callback;
  context_ = context;
  configure(token, pollSec);
  if (!task_) {
    xTaskCreatePinnedToCore(taskEntry, "orb-github", 16384, this, 1, &task_, 0);
  }
}

void GitHubPoller::configure(const char *token, uint16_t pollSec) {
  if (!mutex_) mutex_ = xSemaphoreCreateMutex();
  xSemaphoreTake(mutex_, portMAX_DELAY);
  const char *safeToken = token ? token : "";
  const uint16_t clampedPoll = constrain(pollSec, 30, 3600);
  const bool tokenChanged = strcmp(token_, safeToken) != 0;
  strlcpy(token_, safeToken, sizeof(token_));
  pollSec_ = clampedPoll;
  nextDelayMs_ = static_cast<uint32_t>(pollSec_) * 1000UL;
  if (tokenChanged) {
    etag_[0] = '\0';
    reconfigureRequested_ = true;
    const bool enabled = token_[0] != '\0';
    health_.enabled = enabled;
    strlcpy(health_.status, enabled ? "starting" : "disabled", sizeof(health_.status));
    if (!enabled) health_.error[0] = '\0';
  }
  xSemaphoreGive(mutex_);
}

GitHubHealth GitHubPoller::health() const {
  GitHubHealth copy;
  if (mutex_) xSemaphoreTake(mutex_, portMAX_DELAY);
  copy = health_;
  if (mutex_) xSemaphoreGive(mutex_);
  return copy;
}

void GitHubPoller::setHealth(bool enabled, const char *status, uint32_t lastSuccessMs, const char *error) {
  if (mutex_) xSemaphoreTake(mutex_, portMAX_DELAY);
  health_.enabled = enabled;
  strlcpy(health_.status, status ? status : "error", sizeof(health_.status));
  if (lastSuccessMs) health_.lastSuccessMs = lastSuccessMs;
  strlcpy(health_.error, error ? error : "", sizeof(health_.error));
  if (mutex_) xSemaphoreGive(mutex_);
}

bool GitHubPoller::captureBootTime() {
  constexpr time_t kValidClockEpoch = 1704067200;
  const time_t currentTime = time(nullptr);
  if (currentTime < kValidClockEpoch) return false;

  const time_t bootTime = currentTime - static_cast<time_t>(millis() / 1000UL);
  struct tm utc;
  if (!gmtime_r(&bootTime, &utc) || !strftime(bootTime_, sizeof(bootTime_), "%Y-%m-%dT%H:%M:%SZ", &utc)) {
    bootTime_[0] = '\0';
    return false;
  }
  return true;
}

bool GitHubPoller::threadSeen(const char *id, const char *updatedAt) const {
  for (size_t i = 0; i < threadCount_; i++) {
    if (!strcmp(threads_[i].id, id) && !strcmp(threads_[i].updatedAt, updatedAt)) return true;
  }
  return false;
}

void GitHubPoller::recordThread(const char *id, const char *updatedAt) {
  for (size_t i = 0; i < threadCount_; i++) {
    if (!strcmp(threads_[i].id, id)) {
      strlcpy(threads_[i].updatedAt, updatedAt, sizeof(threads_[i].updatedAt));
      return;
    }
  }
  ThreadRecord &slot = threads_[threadWriteIndex_];
  strlcpy(slot.id, id, sizeof(slot.id));
  strlcpy(slot.updatedAt, updatedAt, sizeof(slot.updatedAt));
  threadWriteIndex_ = (threadWriteIndex_ + 1) % kMaxThreads;
  if (threadCount_ < kMaxThreads) threadCount_++;
}

bool GitHubPoller::alertSeen(const char *id) const {
  for (size_t i = 0; i < alertCount_; i++) {
    if (!strcmp(alerts_[i].id, id)) return true;
  }
  return false;
}

void GitHubPoller::recordAlert(const char *id) {
  if (alertSeen(id)) return;
  AlertRecord &slot = alerts_[alertWriteIndex_];
  strlcpy(slot.id, id, sizeof(slot.id));
  alertWriteIndex_ = (alertWriteIndex_ + 1) % kMaxAlerts;
  if (alertCount_ < kMaxAlerts) alertCount_++;
}

bool GitHubPoller::loadStateFromSd() {
  if (stateLoaded_) return true;
  stateLoaded_ = true;
  if (!Board::sdMounted()) return true;
  Board::SdLock lock;
  if (!SD_MMC.exists(kStatePath)) return true;
  File file = SD_MMC.open(kStatePath, FILE_READ);
  if (!file || file.size() == 0 || file.size() > 32768) {
    if (file) file.close();
    return false;
  }
  JsonDocument doc;
  const DeserializationError err = deserializeJson(doc, file);
  file.close();
  if (err || doc["version"].as<int>() != 1) return false;

  JsonObject threads = doc["threads"];
  JsonObject alerts = doc["alerts"];
  if (threads.isNull() || alerts.isNull()) return false;

  threadCount_ = 0;
  threadWriteIndex_ = 0;
  for (JsonPair kv : threads) {
    if (kv.value().is<const char *>()) recordThread(kv.key().c_str(), kv.value().as<const char *>());
  }
  alertCount_ = 0;
  alertWriteIndex_ = 0;
  for (JsonPair kv : alerts) {
    if (kv.value().as<bool>()) recordAlert(kv.key().c_str());
  }
  return true;
}

void GitHubPoller::saveStateToSd() {
  if (!Board::sdMounted()) return;
  JsonDocument doc;
  doc["version"] = 1;
  JsonObject threads = doc["threads"].to<JsonObject>();
  for (size_t i = 0; i < threadCount_; i++) {
    threads[threads_[i].id] = threads_[i].updatedAt;
  }
  JsonObject alerts = doc["alerts"].to<JsonObject>();
  for (size_t i = 0; i < alertCount_; i++) {
    alerts[alerts_[i].id] = true;
  }

  Board::SdLock lock;
  if (SD_MMC.exists(kStateTempPath)) SD_MMC.remove(kStateTempPath);
  File file = SD_MMC.open(kStateTempPath, FILE_WRITE);
  if (!file) return;
  serializeJson(doc, file);
  file.println();
  file.close();
  if (SD_MMC.exists(kStatePath)) SD_MMC.remove(kStatePath);
  SD_MMC.rename(kStateTempPath, kStatePath);
}

void GitHubPoller::taskEntry(void *arg) {
  static_cast<GitHubPoller *>(arg)->taskLoop();
}

void GitHubPoller::taskLoop() {
  while (true) {
    char tokenCopy[129] = "";
    uint16_t pollSecCopy = 60;
    xSemaphoreTake(mutex_, portMAX_DELAY);
    strlcpy(tokenCopy, token_, sizeof(tokenCopy));
    pollSecCopy = pollSec_;
    reconfigureRequested_ = false;
    xSemaphoreGive(mutex_);

    if (!tokenCopy[0]) {
      setHealth(false, "disabled", 0, "");
      vTaskDelay(pdMS_TO_TICKS(2000));
      continue;
    }
    if (WiFi.status() != WL_CONNECTED) {
      vTaskDelay(pdMS_TO_TICKS(2000));
      continue;
    }
    if (!bootTime_[0] && !captureBootTime()) {
      setHealth(true, "starting", 0, "Waiting for system time before filtering old notifications");
      vTaskDelay(pdMS_TO_TICKS(2000));
      continue;
    }

    nextDelayMs_ = static_cast<uint32_t>(pollSecCopy) * 1000UL;
    pollOnce();

    uint32_t waitedMs = 0;
    while (waitedMs < nextDelayMs_) {
      vTaskDelay(pdMS_TO_TICKS(500));
      waitedMs += 500;
      xSemaphoreTake(mutex_, portMAX_DELAY);
      const bool reconfigured = reconfigureRequested_;
      xSemaphoreGive(mutex_);
      if (reconfigured) break;
    }
  }
}

void GitHubPoller::pollOnce() {
  char token[129] = "";
  xSemaphoreTake(mutex_, portMAX_DELAY);
  strlcpy(token, token_, sizeof(token));
  xSemaphoreGive(mutex_);
  if (!token[0]) return;

  if (!loadStateFromSd()) {
    setHealth(true, "error", 0, "GitHub notification state unavailable; repair the state file before polling");
    return;
  }

  JsonDocument notifFilter;
  notifFilter[0]["id"] = true;
  notifFilter[0]["unread"] = true;
  notifFilter[0]["reason"] = true;
  notifFilter[0]["updated_at"] = true;
  notifFilter[0]["repository"]["full_name"] = true;
  notifFilter[0]["repository"]["owner"]["type"] = true;
  notifFilter[0]["subject"]["title"] = true;
  notifFilter[0]["subject"]["type"] = true;
  notifFilter[0]["subject"]["url"] = true;

  JsonDocument notifDoc;
  HttpResponseInfo notifInfo;
  if (!githubGetNotifications(token,
                     etag_,
                     notifFilter,
                     notifDoc,
                     notifInfo)) {
    char err[96];
    if (notifInfo.status > 0) {
      snprintf(err, sizeof(err), "GitHub HTTP %d; check token permissions and rate limits", notifInfo.status);
      if (notifInfo.status == 403 || notifInfo.status == 429) {
        nextDelayMs_ = max<uint32_t>(nextDelayMs_, max(60, notifInfo.retryAfterSec) * 1000UL);
      }
    } else {
      strlcpy(err, "GitHub polling failed; check connectivity and state storage", sizeof(err));
    }
    etag_[0] = '\0';
    setHealth(true, "error", 0, err);
    return;
  }

  if (notifInfo.pollIntervalSec > 0) {
    nextDelayMs_ = max<uint32_t>(nextDelayMs_, static_cast<uint32_t>(notifInfo.pollIntervalSec) * 1000UL);
  }
  if (notifInfo.rateLimitRemaining == 0) {
    nextDelayMs_ = max<uint32_t>(nextDelayMs_, 60000UL);
  }
  if (notifInfo.status == 304) {
    setHealth(true, "ok", millis(), "");
    return;
  }

  JsonArray threads = notifDoc.as<JsonArray>();
  if (threads.isNull()) {
    etag_[0] = '\0';
    setHealth(true, "error", 0, "GitHub polling failed; check connectivity and state storage");
    return;
  }

  OrbState::Alert bestAlert;
  char bestUpdatedAt[32] = "";
  bool hasBest = false;

  for (JsonObject thread : threads) {
    const bool unread = thread["unread"] | false;
    const char *threadId = thread["id"] | "";
    const char *updatedAt = thread["updated_at"] | "";
    const char *reason = thread["reason"] | "";
    const char *repo = thread["repository"]["full_name"] | "";
    const char *repoOwnerType = thread["repository"]["owner"]["type"] | "";
    const char *subjectType = thread["subject"]["type"] | "";
    const char *subjectTitle = thread["subject"]["title"] | "";
    const char *subjectUrl = thread["subject"]["url"] | "";

    if (!unread || !threadId[0] || !updatedAt[0] || threadSeen(threadId, updatedAt)) continue;
    if (strncmp(updatedAt, bootTime_, 19) <= 0) {
      // Baseline existing unread notifications at boot rather than replaying them as new alerts.
      recordThread(threadId, updatedAt);
      continue;
    }
    if (!validRepoFullName(repo)) {
      recordThread(threadId, updatedAt);
      continue;
    }

    char repoPrefix[96];
    snprintf(repoPrefix, sizeof(repoPrefix), "https://api.github.com/repos/%s", repo);
    char htmlUrl[192];
    char alertId[96];
    char title[81];
    const char *kind = "githubNotification";
    const char *displayTitle = subjectTitle[0] ? subjectTitle : "GitHub notification";
    snprintf(alertId, sizeof(alertId), "%s:%s", threadId, updatedAt);
    snprintf(htmlUrl, sizeof(htmlUrl), "https://github.com/%s", repo);

    auto considerAlert = [&](const char *kind, const char *id, const char *title, const char *htmlUrl) -> bool {
      if (!validHtmlUrl(htmlUrl)) return false;
      if (!alertSeen(id)) {
        recordAlert(id);
        const int prio = alertPriority(kind);
        const int bestPrio = hasBest ? alertPriority(bestAlert.kind) : 0;
        if (!hasBest || prio > bestPrio || (prio == bestPrio && strcmp(updatedAt, bestUpdatedAt) > 0)) {
          hasBest = true;
          strlcpy(bestUpdatedAt, updatedAt, sizeof(bestUpdatedAt));
          strlcpy(bestAlert.id, id, sizeof(bestAlert.id));
          strlcpy(bestAlert.kind, kind, sizeof(bestAlert.kind));
          strlcpy(bestAlert.title, title, sizeof(bestAlert.title));
          strlcpy(bestAlert.url, htmlUrl, sizeof(bestAlert.url));
          strlcpy(bestAlert.repository, repo, sizeof(bestAlert.repository));
          bestAlert.ownerIsOrganization = !strcmp(repoOwnerType, "Organization");
        }
      }
      return true;
    };

    if (!strcmp(reason, "agent_session_finished")) {
      kind = "agentSessionFinished";
      displayTitle = "Copilot done";
    } else if (!strcmp(reason, "approval_requested") && strcmp(subjectType, "PullRequest")) {
      kind = "reviewRequested";
      displayTitle = subjectTitle[0] ? subjectTitle : "Approval requested";
      snprintf(alertId, sizeof(alertId), "%s:%s:%s", threadId, updatedAt, kind);
    } else if (!strcmp(subjectType, "PullRequest") &&
               (!strcmp(reason, "assign") || !strcmp(reason, "review_requested") ||
                !strcmp(reason, "approval_requested"))) {
      char expectedPrefix[116];
      snprintf(expectedPrefix, sizeof(expectedPrefix), "%s/pulls/", repoPrefix);
      const char *number = startsWith(subjectUrl, expectedPrefix) ? subjectUrl + strlen(expectedPrefix) : "";
      if (allDigits(number)) {
        kind = !strcmp(reason, "assign") ? "prAssigned" : "reviewRequested";
        snprintf(alertId, sizeof(alertId), "%s:%s:%s", threadId, updatedAt, kind);
        snprintf(htmlUrl, sizeof(htmlUrl), "https://github.com/%s/pull/%s", repo, number);
      }
    } else if (!strcmp(reason, "security_alert")) {
      kind = "securityAlert";
      displayTitle = subjectTitle[0] ? subjectTitle : "Security alert";
      snprintf(alertId, sizeof(alertId), "%s:%s:%s", threadId, updatedAt, kind);
      char expectedPrefix[160];
      snprintf(expectedPrefix, sizeof(expectedPrefix), "%s/dependabot/alerts/", repoPrefix);
      const char *number = startsWith(subjectUrl, expectedPrefix) ? subjectUrl + strlen(expectedPrefix) : "";
      if (allDigits(number)) {
        snprintf(htmlUrl, sizeof(htmlUrl), "https://github.com/%s/security/dependabot/%s", repo, number);
      } else {
        snprintf(htmlUrl, sizeof(htmlUrl), "https://github.com/%s/security/dependabot", repo);
      }
    } else if (!strcmp(reason, "ci_activity")) {
      kind = "workflowFailure";
      displayTitle = subjectTitle[0] ? subjectTitle : "Workflow failed";
      snprintf(alertId, sizeof(alertId), "%s:%s:%s", threadId, updatedAt, kind);
      snprintf(htmlUrl, sizeof(htmlUrl), "https://github.com/%s/actions", repo);
    }

    strlcpy(title, displayTitle, sizeof(title));
    considerAlert(kind, alertId, title, htmlUrl);
    recordThread(threadId, updatedAt);
  }

  saveStateToSd();
  strlcpy(etag_, notifInfo.etag, sizeof(etag_));

  if (hasBest && callback_) {
    callback_(bestAlert, context_);
  }

  setHealth(true, "ok", millis(), "");
}
