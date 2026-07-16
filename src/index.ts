import express, { type Request, type Response } from "express";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import type { IncomingMessage, ServerResponse } from "http";
import { loadConfig } from "./config.js";
import { logger } from "./utils/logger.js";
import { startMeetBot, requestStop, type BotSession } from "./services/meetBot.js";
import { answerPRDQuestion, comparePRDVersions, generateLinearTicketSpecs, generatePRD, updatePRDWithRoadmap } from "./services/llmService.js";
import { createLinearIssues, type LinearIssue } from "./services/linearService.js";
import { buildVersionHistoryText, postPRDToSlack, postSlackWebhook, type SlackWebhookPayload } from "./services/slackService.js";
import type { LinearIssueRecord } from "./services/sessionStore.js";
import { PostgresSessionStore } from "./services/sessionStore.js";
import { appendSessionLog, getSessionLogs, subscribeToSessionLogs } from "./services/liveLogService.js";

// ── Load configuration ────────────────────────────────────
const config = loadConfig();

// ── Stateful session store ────────────────────────────────
const sessionStore = new PostgresSessionStore(config.databaseUrl);

// Active browser sessions must stay in memory because Browser/Page handles are
// process-local. Durable session state is stored in PostgreSQL.
const activeSessions = new Map<string, BotSession>();

// ── Express app ───────────────────────────────────────────
const app = express();
app.use(express.json({ verify: captureRawBody }));
app.use(express.urlencoded({ extended: false, verify: captureRawBody }));

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
app.use(express.static(publicDir));

// ── Health check ──────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.get("/api/config", (_req, res) => {
  res.json({
    slackWebhookConfigured: Boolean(config.slackWebhookUrl),
    slashCommandPath: "/api/slack/prd",
    slackInteractionPath: "/api/slack/interactions",
    linearConfigured: Boolean(config.linearApiKey && config.linearTeamId),
  });
});

