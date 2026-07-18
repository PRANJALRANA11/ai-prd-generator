import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import path from "path";
import fs from "fs";
import { logger } from "../utils/logger.js";
import { transcribeAudioFile } from "./deepgramService.js";
import { appendSessionLog } from "./liveLogService.js";

export interface TranscriptSegment {
  timestamp: string;
  speaker: string;
  text: string;
}

export interface BotSession {
  id: string;
  meetUrl: string;
  status: "joining" | "in-meeting" | "processing" | "completed" | "error";
  transcript: TranscriptSegment[];
  prd?: string;
  roadmap?: string;
  slackWebhookUrl?: string;
  githubRepo?: string;
  startedAt: Date;
  endedAt?: Date;
  error?: string;
  audioFilePath?: string;
  /** Internal — used to signal the bot to stop */
  _stopRequested: boolean;
  _browser?: Browser;
  _page?: Page;
  _context?: BrowserContext;
}

const AUDIO_RECORDER_INIT_SCRIPT = `
(function() {
  if (window.__meetAudioCaptureInstalled) return;
  window.__meetAudioCaptureInstalled = true;

  var remoteAudioTracks = [];
  var recorder = null;
  var recorderMimeType = "";
  var trackWaiters = [];
  var recordingStream = new MediaStream();

  function pickMimeType() {
    var candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
    ];

    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return "";
  }

  function toBase64(bytes) {
    var chunkSize = 0x8000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += chunkSize) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
    }
    return btoa(parts.join(""));
  }

  async function sendBlob(blob) {
    if (!blob || blob.size === 0 || !window.__sendMeetAudioChunk) return;
    var buffer = await blob.arrayBuffer();
    await window.__sendMeetAudioChunk({
      base64: toBase64(new Uint8Array(buffer)),
      mimeType: blob.type || recorderMimeType || "audio/webm",
    });
  }

  function resolveTrackWaiters() {
    while (trackWaiters.length > 0) {
      trackWaiters.shift()(true);
    }
  }

  function addRemoteAudioTrack(track) {
    if (!track || track.kind !== "audio") return;
    if (remoteAudioTracks.indexOf(track) !== -1) return;

    remoteAudioTracks.push(track);
    recordingStream.addTrack(track);
    resolveTrackWaiters();
  }

  function handleTrackEvent(event) {
    addRemoteAudioTrack(event.track);
    if (event.streams) {
      for (var i = 0; i < event.streams.length; i++) {
        var tracks = event.streams[i].getAudioTracks();
        for (var j = 0; j < tracks.length; j++) addRemoteAudioTrack(tracks[j]);
      }
    }
  }

  function patchPeerConnection(name) {
    var OriginalPeerConnection = window[name];
    if (!OriginalPeerConnection || OriginalPeerConnection.__meetAudioPatched) return;

    function PatchedPeerConnection() {
      var pc = new (Function.prototype.bind.apply(
        OriginalPeerConnection,
        [null].concat(Array.prototype.slice.call(arguments))
      ))();
      pc.addEventListener("track", handleTrackEvent);
      return pc;
    }

    PatchedPeerConnection.prototype = OriginalPeerConnection.prototype;
    Object.setPrototypeOf(PatchedPeerConnection, OriginalPeerConnection);
    PatchedPeerConnection.__meetAudioPatched = true;
    window[name] = PatchedPeerConnection;
  }

  patchPeerConnection("RTCPeerConnection");
  patchPeerConnection("webkitRTCPeerConnection");

  window.__waitForMeetAudioTrack = function(timeoutMs) {
    if (remoteAudioTracks.length > 0) return Promise.resolve(true);
    return new Promise(function(resolve) {
      var timer = setTimeout(function() {
        var index = trackWaiters.indexOf(resolve);
        if (index >= 0) trackWaiters.splice(index, 1);
        resolve(false);
      }, timeoutMs);

      trackWaiters.push(function(result) {
        clearTimeout(timer);
        resolve(result);
      });
    });
  };

  window.__startMeetAudioRecording = function() {
    if (recorder && recorder.state !== "inactive") {
      return {
        started: true,
        audioTracks: recordingStream.getAudioTracks().length,
        mimeType: recorderMimeType || recorder.mimeType,
      };
    }

    if (recordingStream.getAudioTracks().length === 0) {
      return {
        started: false,
        audioTracks: 0,
        error: "No remote Meet audio tracks were detected.",
      };
    }

    recorderMimeType = pickMimeType();
    recorder = recorderMimeType
      ? new MediaRecorder(recordingStream, { mimeType: recorderMimeType })
      : new MediaRecorder(recordingStream);
    recorder.ondataavailable = function(event) {
      sendBlob(event.data).catch(function(error) {
        console.error("Failed to send Meet audio chunk", error);
      });
    };
    recorder.start(2000);

    return {
      started: true,
      audioTracks: recordingStream.getAudioTracks().length,
      mimeType: recorderMimeType || recorder.mimeType || "audio/webm",
    };
  };

  window.__stopMeetAudioRecording = function() {
    return new Promise(function(resolve) {
      if (!recorder || recorder.state === "inactive") {
        resolve({
          stopped: true,
          audioTracks: recordingStream.getAudioTracks().length,
          mimeType: recorderMimeType || "audio/webm",
        });
        return;
      }

      var didResolve = false;
      function finish() {
        if (didResolve) return;
        didResolve = true;
        resolve({
          stopped: true,
          audioTracks: recordingStream.getAudioTracks().length,
          mimeType: recorderMimeType || recorder.mimeType || "audio/webm",
        });
      }

      recorder.onstop = finish;
      recorder.requestData();
      recorder.stop();
      setTimeout(finish, 5000);
    });
  };

})();
`;

