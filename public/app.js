const form = document.querySelector("#launch-form");
const meetInput = document.querySelector("#meet-url");
const webhookInput = document.querySelector("#slack-webhook");
const statusBox = document.querySelector("#status-box");
const testSlackButton = document.querySelector("#test-slack");
const joinSlackLink = document.querySelector("#join-slack");
const liveLogList = document.querySelector("#live-log-list");
const clearLogButton = document.querySelector("#clear-log");
const demoVideoDialog = document.querySelector("#demo-video-dialog");
const openDemoVideoButton = document.querySelector("#open-demo-video");
const closeDemoVideoButton = document.querySelector("#close-demo-video");
const demoVideo = document.querySelector("#demo-video");

let pollTimer;
let logStream;

function setStatus(message, tone = "info") {
  statusBox.textContent = message;
  statusBox.classList.toggle("error", tone === "error");
}

function setBusy(isBusy) {
  form.querySelectorAll("button").forEach((button) => {
    button.disabled = isBusy;
  });
}

function clearLiveLogs(message = "Waiting for live call events...") {
  liveLogList.innerHTML = "";
  const emptyItem = document.createElement("li");
  emptyItem.className = "empty-log";
  emptyItem.textContent = message;
  liveLogList.append(emptyItem);
}

function appendLiveLog(entry) {
  const emptyLog = liveLogList.querySelector(".empty-log");
  if (emptyLog) emptyLog.remove();

  const item = document.createElement("li");
  item.className = `live-log-item ${entry.level || "info"}`;

  const time = document.createElement("time");
  time.dateTime = entry.timestamp;
  time.textContent = new Date(entry.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const level = document.createElement("span");
  level.className = "live-log-level";
  level.textContent = entry.level || "info";

  const message = document.createElement("span");
  message.className = "live-log-message";
  message.textContent = entry.message;

  item.append(time, level, message);

  if (entry.data) {
    const data = document.createElement("small");
    data.textContent = formatLogData(entry.data);
    if (data.textContent) item.append(data);
  }

  liveLogList.append(item);
  while (liveLogList.children.length > 80) {
    liveLogList.firstElementChild?.remove();
  }
  liveLogList.scrollTop = liveLogList.scrollHeight;
}

function formatLogData(data) {
  const pieces = [];
  if (data.mode) pieces.push(`mode: ${data.mode}`);
  if (data.turnNumber) pieces.push(`turn: ${data.turnNumber}`);
  if (data.segments !== undefined) pieces.push(`segments: ${data.segments}`);
  if (data.transcriptSegments !== undefined) pieces.push(`segments: ${data.transcriptSegments}`);
  if (data.bytes !== undefined) pieces.push(`${Math.round(data.bytes / 1024)} KB`);
  if (data.durationMs !== undefined) pieces.push(`${Math.round(data.durationMs / 1000)}s`);
  if (data.preview) pieces.push(`"${data.preview}"`);
  if (data.question) pieces.push(`"${data.question}"`);
  if (data.error) pieces.push(String(data.error));
  return pieces.join(" · ");
}

function connectLiveLogs(sessionId) {
  if (logStream) {
    logStream.close();
  }
  clearLiveLogs("Connecting to live call log...");

  logStream = new EventSource(`/api/logs/${sessionId}/stream`);
  logStream.onmessage = (event) => {
    try {
      appendLiveLog(JSON.parse(event.data));
    } catch {
      // Ignore malformed SSE events.
    }
  };
  logStream.onerror = () => {
    appendLiveLog({
      timestamp: new Date().toISOString(),
      level: "warn",
      message: "Live log stream disconnected; status polling is still active.",
    });
    logStream.close();
    logStream = undefined;
  };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }
  return payload;
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config");
    const config = await response.json().catch(() => ({}));
    if (response.ok && config.slackInviteUrl && joinSlackLink) {
      joinSlackLink.href = config.slackInviteUrl;
      joinSlackLink.classList.remove("hidden");
    }
  } catch {
    setStatus("Backend not reachable", "error");
  }
}

function buildPayload() {
  return {
    meetUrl: meetInput.value.trim(),
    slackWebhookUrl: webhookInput.value.trim() || undefined,
  };
}

async function pollStatus(sessionId) {
  const response = await fetch(`/api/status/${sessionId}`);
  const session = await response.json();
  if (!response.ok) {
    throw new Error(session.error || "Could not read session status.");
  }

  const bits = [
    `Session ${session.sessionId}`,
    `Status: ${session.status}`,
    `${session.transcriptSegments} transcript segment${session.transcriptSegments === 1 ? "" : "s"}`,
  ];
  if (session.error) bits.push(session.error);
  setStatus(bits.join("\n"), session.status === "error" ? "error" : "info");

  if (session.status === "completed" || session.status === "error") {
    window.clearInterval(pollTimer);
    setBusy(false);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  window.clearInterval(pollTimer);
  setBusy(true);
  setStatus("Adding bot to Meet...");

  try {
    const payload = await postJson("/api/start-bot", buildPayload());
    setStatus(`Bot is joining. Session ${payload.sessionId}`);
    connectLiveLogs(payload.sessionId);
    pollTimer = window.setInterval(() => {
      pollStatus(payload.sessionId).catch((error) => {
        window.clearInterval(pollTimer);
        setBusy(false);
        setStatus(error.message, "error");
      });
    }, 4000);
  } catch (error) {
    setBusy(false);
    setStatus(error.message, "error");
  }
});

testSlackButton.addEventListener("click", async () => {
  testSlackButton.disabled = true;
  setStatus("Sending Slack test message...");
  try {
    await postJson("/api/slack/test", {
      slackWebhookUrl: webhookInput.value.trim() || undefined,
    });
    setStatus("Slack test posted. Check the selected channel.");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    testSlackButton.disabled = false;
  }
});

clearLogButton.addEventListener("click", () => {
  clearLiveLogs("Live call log cleared.");
});

openDemoVideoButton?.addEventListener("click", () => {
  if (demoVideoDialog?.showModal) {
    demoVideoDialog.showModal();
  } else {
    demoVideoDialog?.setAttribute("open", "");
  }
  demoVideo?.play().catch(() => {
    setStatus("Demo video is ready. Tap the video if your browser blocks autoplay.");
  });
});

function closeDemoVideo() {
  demoVideo?.pause();
  if (demoVideo) demoVideo.currentTime = 0;
  if (demoVideoDialog?.open) demoVideoDialog.close();
}

closeDemoVideoButton?.addEventListener("click", closeDemoVideo);

demoVideoDialog?.addEventListener("click", (event) => {
  if (event.target === demoVideoDialog) closeDemoVideo();
});

demoVideoDialog?.addEventListener("close", () => {
  demoVideo?.pause();
  if (demoVideo) demoVideo.currentTime = 0;
});

demoVideo?.addEventListener("loadedmetadata", () => {
  demoVideo.closest(".video-dialog-shell")?.classList.add("has-video");
});

loadConfig();
