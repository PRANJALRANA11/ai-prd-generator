import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import path from "path";
import fs from "fs";
import { logger } from "../utils/logger.js";

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
  startedAt: Date;
  endedAt?: Date;
  error?: string;
  /** Internal — used to signal the bot to stop */
  _stopRequested: boolean;
  _browser?: Browser;
  _page?: Page;
  _context?: BrowserContext;
}

/**
 * Raw JavaScript string evaluated in the browser context.
 * Keep this as a string so tsx/esbuild cannot add helper references that are
 * unavailable inside the page.
 */
const CAPTION_OBSERVER_SCRIPT = `
(function() {
  window.__captionData = [];
  window.__lastCaptionText = "";

  var findCaptionContainer = function() {
    var ariaLive = document.querySelector('[aria-live="polite"]');
    if (ariaLive) return ariaLive;

    var containers = document.querySelectorAll("div[jscontroller]");
    for (var i = 0; i < containers.length; i++) {
      var el = containers[i];
      var text = el.textContent || "";
      if (text.length > 0 && text.length < 500 && el.children.length > 0) {
        var styles = window.getComputedStyle(el);
        if (styles.position === "fixed" || styles.position === "absolute") {
          return el;
        }
      }
    }
    return null;
  };

  var extractSpeakerAndText = function(node) {
    var children = Array.from(node.children);
    if (children.length >= 2) {
      var possibleSpeaker = (children[0].textContent || "").trim();
      var possibleText = children.slice(1).map(function(c) { return (c.textContent || "").trim(); }).join(" ");
      if (possibleSpeaker && possibleText) {
        return { speaker: possibleSpeaker, text: possibleText };
      }
    }
    return { speaker: "Unknown", text: (node.textContent || "").trim() };
  };

  var pollInterval = setInterval(function() {
    var container = findCaptionContainer();
    if (!container) return;

    clearInterval(pollInterval);

    var observer = new MutationObserver(function() {
      var captionElements = container.querySelectorAll("div[class]");
      var allText = (container.textContent || "").trim();

      if (allText && allText !== window.__lastCaptionText) {
        window.__lastCaptionText = allText;

        if (captionElements.length > 0) {
          for (var j = 0; j < captionElements.length; j++) {
            var result = extractSpeakerAndText(captionElements[j]);
            if (result.text) {
              window.__captionData.push({
                timestamp: new Date().toISOString(),
                speaker: result.speaker,
                text: result.text,
              });
            }
          }
        } else {
          window.__captionData.push({
            timestamp: new Date().toISOString(),
            speaker: "Unknown",
            text: allText,
          });
        }
      }
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }, 2000);
})();
`;

const DEFAULT_FAKE_VIDEO_PATH = path.resolve("assets", "bot-background.y4m");

/**
 * Launches a Playwright browser, joins the Google Meet call, enables captions,
 * and accumulates the transcript until the meeting ends or stop is requested.
 */
export async function startMeetBot(
  session: BotSession,
  authStatePath: string,
  botDisplayName: string,
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

  const fakeVideoPath = path.resolve(process.env.BOT_FAKE_VIDEO_PATH ?? DEFAULT_FAKE_VIDEO_PATH);
  const browserArgs = [
    "--disable-blink-features=AutomationControlled",
    "--use-fake-ui-for-media-stream",       // Auto-allow mic/camera prompts
    "--use-fake-device-for-media-stream",   // Use fake media devices
    "--disable-notifications",
    "--no-sandbox",
  ];
  const useBotBackground = fs.existsSync(fakeVideoPath);

  if (useBotBackground) {
    browserArgs.push(`--use-file-for-fake-video-capture=${fakeVideoPath}`);
    logger.info(ctx, "Using bot camera background", { fakeVideoPath });
  } else {
    logger.warn(ctx, "Bot camera background file not found; using Chromium's default fake video", {
      fakeVideoPath,
    });
  }

  const browser = await chromium.launch({
    headless: false, // Visible browser so you can watch in real-time
    args: browserArgs,
  });
  session._browser = browser;

  const context = await browser.newContext({
    storageState: resolvedAuthPath,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    permissions: ["microphone", "camera"],
    viewport: { width: 1280, height: 720 },
  });
  session._context = context;

  const page = await context.newPage();
  session._page = page;

  try {
    // ── Navigate to the Meet URL ───────────────────────────
    session.status = "joining";
    logger.info(ctx, "Navigating to Meet URL", { url: session.meetUrl });
    await page.goto(session.meetUrl, { waitUntil: "networkidle", timeout: 30_000 });

    // Give the page a moment to fully render the pre-join screen
    await page.waitForTimeout(5000);

    // ── Handle pre-join screen ─────────────────────────────
    // Turn off microphone if the toggle is visible
    try {
      const micButton = page.locator('[aria-label*="microphone" i], [aria-label*="mic" i], [data-is-muted]').first();
      if (await micButton.isVisible({ timeout: 3000 })) {
        await micButton.click();
        logger.info(ctx, "Muted microphone");
      }
    } catch {
      logger.debug(ctx, "Microphone toggle not found or already muted");
    }

    if (useBotBackground) {
      logger.info(ctx, "Keeping camera on for bot background");
    } else {
      // Turn off camera if the toggle is visible
      try {
        const cameraButton = page.locator('[aria-label*="camera" i], [aria-label*="video" i]').first();
        if (await cameraButton.isVisible({ timeout: 3000 })) {
          await cameraButton.click();
          logger.info(ctx, "Turned off camera");
        }
      } catch {
        logger.debug(ctx, "Camera toggle not found or already off");
      }
    }

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

    // ── Enable captions ────────────────────────────────────
    await enableCaptions(page);

    // ── Start caption scraping ─────────────────────────────
    logger.info(ctx, "Starting caption capture...");
    const transcript = await scrapeCaptions(page, session);

    session.transcript = transcript;
    session.endedAt = new Date();
    logger.info(ctx, "Meeting ended. Transcript captured.", {
      segments: transcript.length,
    });

    return transcript;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(ctx, "Bot error", { error: message });
    session.status = "error";
    session.error = message;
    throw err;
  } finally {
    try {
      await browser.close();
    } catch {
      // Ignore close errors
    }
  }
}