interface AudioChunkPayload {
  base64: string;
  mimeType?: string;
}

interface AudioCaptureController {
  filePath: string;
  getBytesWritten: () => number;
  getContentType: () => string;
  close: () => Promise<void>;
}

interface AudioRecorderStartResult {
  started: boolean;
  audioTracks: number;
  mimeType?: string;
  error?: string;
}

interface AudioRecorderStopResult {
  stopped: boolean;
  audioTracks: number;
  mimeType?: string;
}

/**
 * Launches a Playwright browser, joins the Google Meet call, records remote
 * meeting audio, and transcribes it with Deepgram after the meeting ends.
 */
export async function startMeetBot(
  session: BotSession,
  authStatePath: string,
  botDisplayName: string,
  deepgramApiKey: string,
  playwrightHeadless = false,
): Promise<TranscriptSegment[]> {
  const ctx = "MeetBot";
  const resolvedAuthPath = path.resolve(authStatePath);

  // ── Validate auth state ────────────────────────────────
  if (!fs.existsSync(resolvedAuthPath)) {
    throw new Error(
      `Auth state file not found at ${resolvedAuthPath}. Run "npm run auth-setup" first.`,
    );
  }

  // ── Launch browser ─────────────────────────────────────
  logger.info(ctx, "Launching browser", { meetUrl: session.meetUrl });
  appendSessionLog(session.id, "info", "Launching Meet browser");

  const browserArgs = [
    "--disable-blink-features=AutomationControlled",
    "--use-fake-ui-for-media-stream",
    "--disable-notifications",
    "--no-sandbox",
  ];

  const browser = await chromium.launch({
    headless: playwrightHeadless,
    args: browserArgs,
  });
  session._browser = browser;

  const context = await browser.newContext({
    storageState: resolvedAuthPath,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    permissions: ["microphone"],
    viewport: { width: 1280, height: 720 },
  });
  session._context = context;

  const page = await context.newPage();
  session._page = page;
  const audioCapture = await setupAudioCapture(page, session);

  try {
    // ── Navigate to the Meet URL ───────────────────────────
    session.status = "joining";
    logger.info(ctx, "Navigating to Meet URL", { url: session.meetUrl });
    appendSessionLog(session.id, "info", "Opening Google Meet", { meetUrl: session.meetUrl });
    await page.goto(session.meetUrl, { waitUntil: "networkidle", timeout: 30_000 });

    // Give the page a moment to fully render the pre-join screen
    await page.waitForTimeout(5000);

    // ── Handle pre-join screen ─────────────────────────────
    await setMicrophoneEnabled(page, false);

    // Keep the bot as a named participant only; do not publish video.
    try {
      const cameraButton = page.locator('[aria-label*="camera" i], [aria-label*="video" i]').first();
      if (await cameraButton.isVisible({ timeout: 3000 })) {
        const cameraLabel = await cameraButton.getAttribute("aria-label") ?? "";
        if (/turn off|stop|disable/i.test(cameraLabel)) {
          await cameraButton.click();
          logger.info(ctx, "Turned off camera");
        } else {
          logger.info(ctx, "Camera is already off");
        }
      }
    } catch {
      logger.debug(ctx, "Camera toggle not found or already off");
    }

    await dismissCameraPrompt(page, session.id);

    // ── Enter display name if prompted ─────────────────────
    try {
      const nameInput = page.locator('input[aria-label*="name" i], input[placeholder*="name" i]').first();
      if (await nameInput.isVisible({ timeout: 3000 })) {
        await nameInput.fill(botDisplayName);
        logger.info(ctx, "Entered display name", { name: botDisplayName });
      }
    } catch {
      logger.debug(ctx, "Name input not found (probably already logged in)");
    }

    // ── Click "Join now" / "Ask to join" ───────────────────
    logger.info(ctx, "Attempting to join the meeting...");

    let joined = false;

    // Strategy 1: Text-based button matching
    const joinTexts = [
      "Join now",
      "Ask to join",
      "Join",
      "Join meeting",
      "Participate",
      "Enter meeting",
    ];

    for (const text of joinTexts) {
      try {
        const btn = page.locator(`button:has-text("${text}")`).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          logger.info(ctx, `Clicked join button with text: "${text}"`);
          joined = true;
          break;
        }
      } catch {
        continue;
      }
    }

    // Strategy 2: aria-label based matching
    if (!joined) {
      try {
        const btn = page.locator('button[aria-label*="join" i]').first();
        if (await btn.isVisible({ timeout: 3000 })) {
          await btn.click();
          logger.info(ctx, "Clicked join button via aria-label");
          joined = true;
        }
      } catch {
        // continue
      }
    }

    if (!joined) {
      throw new Error("Could not find the Join button on the page.");
    }

    // Wait for the meeting to load
    await page.waitForTimeout(5000);

    // ── Verify we're in the meeting ────────────────────────
    session.status = "in-meeting";
    logger.info(ctx, "Successfully joined the meeting");
    appendSessionLog(session.id, "info", "Successfully joined the meeting");

    // ── Start audio recording for Deepgram ─────────────────
    logger.info(ctx, "Starting meeting audio capture...");
    appendSessionLog(session.id, "info", "Starting meeting audio capture");
    const recordingStartedAt = new Date();
    await startAudioRecording(page);

    await waitForMeetingToEnd(page, session);

    const recording = await stopAudioRecording(page, audioCapture);
    logger.info(ctx, "Meeting ended. Audio captured.", {
      audioFilePath: recording.filePath,
      bytes: recording.bytes,
      contentType: recording.contentType,
    });
    appendSessionLog(session.id, "info", "Meeting ended and audio was captured", {
      bytes: recording.bytes,
      contentType: recording.contentType,
    });

    const transcript = await transcribeAudioFile(
      deepgramApiKey,
      recording.filePath,
      recording.contentType,
      recordingStartedAt,
    );

    session.transcript = transcript;
    session.endedAt = new Date();
    logger.info(ctx, "Transcript captured.", {
      segments: session.transcript.length,
    });
    appendSessionLog(session.id, "info", "Transcript captured", {
      segments: session.transcript.length,
    });

    return session.transcript;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(ctx, "Bot error", { error: message });
    appendSessionLog(session.id, "error", "Meet bot failed", { error: message });
    session.status = "error";
    session.error = message;
    throw err;
  } finally {
    await audioCapture.close().catch(() => {
      // Ignore close errors
    });
    try {
      await browser.close();
    } catch {
      // Ignore close errors
    }
  }
}