app.post("/api/slack/test", async (req, res) => {
  const { slackWebhookUrl } = req.body as { slackWebhookUrl?: string };
  const webhookUrl = parseOptionalWebhook(slackWebhookUrl, res) ?? config.slackWebhookUrl;
  if (res.headersSent) return;

  await postSlackWebhook(webhookUrl, {
    text: "AI PRD Generator is connected to this Slack channel.",
  });

  res.json({ ok: true });
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
  const { meetUrl, slackWebhookUrl } = req.body as {
    meetUrl?: string;
    slackWebhookUrl?: string;
  };
  const normalizedMeetUrl = normalizeMeetUrl(meetUrl);
  const normalizedSlackWebhookUrl = parseOptionalWebhook(slackWebhookUrl, res);
  if (res.headersSent) return;

  if (!normalizedMeetUrl) {
    res.status(400).json({
      error: "Invalid or missing meetUrl. Enter a Google Meet URL or meeting code.",
    });
    return;
  }

  const sessionId = uuidv4();
  const session: BotSession = {
    id: sessionId,
    meetUrl: normalizedMeetUrl,
    status: "joining",
    transcript: [],
    slackWebhookUrl: normalizedSlackWebhookUrl,
    startedAt: new Date(),
    _stopRequested: false,
  };

  activeSessions.set(sessionId, session);

  logger.info("Server", "Starting bot session", { sessionId, meetUrl: normalizedMeetUrl });
  appendSessionLog(sessionId, "info", "Bot launch requested", {
    meetUrl: normalizedMeetUrl,
    mode: "notetaker",
  });

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

app.get("/api/logs/:sessionId", (req, res) => {
  res.json({
    sessionId: req.params.sessionId,
    logs: getSessionLogs(req.params.sessionId),
  });
});

app.get("/api/logs/:sessionId/stream", (req, res) => {
  const sessionId = req.params.sessionId;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const send = (entry: unknown) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  };

  getSessionLogs(sessionId).forEach(send);
  const unsubscribe = subscribeToSessionLogs(sessionId, send);
  const keepAlive = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 25_000);

  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
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

  if (!verifyConfiguredSlackRequest(req, payload.token)) {
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

interface SlackInteractionPayload {
  type?: string;
  token?: string;
  response_url?: string;
  user?: {
    id?: string;
    username?: string;
    name?: string;
  };
  actions?: Array<{
    action_id?: string;
    value?: string;
  }>;
}

async function handleSlackInteractionRequest(req: Request, res: Response): Promise<void> {
  const payload = parseSlackInteractionPayload(req);
  if (!payload) {
    res.status(400).send("Missing Slack interaction payload.");
    return;
  }

  if (!verifySlackRequest(req, payload.token)) {
    res.status(401).send("Unauthorized Slack interaction.");
    return;
  }

  const action = payload.actions?.[0];
  if (action?.action_id !== "approve_linear_tickets" || !action.value) {
    res.status(200).json({
      response_type: "ephemeral",
      text: "Unsupported PRD action.",
    });
    return;
  }

  res.status(200).json({
    response_type: "ephemeral",
    text: "Creating Linear tickets from the approved PRD...",
  });

  handleLinearTicketApproval(action.value, payload).catch((err) => {
    logger.error("SlackInteraction", "Failed to handle Linear ticket approval", {
      sessionId: action.value,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

app.post("/api/slack/interactions", (req, res) => {
  handleSlackInteractionRequest(req, res).catch((err) => {
    logger.error("SlackInteraction", "Failed before Slack acknowledgement", {
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.status(200).json({
        response_type: "ephemeral",
        text: "The Slack approval action failed before it could be processed.",
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
    appendSessionLog(session.id, "info", "Joining Meet and starting transcript capture");
    const transcript = await startMeetBot(
      session,
      config.authStatePath,
      config.botDisplayName,
      config.deepgramApiKey,
      config.playwrightHeadless,
    );

    if (transcript.length === 0) {
      logger.warn(ctx, "No transcript captured. Skipping PRD generation.", {
        sessionId: session.id,
      });
	      session.status = "completed";
	      session.error = "No transcript was captured. Was meeting audio available to the bot?";
	      await sessionStore.upsertSession(session);
	      appendSessionLog(session.id, "warn", "No transcript was captured");
	      return;
	    }

    // Step 2: Generate PRD
    session.status = "processing";
    await sessionStore.upsertSession(session);
	    logger.info(ctx, "Step 2/3: Generating PRD with Gemini...", {
	      sessionId: session.id,
	      segments: transcript.length,
	    });
	    appendSessionLog(session.id, "info", "Generating PRD with Gemini", {
	      transcriptSegments: transcript.length,
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
	    appendSessionLog(session.id, "info", "Posting PRD to Slack");

    const durationMs = session.endedAt
      ? session.endedAt.getTime() - session.startedAt.getTime()
      : Date.now() - session.startedAt.getTime();

    const durationMin = Math.round(durationMs / 60_000);

    await postPRDToSlack(getSessionSlackWebhook(session), prd, {
      meetUrl: session.meetUrl,
      meetingDuration: `${durationMin} minutes`,
      sessionId: session.id,
      version: prdVersion.version,
    });

	    session.status = "completed";
	    await sessionStore.upsertSession(session);
	    logger.info(ctx, "Pipeline completed successfully!", { sessionId: session.id });
	    appendSessionLog(session.id, "info", "Pipeline completed successfully");
	  } catch (err) {
	    const message = err instanceof Error ? err.message : String(err);
	    session.status = "error";
	    session.error = message;
	    await sessionStore.upsertSession(session);
	    logger.error(ctx, "Pipeline failed", { sessionId: session.id, error: message });
	    appendSessionLog(session.id, "error", "Pipeline failed", { error: message });
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
    await postPRDToSlack(getSessionSlackWebhook(session), version.prd, {
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

    await postPRDToSlack(getSessionSlackWebhook(session), updatedPrd, {
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

async function handleLinearTicketApproval(
  sessionId: string,
  payload: SlackInteractionPayload,
): Promise<void> {
  const responseUrl = payload.response_url;
  const approvedBy = formatSlackUser(payload);

  try {
    const session = activeSessions.get(sessionId) ?? await sessionStore.getSession(sessionId);
    if (!session?.prd) {
      await postSlackInteractionResponse(responseUrl, {
        response_type: "ephemeral",
        text: "No completed PRD was found for that session.",
      });
      return;
    }

    if (!config.linearApiKey || !config.linearTeamId) {
      await postSlackInteractionResponse(responseUrl, {
        response_type: "ephemeral",
        text: "Linear is not configured yet. Set LINEAR_API_KEY and LINEAR_TEAM_ID, then retry the approval.",
      });
      return;
    }

    const existingIssues = await sessionStore.getLinearIssues(session.id);
    if (existingIssues.length > 0) {
      await postSlackInteractionResponse(responseUrl, buildLinearIssueMessage(
        session.id,
        existingIssues,
        "Linear tickets were already created for this PRD.",
        "ephemeral",
      ));
      return;
    }

    const existingBatch = await sessionStore.getLinearIssueBatch(session.id);
    if (existingBatch?.status === "creating") {
      await postSlackInteractionResponse(responseUrl, {
        response_type: "ephemeral",
        text: "Linear ticket creation is already in progress for this PRD.",
      });
      return;
    }

    await sessionStore.markLinearIssueBatch(session.id, "creating", {
      approvedBy,
      approvedAt: new Date(),
    });

    logger.info("LinearApproval", "Generating Linear tickets from approved PRD", {
      sessionId: session.id,
      approvedBy,
    });

    const ticketSpecs = await generateLinearTicketSpecs(config.geminiApiKey, session.prd);
    const issues = await createLinearIssues(
      {
        apiKey: config.linearApiKey,
        teamId: config.linearTeamId,
        projectId: config.linearProjectId,
        assigneeId: config.linearAssigneeId,
        labelIds: config.linearLabelIds,
      },
      ticketSpecs,
      {
        sessionId: session.id,
        meetUrl: session.meetUrl,
      },
    );

    const savedIssues = await sessionStore.saveLinearIssues(session.id, issues);
    await sessionStore.markLinearIssueBatch(session.id, "created", {
      approvedBy,
      approvedAt: new Date(),
    });

    await postSlackInteractionResponse(responseUrl, buildLinearIssueMessage(
      session.id,
      savedIssues,
      `${approvedBy ? `${approvedBy} approved the PRD. ` : ""}Created ${savedIssues.length} Linear ticket${savedIssues.length === 1 ? "" : "s"}.`,
      "in_channel",
    ));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("LinearApproval", "Failed to create Linear tickets", {
      sessionId,
      error: message,
    });

    if (isUuid(sessionId)) {
      await sessionStore.markLinearIssueBatch(sessionId, "error", { error: message });
    }

    await postSlackInteractionResponse(responseUrl, {
      response_type: "ephemeral",
      text: `Could not create Linear tickets: ${message}`,
    });
  }
}

function buildLinearIssueMessage(
  sessionId: string,
  issues: Array<LinearIssue | LinearIssueRecord>,
  leadText: string,
  responseType: "ephemeral" | "in_channel",
): SlackWebhookPayload {
  const issueLines = issues
    .map((issue) => {
      const label = issue.identifier ?? issue.title;
      return issue.url
        ? `• <${issue.url}|${label}> - ${issue.title}`
        : `• ${label} - ${issue.title}`;
    })
    .join("\n");

  return {
    response_type: responseType,
    text: `${leadText}\n${issueLines}`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Linear Tickets Ready",
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*PRD session:* \`${sessionId}\`\n${leadText}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: issueLines || "No Linear tickets were created.",
        },
      },
    ],
  };
}

async function postSlackInteractionResponse(
  responseUrl: string | undefined,
  payload: SlackWebhookPayload,
): Promise<void> {
  if (!responseUrl) {
    logger.warn("SlackInteraction", "Slack interaction did not include response_url", {
      text: payload.text,
    });
    return;
  }

  await postSlackWebhook(responseUrl, payload);
}

function parseSlackInteractionPayload(req: Request): SlackInteractionPayload | null {
  const body = req.body as { payload?: unknown };
  if (typeof body.payload !== "string") {
    return null;
  }

  try {
    return JSON.parse(body.payload) as SlackInteractionPayload;
  } catch {
    return null;
  }
}

function formatSlackUser(payload: SlackInteractionPayload): string | undefined {
  const user = payload.user;
  if (!user) return undefined;
  return user.username ?? user.name ?? user.id;
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

function getSessionSlackWebhook(session: BotSession): string {
  return session.slackWebhookUrl ?? config.slackWebhookUrl;
}

function captureRawBody(req: IncomingMessage, _res: ServerResponse, buffer: Buffer): void {
  (req as IncomingMessage & { rawBody?: string }).rawBody = buffer.toString("utf8");
}

function verifyConfiguredSlackRequest(req: Request, fallbackToken?: string): boolean {
  if (!config.slackSigningSecret && !config.slackSlashCommandToken) {
    return true;
  }
  return verifySlackRequest(req, fallbackToken);
}

function verifySlackRequest(req: Request, fallbackToken?: string): boolean {
  if (config.slackSigningSecret && verifySlackSignature(req, config.slackSigningSecret)) {
    return true;
  }

  return Boolean(config.slackSlashCommandToken && fallbackToken === config.slackSlashCommandToken);
}

function verifySlackSignature(req: Request, signingSecret: string): boolean {
  const timestamp = req.header("x-slack-request-timestamp");
  const signature = req.header("x-slack-signature");
  const rawBody = (req as Request & { rawBody?: string }).rawBody;

  if (!timestamp || !signature || !rawBody) {
    return false;
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }

  const fiveMinutes = 60 * 5;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > fiveMinutes) {
    return false;
  }

  const baseString = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${crypto
    .createHmac("sha256", signingSecret)
    .update(baseString)
    .digest("hex")}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function normalizeMeetUrl(value: string | undefined): string | null {
  const input = value?.trim();
  if (!input) return null;

  if (/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(input)) {
    return input;
  }

  const code = input
    .replace(/^https?:\/\/meet\.google\.com\//i, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();

  if (!/^[a-z]{10}$/.test(code)) return null;
  return `https://meet.google.com/${code.slice(0, 3)}-${code.slice(3, 7)}-${code.slice(7)}`;
}

function normalizeOptionalWebhook(value: string | undefined): string | undefined {
  const input = value?.trim();
  if (!input) return undefined;
  if (!/^https:\/\/hooks\.slack\.com\/services\//.test(input)) {
    throw new Error("Slack webhook URL must start with https://hooks.slack.com/services/");
  }
  return input;
}

function parseOptionalWebhook(value: string | undefined, res: Response): string | undefined {
  try {
    return normalizeOptionalWebhook(value);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : "Invalid Slack webhook URL.",
    });
    return undefined;
  }
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
    logger.info("Server", "  POST /api/slack/interactions — Slack approval callbacks");
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
