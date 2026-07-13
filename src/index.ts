import express from "express";
import { v4 as uuidv4 } from "uuid";
import { loadConfig } from "./config.js";
import { logger } from "./utils/logger.js";
import { startMeetBot, requestStop, type BotSession } from "./services/meetBot.js";
import { generatePRD } from "./services/llmService.js";
import { postPRDToSlack } from "./services/slackService.js";

// ── Load configuration ────────────────────────────────────
const config = loadConfig();

// ── In-memory session store ───────────────────────────────
const sessions = new Map<string, BotSession>();

// ── Express app ───────────────────────────────────────────
const app = express();
app.use(express.json());

// ── Health check ──────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

/**
 * POST /api/start-bot
 *
 * Body: { "meetUrl": "https://meet.google.com/xxx-yyyy-zzz" }
 *
 * Launches the Meet bot in the background. Returns a session ID
 * that can be used to check status or stop the bot.
 */
app.post("/api/start-bot", (req, res) => {
  const { meetUrl } = req.body as { meetUrl?: string };

  if (!meetUrl || !meetUrl.includes("meet.google.com")) {
    res.status(400).json({
      error: "Invalid or missing meetUrl. Must be a Google Meet URL.",
    });
    return;
  }

  const sessionId = uuidv4();
  const session: BotSession = {
    id: sessionId,
    meetUrl,
    status: "joining",
    transcript: [],
    startedAt: new Date(),
    _stopRequested: false,
  };

  sessions.set(sessionId, session);

  logger.info("Server", "Starting bot session", { sessionId, meetUrl });

  // Run the full pipeline in the background
  runPipeline(session).catch((err) => {
    logger.error("Server", "Pipeline failed", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  res.status(202).json({
    sessionId,
    message: "Bot is joining the meeting. Use GET /api/status/:sessionId to check progress.",
  });
});

/**
 * POST /api/stop-bot
 *
 * Body: { "sessionId": "..." }
 *
 * Signals the bot to stop capturing and finalize the transcript.
 */
app.post("/api/stop-bot", (req, res) => {
  const { sessionId } = req.body as { sessionId?: string };

  if (!sessionId) {
    res.status(400).json({ error: "Missing sessionId." });
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found." });
    return;
  }

  if (session.status === "completed" || session.status === "error") {
    res.status(400).json({ error: `Session already ${session.status}.` });
    return;
  }

  requestStop(session);
  res.json({ message: "Stop signal sent. The bot will finalize shortly." });
});

/**
 * GET /api/status/:sessionId
 *
 * Returns the current status of a bot session.
 */
app.get("/api/status/:sessionId", (req, res) => {
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    res.status(404).json({ error: "Session not found." });
    return;
  }

  res.json({
    sessionId: session.id,
    status: session.status,
    meetUrl: session.meetUrl,
    startedAt: session.startedAt.toISOString(),
    endedAt: session.endedAt?.toISOString() ?? null,
    transcriptSegments: session.transcript.length,
    error: session.error ?? null,
  });
});

// ── Pipeline ──────────────────────────────────────────────

/**
 * The full pipeline:
 * 1. Join meeting and capture transcript
 * 2. Generate PRD via Gemini
 * 3. Post to Slack
 */
async function runPipeline(session: BotSession): Promise<void> {
  const ctx = "Pipeline";

  try {
    // Step 1: Join meeting and capture transcript
    logger.info(ctx, "Step 1/3: Joining meeting and capturing transcript...", {
      sessionId: session.id,
    });
    const transcript = await startMeetBot(session, config.authStatePath, config.botDisplayName);

    if (transcript.length === 0) {
      logger.warn(ctx, "No transcript captured. Skipping PRD generation.", {
        sessionId: session.id,
      });
      session.status = "completed";
      session.error = "No transcript was captured. Were captions enabled?";
      return;
    }

    // Step 2: Generate PRD
    session.status = "processing";
    logger.info(ctx, "Step 2/3: Generating PRD with Gemini...", {
      sessionId: session.id,
      segments: transcript.length,
    });

    const prd = await generatePRD(config.geminiApiKey, transcript);

    // Step 3: Post to Slack
    logger.info(ctx, "Step 3/3: Posting PRD to Slack...", {
      sessionId: session.id,
    });

    const durationMs = session.endedAt
      ? session.endedAt.getTime() - session.startedAt.getTime()
      : Date.now() - session.startedAt.getTime();

    const durationMin = Math.round(durationMs / 60_000);

    await postPRDToSlack(config.slackBotToken, config.slackChannelId, prd, {
      meetUrl: session.meetUrl,
      meetingDuration: `${durationMin} minutes`,
    });

    session.status = "completed";
    logger.info(ctx, "Pipeline completed successfully!", { sessionId: session.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    session.status = "error";
    session.error = message;
    logger.error(ctx, "Pipeline failed", { sessionId: session.id, error: message });
  }
}

// ── Start the server ──────────────────────────────────────
app.listen(config.port, () => {
  logger.info("Server", `🚀 AI PRD Generator running on http://localhost:${config.port}`);
  logger.info("Server", "Endpoints:");
  logger.info("Server", "  POST /api/start-bot   — Start the bot with a Meet URL");
  logger.info("Server", "  POST /api/stop-bot    — Stop a running bot session");
  logger.info("Server", "  GET  /api/status/:id  — Check bot session status");
  logger.info("Server", "  GET  /health          — Health check");
});