async function dismissCameraPrompt(page: Page, sessionId: string): Promise<void> {
  const ctx = "MeetBot";
  const promptButton = page.locator(
    [
      'button:has-text("Continue without camera")',
      'button:has-text("Continue without video")',
      'button:has-text("Join without camera")',
      'div[role="button"]:has-text("Continue without camera")',
      'div[role="button"]:has-text("Continue without video")',
      'div[role="button"]:has-text("Join without camera")',
    ].join(", "),
  ).first();

  try {
    if (await promptButton.isVisible({ timeout: 2500 })) {
      await promptButton.click();
      logger.info(ctx, "Dismissed Meet camera prompt");
      appendSessionLog(sessionId, "info", "Continued without camera");
      await page.waitForTimeout(500);
    }
  } catch {
    logger.debug(ctx, "Meet camera prompt not shown");
  }
}

async function setMicrophoneEnabled(page: Page, enabled: boolean): Promise<void> {
  const ctx = "MeetBot";
  try {
    const micButton = page.locator('[aria-label*="microphone" i], [aria-label*="mic" i], [data-is-muted]').first();
    if (!(await micButton.isVisible({ timeout: 3000 }))) return;

    const micLabel = await micButton.getAttribute("aria-label") ?? "";
    const isOn = /turn off|mute|disable/i.test(micLabel);
    const isOff = /turn on|unmute|enable/i.test(micLabel);

    if (enabled && isOff) {
      await micButton.click();
      logger.info(ctx, "Enabled microphone");
    } else if (!enabled && isOn) {
      await micButton.click();
      logger.info(ctx, "Muted microphone");
    } else {
      logger.info(ctx, enabled ? "Microphone is already enabled" : "Microphone is already muted");
    }
  } catch {
    logger.debug(ctx, "Microphone toggle not found or state could not be changed");
  }
}

