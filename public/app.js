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
const codexTaskItems = document.querySelector("#codex-task-items");
const refreshCodexButton = document.querySelector("#refresh-codex");
const codexStatusStrip = document.querySelector("#codex-status-strip");
const codexFileList = document.querySelector("#codex-file-list");
const codexActiveFile = document.querySelector("#codex-active-file");
const codexFileMeta = document.querySelector("#codex-file-meta");
const codexCodeView = document.querySelector("#codex-code-view");
const codexLogView = document.querySelector("#codex-log-view");
const codexLogMeta = document.querySelector("#codex-log-meta");
const codexDiffView = document.querySelector("#codex-diff-view");

let pollTimer;
let logStream;
let codexPollTimer;
const codexParams = new URLSearchParams(window.location.search);
const codexSessionFilter = codexParams.get("session");
let selectedCodexTaskId = codexParams.get("task") || undefined;
let selectedCodexFilePath;

function setStatus(message, tone = "info") {
  if (!statusBox) return;
  statusBox.textContent = message;
  statusBox.classList.toggle("error", tone === "error");
}

function setBusy(isBusy) {
  if (!form) return;
  form.querySelectorAll("button").forEach((button) => {
    button.disabled = isBusy;
  });
}

function clearLiveLogs(message = "Waiting for live call events...") {
  if (!liveLogList) return;
  liveLogList.innerHTML = "";
  const emptyItem = document.createElement("li");
  emptyItem.className = "empty-log";
  emptyItem.textContent = message;
  liveLogList.append(emptyItem);
}

