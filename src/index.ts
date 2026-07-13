import express, { type Request, type Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { loadConfig } from "./config.js";
import { logger } from "./utils/logger.js";
import { startMeetBot, requestStop, type BotSession } from "./services/meetBot.js";
import { answerPRDQuestion, comparePRDVersions, generatePRD, updatePRDWithRoadmap } from "./services/llmService.js";
import { buildVersionHistoryText, postPRDToSlack, postSlackWebhook } from "./services/slackService.js";
import { PostgresSessionStore } from "./services/sessionStore.js";

// ── Load configuration ────────────────────────────────────
const config = loadConfig();

// ── Stateful session store ────────────────────────────────
const sessionStore = new PostgresSessionStore(config.databaseUrl);

// Active browser sessions must stay in memory because Browser/Page handles are
// process-local. Durable session state is stored in PostgreSQL.
const activeSessions = new Map<string, BotSession>();

// ── Express app ───────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

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
app.post("/api/start-bot", async (req, res) => {
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

  activeSessions.set(sessionId, session);

  logger.info("Server", "Starting bot session", { sessionId, meetUrl });

  await sessionStore.upsertSession(session);

  // Run the full pipeline in the background after the initial DB row exists.
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
app.post("/api/stop-bot", async (req, res) => {
  const { sessionId } = req.body as { sessionId?: string };

  if (!sessionId) {
    res.status(400).json({ error: "Missing sessionId." });
    return;
  }

  const session = activeSessions.get(sessionId) ?? await sessionStore.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found." });
    return;
  }

  if (session.status === "completed" || session.status === "error") {
    res.status(400).json({ error: `Session already ${session.status}.` });
    return;
  }

  if (!activeSessions.has(sessionId)) {
    res.status(409).json({
      error: "Session is not active in this server process and cannot be stopped.",
    });
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
app.get("/api/status/:sessionId", async (req, res) => {
  const session = activeSessions.get(req.params.sessionId) ??
    await sessionStore.getSession(req.params.sessionId);

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

/**
 * POST /api/slack/prd (and POST / as a compatibility fallback)
 *
 * Slack slash command endpoint. Configure a command such as `/prd` with this
 * Request URL, then ask questions or provide roadmap updates:
 *
 *   /prd What are the MVP requirements?
 *   /prd roadmap Q3: launch beta. Q4: add admin analytics.
 */
async function handleSlackPRDRequest(req: Request, res: Response): Promise<void> {
  const payload = req.body as {
    text?: string;
    token?: string;
    response_url?: string;
    user_name?: string;
    ssl_check?: string;
  };

  logger.info("SlackCommand", "Received PRD slash command", {
    hasText: Boolean(payload.text),
    hasResponseUrl: Boolean(payload.response_url),
    sslCheck: payload.ssl_check === "1",
  });

  if (payload.ssl_check === "1") {
    res.status(200).send();
    return;
  }

  if (
    config.slackSlashCommandToken &&
    payload.token !== config.slackSlashCommandToken
  ) {
    res.status(200).json({
      response_type: "ephemeral",
      text: "Unauthorized Slack command.",
    });
    return;
  }

  const text = payload.text?.trim() ?? "";
  const responseUrl = payload.response_url;

  if (!responseUrl) {
    res.status(200).json({
      response_type: "ephemeral",
      text: "Slack command payload was missing response_url.",
    });
    return;
  }

  const session = await findSessionForSlackCommand(text);
  if (!session?.prd) {
    res.json({
      response_type: "ephemeral",
      text: "No completed PRD is available yet. Start and finish a Meet bot session first.",
    });
    return;
  }

  if (!text || /^help$/i.test(text)) {
    res.json({
      response_type: "ephemeral",
      text: buildSlackCommandHelp(session.id),
    });
    return;
  }

  res.json({
    response_type: "ephemeral",
    text: "Working on that PRD request...",
  });

  handleSlackPRDCommand(session, text, responseUrl, payload.user_name).catch((err) => {
    logger.error("SlackCommand", "Failed to handle PRD command", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

app.post("/api/slack/prd", (req, res) => {
  handleSlackPRDRequest(req, res).catch((err) => {
    logger.error("SlackCommand", "Failed before Slack acknowledgement", {
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.status(200).json({
        response_type: "ephemeral",
        text: "The PRD command failed before it could be processed.",
      });
    }
  });
});
app.post("/", (req, res) => {
  handleSlackPRDRequest(req, res).catch((err) => {
    logger.error("SlackCommand", "Failed before Slack acknowledgement", {
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.status(200).json({
        response_type: "ephemeral",
        text: "The PRD command failed before it could be processed.",
      });
    }
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
    const transcript = await startMeetBot(
      session,
      config.authStatePath,
      config.botDisplayName,
      config.deepgramApiKey,
    );

    if (transcript.length === 0) {
      logger.warn(ctx, "No transcript captured. Skipping PRD generation.", {
        sessionId: session.id,
      });
      session.status = "completed";
      session.error = "No transcript was captured. Was meeting audio available to the bot?";
      await sessionStore.upsertSession(session);
      return;
    }

    // Step 2: Generate PRD
    session.status = "processing";
    await sessionStore.upsertSession(session);
    logger.info(ctx, "Step 2/3: Generating PRD with Gemini...", {
      sessionId: session.id,
      segments: transcript.length,
    });

    const prd = await generatePRD(config.geminiApiKey, transcript);
    session.prd = prd;
    await sessionStore.upsertSession(session);
    const prdVersion = await sessionStore.createPRDVersion(session, {
      changeSummary: "Initial generated PRD",
    });

    // Step 3: Post to Slack
    logger.info(ctx, "Step 3/3: Posting PRD to Slack...", {
      sessionId: session.id,
    });

    const durationMs = session.endedAt
      ? session.endedAt.getTime() - session.startedAt.getTime()
      : Date.now() - session.startedAt.getTime();

    const durationMin = Math.round(durationMs / 60_000);

    await postPRDToSlack(config.slackWebhookUrl, prd, {
      meetUrl: session.meetUrl,
      meetingDuration: `${durationMin} minutes`,
      sessionId: session.id,
      version: prdVersion.version,
    });

    session.status = "completed";
    await sessionStore.upsertSession(session);
    logger.info(ctx, "Pipeline completed successfully!", { sessionId: session.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    session.status = "error";
    session.error = message;
    await sessionStore.upsertSession(session);
    logger.error(ctx, "Pipeline failed", { sessionId: session.id, error: message });
  } finally {
    activeSessions.delete(session.id);
  }
}

async function findSessionForSlackCommand(text: string): Promise<BotSession | null> {
  const firstToken = text.split(/\s+/, 1)[0];
  if (firstToken && isUuid(firstToken)) {
    const active = activeSessions.get(firstToken);
    if (active) return active;

    const stored = await sessionStore.getSession(firstToken);
    if (stored) return stored;
  }

  return sessionStore.getLatestPRDSession();
}

function stripOptionalSessionId(text: string): string {
  const [firstToken, ...rest] = text.split(/\s+/);
  if (firstToken && isUuid(firstToken)) {
    return rest.join(" ").trim();
  }
  return text.trim();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function handleSlackPRDCommand(
  session: BotSession,
  rawText: string,
  responseUrl: string,
  userName?: string,
): Promise<void> {
  const text = stripOptionalSessionId(rawText);
  const historyMatch = text.match(/^history$/i);
  const showMatch = text.match(/^show\s+v?(\d+)$/i);
  const diffMatch = text.match(/^diff\s+v?(\d+)\s+v?(\d+)$/i);
  const roadmapMatch = text.match(/^(roadmap|update|revise|change)\s*:?\s+([\s\S]+)/i);

  if (historyMatch) {
    const versions = await sessionStore.listPRDVersions(session.id);
    await postSlackWebhook(responseUrl, {
      response_type: "in_channel",
      text: `*PRD version history for* \`${session.id}\`\n${buildVersionHistoryText(versions)}`,
    });
    return;
  }

  if (showMatch) {
    const versionNumber = Number(showMatch[1]);
    const version = await sessionStore.getPRDVersion(session.id, versionNumber);
    if (!version) {
      await postSlackWebhook(responseUrl, {
        response_type: "ephemeral",
        text: `Could not find PRD version v${versionNumber} for \`${session.id}\`.`,
      });
      return;
    }

    await postSlackWebhook(responseUrl, {
      response_type: "in_channel",
      text: `Posting PRD v${version.version} for \`${session.id}\`.`,
    });
    await postPRDToSlack(config.slackWebhookUrl, version.prd, {
      meetUrl: session.meetUrl,
      meetingDuration: session.endedAt
        ? `${Math.round((session.endedAt.getTime() - session.startedAt.getTime()) / 60_000)} minutes`
        : undefined,
      sessionId: session.id,
      version: version.version,
      reason: version.changeSummary ?? version.roadmapNotes,
    });
    return;
  }

  if (diffMatch) {
    const olderNumber = Number(diffMatch[1]);
    const newerNumber = Number(diffMatch[2]);
    const [olderVersion, newerVersion] = await Promise.all([
      sessionStore.getPRDVersion(session.id, olderNumber),
      sessionStore.getPRDVersion(session.id, newerNumber),
    ]);

    if (!olderVersion || !newerVersion) {
      await postSlackWebhook(responseUrl, {
        response_type: "ephemeral",
        text: `Could not find both requested versions for \`${session.id}\`. Try \`/prd history\`.`,
      });
      return;
    }

    const diff = await comparePRDVersions(
      config.geminiApiKey,
      olderVersion.prd,
      newerVersion.prd,
      `v${olderVersion.version}`,
      `v${newerVersion.version}`,
    );

    await postSlackWebhook(responseUrl, {
      response_type: "in_channel",
      text: `*PRD diff: v${olderVersion.version} → v${newerVersion.version}*\n${diff}`,
    });
    return;
  }

  if (roadmapMatch) {
    const roadmapNotes = roadmapMatch[2].trim();
    const updatedPrd = await updatePRDWithRoadmap(config.geminiApiKey, session.prd!, roadmapNotes);
    session.roadmap = [session.roadmap, roadmapNotes].filter(Boolean).join("\n\n");
    session.prd = updatedPrd;
    await sessionStore.upsertSession(session);
    const prdVersion = await sessionStore.createPRDVersion(session, {
      roadmapNotes,
      changeSummary: `Roadmap update from Slack${userName ? ` by ${userName}` : ""}`,
    });

    await postSlackWebhook(responseUrl, {
      response_type: "in_channel",
      text: `Updated PRD from roadmap notes${userName ? ` by ${userName}` : ""}. Created v${prdVersion.version} and posting the refreshed PRD now.`,
    });

    await postPRDToSlack(config.slackWebhookUrl, updatedPrd, {
      meetUrl: session.meetUrl,
      meetingDuration: session.endedAt
        ? `${Math.round((session.endedAt.getTime() - session.startedAt.getTime()) / 60_000)} minutes`
        : undefined,
      sessionId: session.id,
      version: prdVersion.version,
      reason: roadmapNotes,
    });
    return;
  }

  const answer = await answerPRDQuestion(
    config.geminiApiKey,
    session.prd!,
    text,
    session.transcript,
    session.roadmap,
  );

  await postSlackWebhook(responseUrl, {
    response_type: "in_channel",
    text: `*PRD answer*\n${answer}`,
  });
}

function buildSlackCommandHelp(sessionId: string): string {
  return [
    "*PRD commands*",
    `Session: \`${sessionId}\``,
    "• Ask: `/prd What is in scope?`",
    "• Update: `/prd roadmap Q3 beta, Q4 launch`",
    "• Versions: `/prd history` · `/prd show v2` · `/prd diff v1 v2`",
    "• Target: `/prd <sessionId> history`",
  ].join("\n");
}

// ── Start the server ──────────────────────────────────────
async function startServer(): Promise<void> {
  await sessionStore.init();
  await sessionStore.markInterruptedActiveSessions();

  app.listen(config.port, () => {
    logger.info("Server", `🚀 AI PRD Generator running on http://localhost:${config.port}`);
    logger.info("Server", "Endpoints:");
    logger.info("Server", "  POST /api/start-bot   — Start the bot with a Meet URL");
    logger.info("Server", "  POST /api/stop-bot    — Stop a running bot session");
    logger.info("Server", "  POST /api/slack/prd   — Slack PRD Q&A and roadmap updates");
    logger.info("Server", "  GET  /api/status/:id  — Check bot session status");
    logger.info("Server", "  GET  /health          — Health check");
  });
}

startServer().catch((err) => {
  logger.error("Server", "Failed to start server", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
});