async function setupAudioCapture(page: Page, session: BotSession): Promise<AudioCaptureController> {
  const ctx = "MeetBot:Audio";
  const filePath = path.resolve("recordings", `${session.id}.webm`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  session.audioFilePath = filePath;

  let bytesWritten = 0;
  let contentType = "audio/webm";
  let closed = false;
  const writer = fs.createWriteStream(filePath);

  await page.exposeFunction("__sendMeetAudioChunk", (payload: AudioChunkPayload) => {
    if (closed) return;

    const chunk = Buffer.from(payload.base64, "base64");
    bytesWritten += chunk.length;
    contentType = payload.mimeType ?? contentType;
    writer.write(chunk);
  });

  await page.addInitScript({ content: AUDIO_RECORDER_INIT_SCRIPT });
  logger.info(ctx, "Audio capture installed", { filePath });

  return {
    filePath,
    getBytesWritten: () => bytesWritten,
    getContentType: () => contentType.split(";")[0],
    close: () =>
      new Promise((resolve, reject) => {
        if (closed) {
          resolve();
          return;
        }
        closed = true;
        writer.once("error", reject);
        writer.end(resolve);
      }),
  };
}

async function startAudioRecording(page: Page): Promise<void> {
  const ctx = "MeetBot:Audio";
  const hasAudioTrack = await page.evaluate(
    "window.__waitForMeetAudioTrack ? window.__waitForMeetAudioTrack(30000) : false",
  ) as boolean;

  if (!hasAudioTrack) {
    logger.warn(ctx, "No remote audio track detected before timeout; attempting to start recorder anyway");
  }

  const result = await page.evaluate(
    "window.__startMeetAudioRecording ? window.__startMeetAudioRecording() : { started: false, audioTracks: 0, error: 'Audio recorder was not installed' }",
  ) as AudioRecorderStartResult;

  if (!result.started) {
    throw new Error(result.error ?? "Could not start meeting audio recording.");
  }

  logger.info(ctx, "Audio recording started", {
    audioTracks: result.audioTracks,
    mimeType: result.mimeType,
  });
}

async function stopAudioRecording(
  page: Page,
  audioCapture: AudioCaptureController,
): Promise<{ filePath: string; bytes: number; contentType: string }> {
  const result = await page.evaluate(
    "window.__stopMeetAudioRecording ? window.__stopMeetAudioRecording() : { stopped: true, audioTracks: 0, mimeType: 'audio/webm' }",
  ) as AudioRecorderStopResult;

  await audioCapture.close();
  const bytes = audioCapture.getBytesWritten();
  if (bytes === 0) {
    throw new Error("Meeting audio recording was empty.");
  }

  logger.info("MeetBot:Audio", "Audio recording stopped", {
    audioTracks: result.audioTracks,
    mimeType: result.mimeType,
    bytes,
  });

  return {
    filePath: audioCapture.filePath,
    bytes,
    contentType: audioCapture.getContentType(),
  };
}

async function waitForMeetingToEnd(page: Page, session: BotSession): Promise<void> {
  const ctx = "MeetBot";
  let meetingActive = true;

  while (meetingActive) {
    await page.waitForTimeout(3000);

    // Check if stop was requested
    if (session._stopRequested) {
      logger.info(ctx, "Stop requested, finalizing recording...");
      break;
    }

    // Check if we're still in the meeting
    try {
      const isEnded = await page.evaluate(`
        (function() {
          var bodyText = document.body.textContent || "";
          return (
            bodyText.includes("You left the meeting") ||
            bodyText.includes("left the meeting") ||
            bodyText.includes("Return to home screen") ||
            bodyText.includes("The meeting has ended") ||
            bodyText.includes("You've been removed")
          );
        })()
      `);

      if (isEnded) {
        logger.info(ctx, "Meeting has ended");
        meetingActive = false;
      }
    } catch {
      // Page might have crashed or navigated away — meeting is over
      logger.info(ctx, "Page became unavailable, assuming meeting ended");
      meetingActive = false;
    }
  }
}

/**
 * Request the bot to stop capturing and finalize.
 */
export function requestStop(session: BotSession): void {
  session._stopRequested = true;
  logger.info("MeetBot", "Stop requested for session", { sessionId: session.id });
}