function appendLiveLog(entry) {
  if (!liveLogList) return;
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
    meetUrl: meetInput?.value.trim(),
    slackWebhookUrl: webhookInput?.value.trim() || undefined,
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

form?.addEventListener("submit", async (event) => {
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

testSlackButton?.addEventListener("click", async () => {
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

clearLogButton?.addEventListener("click", () => {
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

async function loadCodexTasks() {
  if (!codexTaskItems) return;
  try {
    const response = await fetch("/api/coding/tasks");
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load Codex tasks.");
    const tasks = codexSessionFilter
      ? (payload.tasks || []).filter((task) => task.sessionId === codexSessionFilter)
      : (payload.tasks || []);
    renderCodexTasks(tasks);
    const activeTask = pickActiveCodexTask(tasks);
    if (!selectedCodexTaskId && activeTask) {
      selectedCodexTaskId = activeTask.id;
    }
    if (selectedCodexTaskId) {
      await loadCodexSnapshot(selectedCodexTaskId);
    }
  } catch (error) {
    codexStatusStrip.textContent = error.message || "Could not load Codex tasks.";
  }
}

function renderCodexTasks(tasks) {
  codexTaskItems.innerHTML = "";
  if (tasks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "codex-empty";
    empty.textContent = "No coding tasks yet.";
    codexTaskItems.append(empty);
    return;
  }

  for (const task of tasks) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `codex-task-button ${task.id === selectedCodexTaskId ? "active" : ""}`;
    const title = document.createElement("strong");
    title.textContent = `${task.linearIdentifier || "Task"} · ${task.linearTitle}`;
    const status = document.createElement("span");
    status.className = `codex-status-pill ${task.status}`;
    status.textContent = task.status.replaceAll("_", " ");
    const meta = document.createElement("span");
    meta.textContent = task.githubPrUrl
      ? `PR #${task.githubPrNumber}`
      : task.githubIssueUrl
        ? `Issue #${task.githubIssueNumber}`
        : "Waiting for GitHub";
    button.append(status, title, meta);
    button.addEventListener("click", () => {
      selectedCodexTaskId = task.id;
      selectedCodexFilePath = undefined;
      loadCodexTasks().catch(() => undefined);
    });
    codexTaskItems.append(button);
  }
}

function pickActiveCodexTask(tasks) {
  return tasks.find((task) => task.status === "codex_running")
    || tasks.find((task) => task.status === "github_issue_created")
    || tasks[0];
}

async function loadCodexSnapshot(taskId) {
  const response = await fetch(`/api/coding/tasks/${taskId}`);
  const snapshot = await response.json();
  if (!response.ok) throw new Error(snapshot.error || "Could not load Codex snapshot.");
  renderCodexSnapshot(snapshot);
}

function renderCodexSnapshot(snapshot) {
  const task = snapshot.task;
  codexStatusStrip.textContent = [
    `${task.linearIdentifier || "Task"}: ${task.linearTitle}`,
    `Status ${task.status.replaceAll("_", " ")}`,
    task.githubIssueUrl ? `GitHub #${task.githubIssueNumber}` : undefined,
    task.githubPrUrl ? `PR #${task.githubPrNumber}` : undefined,
  ].filter(Boolean).join(" · ");

  codexLogView.innerHTML = highlightLog(snapshot.codexLog || "No Codex logs captured yet. Restarted runs here.");
  codexLogView.scrollTop = codexLogView.scrollHeight;
  codexLogMeta.textContent = snapshot.running ? "Running" : "Latest output";
  codexDiffView.innerHTML = highlightDiff(snapshot.gitDiff || snapshot.gitStatus || "No working tree diff yet.");

  renderCodexFiles(snapshot.files || [], snapshot.activeFile);
  const fileToLoad = selectedCodexFilePath || snapshot.activeFile || snapshot.files?.[0]?.path;
  if (fileToLoad && fileToLoad !== selectedCodexFilePath) {
    selectedCodexFilePath = fileToLoad;
    loadCodexFile(task.id, fileToLoad).catch(() => undefined);
  } else if (!fileToLoad) {
    codexCodeView.textContent = "No files available for this task yet.";
    codexActiveFile.textContent = "No file selected";
  }
}

function renderCodexFiles(files, activePath) {
  codexFileList.innerHTML = "";
  if (files.length === 0) {
    const empty = document.createElement("p");
    empty.className = "codex-empty";
    empty.textContent = "No cloned files yet.";
    codexFileList.append(empty);
    return;
  }

  for (const file of files.slice(0, 120)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = [
      "codex-file-button",
      file.path === (selectedCodexFilePath || activePath) ? "active" : "",
      file.changed ? "changed" : "",
    ].filter(Boolean).join(" ");
    const name = document.createElement("strong");
    name.textContent = file.path;
    const meta = document.createElement("span");
    meta.textContent = `${Math.max(1, Math.round(file.size / 1024))} KB${file.changed ? " · changed" : ""}`;
    button.append(name, meta);
    button.addEventListener("click", () => {
      selectedCodexFilePath = file.path;
      if (selectedCodexTaskId) loadCodexFile(selectedCodexTaskId, file.path).catch(() => undefined);
    });
    codexFileList.append(button);
  }
}

async function loadCodexFile(taskId, filePath) {
  const response = await fetch(`/api/coding/tasks/${taskId}/file?path=${encodeURIComponent(filePath)}`);
  const payload = await response.json();
  if (!response.ok) {
    codexCodeView.textContent = payload.error || "Could not load file.";
    codexFileMeta.textContent = filePath;
    return;
  }
  codexCodeView.innerHTML = highlightCode(payload.content || "", payload.path || filePath);
  codexActiveFile.textContent = payload.path;
  codexFileMeta.textContent = `${payload.path} · ${Math.max(1, Math.round(payload.size / 1024))} KB`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function highlightCode(value, filePath = "") {
  const escaped = escapeHtml(value);
  const extension = filePath.split(".").pop()?.toLowerCase();
  if (["md", "markdown", "txt", "log"].includes(extension)) {
    return escaped
      .split("\n")
      .map((line) => {
        if (/^\s*#/.test(line)) return `<span class="codex-token-keyword">${line}</span>`;
        if (/^\s*[-*]\s/.test(line)) return `<span class="codex-token-function">${line}</span>`;
        return line;
      })
      .join("\n");
  }

  return escaped.replace(
    /(\/\*[\s\S]*?\*\/|\/\/.*|#.*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:async|await|break|case|catch|class|const|continue|default|else|export|extends|false|finally|for|from|function|if|import|in|interface|let|new|null|return|switch|throw|true|try|type|undefined|while)\b|\b\d+(?:\.\d+)?\b|\b([A-Za-z_$][\w$]*)\s*(?=\())/g,
    (match, _all, fnName) => {
      if (match.startsWith("//") || match.startsWith("/*") || match.startsWith("#")) {
        return `<span class="codex-token-comment">${match}</span>`;
      }
      if (match.startsWith("\"") || match.startsWith("'") || match.startsWith("`")) {
        return `<span class="codex-token-string">${match}</span>`;
      }
      if (/^\d/.test(match)) return `<span class="codex-token-number">${match}</span>`;
      if (fnName) return `<span class="codex-token-function">${match}</span>`;
      return `<span class="codex-token-keyword">${match}</span>`;
    },
  );
}

function highlightDiff(value) {
  return escapeHtml(value)
    .split("\n")
    .map((line) => {
      if (line.startsWith("@@")) return `<span class="codex-diff-hunk">${line}</span>`;
      if (line.startsWith("+") && !line.startsWith("+++")) return `<span class="codex-diff-add">${line}</span>`;
      if (line.startsWith("-") && !line.startsWith("---")) return `<span class="codex-diff-remove">${line}</span>`;
      return line;
    })
    .join("\n");
}

function highlightLog(value) {
  return escapeHtml(value)
    .split("\n")
    .map((line) => {
      if (/error|failed|exited 1|exited 127/i.test(line)) return `<span class="codex-log-error">${line}</span>`;
      if (/warn|warning|deprecated/i.test(line)) return `<span class="codex-log-warn">${line}</span>`;
      if (/exec|git |npm |codex|succeeded/i.test(line)) return `<span class="codex-log-command">${line}</span>`;
      return line;
    })
    .join("\n");
}

refreshCodexButton?.addEventListener("click", () => {
  loadCodexTasks().catch(() => undefined);
});

function startCodexPolling() {
  if (!codexTaskItems) return;
  loadCodexTasks().catch(() => undefined);
  codexPollTimer = window.setInterval(() => {
    loadCodexTasks().catch(() => undefined);
  }, 3000);
}

loadConfig();
startCodexPolling();