/**
 * Attempts to enable closed captions / subtitles in the Meet UI.
 */
async function enableCaptions(page: Page): Promise<void> {
  const ctx = "MeetBot:Captions";

  // Try multiple selector strategies for the CC / captions button
  const captionSelectors = [
    'button[aria-label*="captions" i]',
    'button[aria-label*="subtitle" i]',
    'button[aria-label*="closed caption" i]',
    '[data-tooltip*="caption" i]',
  ];

  for (const selector of captionSelectors) {
    try {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 3000 })) {
        await btn.click();
        logger.info(ctx, "Captions enabled", { selector });
        await page.waitForTimeout(1000);
        return;
      }
    } catch {
      continue;
    }
  }

  // Fallback: try through the "More options" (three-dot) menu
  logger.info(ctx, "Trying to enable captions via More Options menu...");
  try {
    const moreBtn = page.locator(
      'button[aria-label*="more" i], button[aria-label*="options" i]',
    ).first();
    if (await moreBtn.isVisible({ timeout: 3000 })) {
      await moreBtn.click();
      await page.waitForTimeout(1000);

      const captionMenuItem = page.locator(
        'li:has-text("Captions"), [role="menuitem"]:has-text("caption"), span:has-text("Turn on captions")',
      ).first();
      if (await captionMenuItem.isVisible({ timeout: 3000 })) {
        await captionMenuItem.click();
        logger.info(ctx, "Captions enabled via More Options menu");
        await page.waitForTimeout(1000);
        return;
      }
    }
  } catch {
    // Continue with warning
  }

  logger.warn(ctx, "Could not enable captions automatically. Please enable them manually in the meeting.");
}

/**
 * Installs a MutationObserver in the page and polls for caption data until the
 * meeting ends.
 */
async function scrapeCaptions(page: Page, session: BotSession): Promise<TranscriptSegment[]> {
  const ctx = "MeetBot:Scraper";

  // Evaluate directly through the browser protocol. Google Meet enforces
  // Trusted Types, which blocks addScriptTag({ content }) because it assigns
  // raw text to an HTMLScriptElement.
  await page.evaluate(CAPTION_OBSERVER_SCRIPT);

  logger.info(ctx, "Caption observer injected, waiting for meeting to end...");

  // Poll until the meeting ends or stop is requested
  const transcript: TranscriptSegment[] = [];
  let meetingActive = true;

  while (meetingActive) {
    await page.waitForTimeout(3000);

    // Check if stop was requested
    if (session._stopRequested) {
      logger.info(ctx, "Stop requested, finalizing transcript...");
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

    // Collect any new caption data
    try {
      const newData = await page.evaluate(`
        (function() {
          var data = (window.__captionData || []).slice();
          window.__captionData = [];
          return data;
        })()
      `) as TranscriptSegment[];
      if (newData.length > 0) {
        transcript.push(...newData);
        logger.debug(ctx, `Collected ${newData.length} new caption segments`);
      }
    } catch {
      // Ignore — page might be closing
    }
  }

  // Final collection
  try {
    const remaining = await page.evaluate(`
      (function() {
        var data = (window.__captionData || []).slice();
        window.__captionData = [];
        return data;
      })()
    `) as TranscriptSegment[];
    transcript.push(...remaining);
  } catch {
    // Ignore
  }

  return deduplicateTranscript(transcript);
}

/**
 * Remove duplicate consecutive segments (captions often fire multiple times
 * as the text is refined).
 */
function deduplicateTranscript(segments: TranscriptSegment[]): TranscriptSegment[] {
  if (segments.length === 0) return [];

  const deduped: TranscriptSegment[] = [segments[0]];

  for (let i = 1; i < segments.length; i++) {
    const prev = deduped[deduped.length - 1];
    const curr = segments[i];

    // Skip if same speaker and the text is a substring of the previous
    if (curr.speaker === prev.speaker && prev.text.includes(curr.text)) {
      continue;
    }

    // If the current text contains the previous text, replace it (it's more complete)
    if (curr.speaker === prev.speaker && curr.text.includes(prev.text)) {
      deduped[deduped.length - 1] = curr;
      continue;
    }

    deduped.push(curr);
  }

  return deduped;
}

/**
 * Request the bot to stop capturing and finalize.
 */
export function requestStop(session: BotSession): void {
  session._stopRequested = true;
  logger.info("MeetBot", "Stop requested for session", { sessionId: session.id });
}
