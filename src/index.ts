import express, { type Request, type Response } from "express";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, readdir, stat } from "fs/promises";
import { fileURLToPath } from "url";
import type { IncomingMessage, ServerResponse } from "http";
import { loadConfig } from "./config.js";
import { logger } from "./utils/logger.js";
import { startMeetBot, requestStop, type BotSession } from "./services/meetBot.js";
import { answerPRDQuestion, comparePRDVersions, generateLinearTicketSpecs, generatePRD, updatePRDWithRoadmap } from "./services/llmService.js";
import { closeLinearIssue, createLinearIssues, type LinearIssue } from "./services/linearService.js";
import {
  closeGitHubIssue,
  createGitHubIssue,
  createGitHubIssueComment,
  createGitHubPullRequest,
  getGitHubPullRequest,
  mergeGitHubPullRequest,
  parseGitHubRepo,
  type GitHubConfig,
} from "./services/githubService.js";
import {
  runCodingAgentTask,
  type CodingAgentConfig,
} from "./services/codingAgentService.js";
import { buildVersionHistoryText, postPRDToSlack, postSlackWebhook, type SlackWebhookPayload } from "./services/slackService.js";
import type { CodingAutomationRecord, LinearIssueRecord } from "./services/sessionStore.js";
import { PostgresSessionStore } from "./services/sessionStore.js";
import { appendSessionLog, getSessionLogs, subscribeToSessionLogs } from "./services/liveLogService.js";

// ── Load configuration ────────────────────────────────────
const config = loadConfig();

// ── Stateful session store ────────────────────────────────
const sessionStore = new PostgresSessionStore(config.databaseUrl);
const execFileAsync = promisify(execFile);

// Active browser sessions must stay in memory because Browser/Page handles are
// process-local. Durable session state is stored in PostgreSQL.
const activeSessions = new Map<string, BotSession>();
let codingAgentWorkerRunning = false;

// ── Express app ───────────────────────────────────────────
const app = express();
app.use(express.json({ verify: captureRawBody }));
app.use(express.urlencoded({ extended: false, verify: captureRawBody }));

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
app.use(express.static(publicDir));

app.get("/codex-live", (_req, res) => {
  res.sendFile(path.join(publicDir, "codex-live.html"));
});

// ── Health check ──────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.get("/api/config", (_req, res) => {
  res.json({
    slackWebhookConfigured: Boolean(config.slackWebhookUrl),
    publicBaseUrl: config.publicBaseUrl,
    slackInviteUrl: config.slackInviteUrl,
    slashCommandPath: "/api/slack/prd",
    slackInteractionPath: "/api/slack/interactions",
    linearConfigured: Boolean(config.linearApiKey && config.linearTeamId),
    githubAutomationConfigured: Boolean(config.githubToken && config.githubRepo),
    codingAgentEnabled: config.codingAgentEnabled,
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

app.get("/api/coding/tasks", async (_req, res) => {
  const tasks = await sessionStore.listRecentCodingAutomationTasks(30);
  res.json({
    enabled: config.codingAgentEnabled,
    repo: config.githubRepo,
    workdir: config.codingAgentWorkdir,
    tasks: tasks.map(publicCodingTask),
  });
});

app.get("/api/coding/tasks/:id", async (req, res) => {
  const task = await sessionStore.getCodingAutomationTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: "Coding task not found." });
    return;
  }

  const snapshot = await buildCodingTaskSnapshot(task);
  res.json(snapshot);
});

app.get("/api/coding/tasks/:id/file", async (req, res) => {
  const task = await sessionStore.getCodingAutomationTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: "Coding task not found." });
    return;
  }

  const requestedPath = typeof req.query.path === "string" ? req.query.path : "";
  const taskDir = getCodingTaskDir(task.id);
  const filePath = safeJoinInside(taskDir, requestedPath);
  if (!filePath) {
    res.status(400).json({ error: "Invalid file path." });
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      res.status(400).json({ error: "Path is not a file." });
      return;
    }
    if (fileStat.size > 300_000) {
      res.status(413).json({ error: "File is too large for live preview." });
      return;
    }

    const buffer = await readFile(filePath);
    if (buffer.includes(0)) {
      res.status(415).json({ error: "Binary file preview is not supported." });
      return;
    }

    res.json({
      path: requestedPath,
      content: buffer.toString("utf8"),
      size: fileStat.size,
      updatedAt: fileStat.mtime.toISOString(),
    });
  } catch (err) {
    res.status(404).json({
      error: err instanceof Error ? err.message : "File not found.",
    });
  }
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
  if (!action?.action_id || !action.value) {
    res.status(200).json({
      response_type: "ephemeral",
      text: "Unsupported PRD action.",
    });
    return;
  }

  if (action.action_id === "approve_linear_tickets") {
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
    return;
  }

  if (action.action_id === "merge_github_pr") {
    res.status(200).json({
      response_type: "ephemeral",
      text: "Merging the linked GitHub PR and closing the task...",
    });

    handleGitHubPRMergeApproval(action.value, payload).catch((err) => {
      logger.error("SlackInteraction", "Failed to handle GitHub PR merge approval", {
        automationId: action.value,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return;
  }

  res.status(200).json({
    response_type: "ephemeral",
    text: "Unsupported PRD action.",
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
    const automationTasks = await createCodingAutomationTasksForIssues(session, savedIssues);
    await sessionStore.markLinearIssueBatch(session.id, "created", {
      approvedBy,
      approvedAt: new Date(),
    });

    await postSlackInteractionResponse(responseUrl, buildLinearIssueMessage(
      session.id,
      savedIssues,
      [
        approvedBy ? `${approvedBy} approved the PRD.` : undefined,
        `Created ${savedIssues.length} Linear ticket${savedIssues.length === 1 ? "" : "s"}.`,
        automationTasks.length > 0
          ? `Mirrored ${automationTasks.filter((task) => task.githubIssueUrl).length} GitHub issue${automationTasks.length === 1 ? "" : "s"} for Codex.`
          : undefined,
      ].filter(Boolean).join(" "),
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

async function createCodingAutomationTasksForIssues(
  session: BotSession,
  issues: LinearIssueRecord[],
): Promise<CodingAutomationRecord[]> {
  const githubConfig = getGitHubConfig();
  const tasks: CodingAutomationRecord[] = [];

  for (const issue of issues) {
    let task = await sessionStore.createCodingAutomationTask(session.id, issue, {
      prdItem: issue.title,
    });

    if (!githubConfig || task.githubIssueNumber) {
      tasks.push(task);
      continue;
    }

    try {
      const githubIssue = await createGitHubIssue(githubConfig, {
        title: `${issue.identifier ? `${issue.identifier}: ` : ""}${issue.title}`,
        body: buildGitHubIssueBody(session, issue),
        labels: buildGitHubLabels(issue),
      });

      task = await sessionStore.updateCodingAutomationTask(task.id, "github_issue_created", {
        githubIssueNumber: githubIssue.number,
        githubIssueUrl: githubIssue.htmlUrl,
      });
      tasks.push(task);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("GitHubAutomation", "Failed to mirror Linear ticket to GitHub", {
        sessionId: session.id,
        linearId: issue.linearId,
        error: message,
      });
      task = await sessionStore.updateCodingAutomationTask(task.id, "error", { error: message });
      tasks.push(task);
    }
  }

  return tasks;
}

async function handleGitHubPRMergeApproval(
  automationId: string,
  payload: SlackInteractionPayload,
): Promise<void> {
  const responseUrl = payload.response_url;
  const approvedBy = formatSlackUser(payload);

  try {
    const task = await sessionStore.getCodingAutomationTask(automationId);
    if (!task?.githubPrNumber) {
      await postSlackInteractionResponse(responseUrl, {
        response_type: "ephemeral",
        text: "No linked GitHub PR was found for that automation task.",
      });
      return;
    }

    const githubConfig = getGitHubConfig();
    if (!githubConfig) {
      await postSlackInteractionResponse(responseUrl, {
        response_type: "ephemeral",
        text: "GitHub automation is not configured. Set GITHUB_TOKEN and GITHUB_REPO.",
      });
      return;
    }

    await mergeGitHubPullRequest(
      githubConfig,
      task.githubPrNumber,
      `Merge ${task.linearIdentifier ?? task.linearTitle}`,
    );

    const closedTask = await closeCompletedAutomationTask(task.id, approvedBy, {
      postToSlack: false,
    });
    await postSlackInteractionResponse(responseUrl, buildAutomationCompleteMessage(closedTask, approvedBy));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sessionStore.updateCodingAutomationTask(automationId, "error", { error: message }).catch(() => undefined);
    await postSlackInteractionResponse(responseUrl, {
      response_type: "ephemeral",
      text: `Could not merge the linked PR: ${message}`,
    });
  }
}

async function processCodingAutomationQueue(): Promise<void> {
  if (codingAgentWorkerRunning || !config.codingAgentEnabled) return;
  codingAgentWorkerRunning = true;

  try {
    await mirrorPendingGitHubIssues();
    await processReadyCodingTasks();
    await syncMergedPullRequests();
  } finally {
    codingAgentWorkerRunning = false;
  }
}

async function mirrorPendingGitHubIssues(): Promise<void> {
  const githubConfig = getGitHubConfig();
  if (!githubConfig) return;

  const tasks = await sessionStore.listCodingAutomationTasks(["pending_github_issue"], 10);
  for (const task of tasks) {
    const session = await sessionStore.getSession(task.sessionId);
    if (!session) continue;

    try {
      const githubIssue = await createGitHubIssue(githubConfig, {
        title: `${task.linearIdentifier ? `${task.linearIdentifier}: ` : ""}${task.linearTitle}`,
        body: buildGitHubIssueBody(session, task),
        labels: buildGitHubLabels(task),
      });
      await sessionStore.updateCodingAutomationTask(task.id, "github_issue_created", {
        githubIssueNumber: githubIssue.number,
        githubIssueUrl: githubIssue.htmlUrl,
      });
    } catch (err) {
      await sessionStore.updateCodingAutomationTask(task.id, "error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function processReadyCodingTasks(): Promise<void> {
  const codingConfig = getCodingAgentConfig();
  const githubConfig = getGitHubConfig();
  if (!codingConfig || !githubConfig) return;

  const tasks = await sessionStore.listCodingAutomationTasks(["github_issue_created"], 1);
  for (const task of tasks) {
    if (!task.githubIssueNumber || !task.githubIssueUrl) continue;

    try {
      await sessionStore.updateCodingAutomationTask(task.id, "codex_running", { error: "" });
      const result = await runCodingAgentTask(codingConfig, {
        automationId: task.id,
        sessionId: task.sessionId,
        prdItem: task.prdItem ?? task.linearTitle,
        linearIdentifier: task.linearIdentifier,
        linearUrl: task.linearUrl,
        githubIssueNumber: task.githubIssueNumber,
        githubIssueUrl: task.githubIssueUrl,
        title: task.linearTitle,
        description: buildCodingAgentDescription(task),
      });

      const pullRequest = await createGitHubPullRequest(githubConfig, {
        title: `${task.linearIdentifier ? `${task.linearIdentifier}: ` : ""}${task.linearTitle}`,
        body: buildPullRequestBody(task, result),
        head: result.branchName,
        base: config.codingAgentBaseBranch,
      });

      const updated = await sessionStore.updateCodingAutomationTask(task.id, "pr_open", {
        githubPrNumber: pullRequest.number,
        githubPrUrl: pullRequest.htmlUrl,
        branchName: result.branchName,
        codexSummary: result.changeSummary,
      });

      await createGitHubIssueComment(
        githubConfig,
        task.githubIssueNumber,
        `Codex opened PR #${pullRequest.number}: ${pullRequest.htmlUrl}`,
      );
      await postSlackPRReview(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("CodingAgent", "Failed to complete coding automation task", {
        automationId: task.id,
        linearId: task.linearId,
        error: message,
      });
      await sessionStore.updateCodingAutomationTask(task.id, "error", { error: message });
      await postSlackAutomationError(task, message);
    }
  }
}

async function syncMergedPullRequests(): Promise<void> {
  const githubConfig = getGitHubConfig();
  if (!githubConfig) return;

  const tasks = await sessionStore.listCodingAutomationTasks(["pr_open"], 10);
  for (const task of tasks) {
    if (!task.githubPrNumber) continue;
    const pullRequest = await getGitHubPullRequest(githubConfig, task.githubPrNumber);
    if (pullRequest.merged) {
      await closeCompletedAutomationTask(task.id, "GitHub merge sync");
    }
  }
}

async function closeCompletedAutomationTask(
  automationId: string,
  approvedBy?: string,
  options: {
    postToSlack?: boolean;
  } = {},
): Promise<CodingAutomationRecord> {
  const task = await sessionStore.getCodingAutomationTask(automationId);
  if (!task) {
    throw new Error(`Automation task not found: ${automationId}`);
  }

  const githubConfig = getGitHubConfig();
  if (githubConfig && task.githubIssueNumber) {
    await closeGitHubIssue(
      githubConfig,
      task.githubIssueNumber,
      `Completed by ${task.githubPrUrl ?? "the linked pull request"}.`,
    );
  }

  if (config.linearApiKey && (config.linearDoneStateId || config.linearTeamId)) {
    try {
      await closeLinearIssue(
        {
          apiKey: config.linearApiKey,
          doneStateId: config.linearDoneStateId,
          teamId: config.linearTeamId,
        },
        task.linearId,
      );
    } catch (err) {
      logger.error("LinearAutomation", "Failed to close linked Linear ticket after PR merge", {
        automationId,
        linearId: task.linearId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const closedTask = await sessionStore.updateCodingAutomationTask(automationId, "closed", {
    approvedBy,
    mergedAt: new Date(),
  });
  if (options.postToSlack ?? true) {
    await postSlackAutomationComplete(closedTask, approvedBy);
  }
  return closedTask;
}

function publicCodingTask(task: CodingAutomationRecord): Record<string, unknown> {
  return {
    id: task.id,
    sessionId: task.sessionId,
    linearIdentifier: task.linearIdentifier,
    linearTitle: task.linearTitle,
    linearUrl: task.linearUrl,
    githubIssueNumber: task.githubIssueNumber,
    githubIssueUrl: task.githubIssueUrl,
    githubPrNumber: task.githubPrNumber,
    githubPrUrl: task.githubPrUrl,
    branchName: task.branchName,
    prdItem: task.prdItem,
    status: task.status,
    error: task.error,
    updatedAt: task.updatedAt,
  };
}

async function buildCodingTaskSnapshot(task: CodingAutomationRecord): Promise<Record<string, unknown>> {
  const taskDir = getCodingTaskDir(task.id);
  const [files, gitStatus, gitDiff, codexLog] = await Promise.all([
    listCodingTaskFiles(taskDir).catch(() => []),
    runGitForSnapshot(taskDir, ["status", "--short"]).catch((err: unknown) => formatSnapshotError(err)),
    runGitForSnapshot(taskDir, ["diff", "--", "."]).catch((err: unknown) => formatSnapshotError(err)),
    readTail(path.join(taskDir, "codex-run.log"), 40_000).catch(() => ""),
  ]);

  const statusPaths = new Set(
    gitStatus
      .split(/\r?\n/)
      .map((line) => line.slice(3).trim())
      .filter(Boolean),
  );

  const annotatedFiles = files.map((file) => ({
    ...file,
    changed: statusPaths.has(file.path),
  }));

  const activeFile = annotatedFiles
    .filter((file) => !file.path.endsWith(".log") && file.path !== ".codex-task.md")
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];

  return {
    task: publicCodingTask(task),
    running: task.status === "codex_running",
    taskDir,
    activeFile: activeFile?.path,
    files: annotatedFiles.slice(0, 300),
    gitStatus,
    gitDiff: trimForApi(gitDiff, 60_000),
    codexLog: trimForApi(codexLog, 60_000),
  };
}

function getCodingTaskDir(taskId: string): string {
  return path.resolve(config.codingAgentWorkdir, taskId);
}

function safeJoinInside(root: string, relativePath: string): string | null {
  const cleanRelativePath = relativePath.replace(/^\/+/, "");
  const resolved = path.resolve(root, cleanRelativePath);
  const normalizedRoot = path.resolve(root);
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    return null;
  }
  return resolved;
}

async function listCodingTaskFiles(root: string): Promise<Array<{
  path: string;
  size: number;
  mtimeMs: number;
}>> {
  const ignored = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".turbo"]);
  const output: Array<{ path: string; size: number; mtimeMs: number }> = [];

  async function walk(dir: string, relativeDir = ""): Promise<void> {
    if (output.length >= 500) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const relativePath = path.posix.join(relativeDir.split(path.sep).join(path.posix.sep), entry.name);
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        const fileStat = await stat(absolutePath);
        output.push({
          path: relativePath,
          size: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
        });
      }
    }
  }

  await walk(root);
  return output.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function runGitForSnapshot(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 1024 * 1024 * 4,
  });
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

async function readTail(filePath: string, maxChars: number): Promise<string> {
  const content = await readFile(filePath, "utf8");
  if (content.length <= maxChars) return content;
  return content.slice(content.length - maxChars);
}

function formatSnapshotError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function trimForApi(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 20)}\n...truncated...`;
}

function getGitHubConfig(): GitHubConfig | null {
  if (!config.githubToken || !config.githubRepo) return null;
  try {
    return {
      token: config.githubToken,
      repo: parseGitHubRepo(config.githubRepo),
    };
  } catch (err) {
    logger.error("GitHubAutomation", "Invalid GitHub automation config", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function getCodingAgentConfig(): CodingAgentConfig | null {
  const githubConfig = getGitHubConfig();
  if (!githubConfig || !config.codingAgentEnabled) return null;

  return {
    githubToken: config.githubToken!,
    githubRepo: githubConfig.repo,
    githubUsername: config.githubUsername,
    workdir: config.codingAgentWorkdir,
    baseBranch: config.codingAgentBaseBranch,
    command: config.codingAgentCommand,
    timeoutMs: config.codingAgentTimeoutMs,
  };
}

function buildGitHubIssueBody(
  session: BotSession,
  issue: LinearIssueRecord | CodingAutomationRecord,
): string {
  const title = getLinearRecordTitle(issue);
  const identifier = getLinearRecordIdentifier(issue);
  const linearUrl = getLinearRecordUrl(issue);

  return [
    `## Source`,
    `- PRD session: \`${session.id}\``,
    `- PRD item: ${title}`,
    identifier ? `- Linear ticket: ${linearUrl ? `[${identifier}](${linearUrl})` : identifier}` : undefined,
    `- Meeting: ${session.meetUrl}`,
    "",
    "## Agent Handoff",
    "Codex should implement this issue, open a pull request, and wait for Slack review before merge.",
    "",
    "## PRD Context",
    truncateForSlack(session.prd ?? "No PRD content available.", 4000),
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function buildGitHubLabels(issue: LinearIssueRecord | CodingAutomationRecord): string[] {
  const identifier = getLinearRecordIdentifier(issue);
  return Array.from(new Set([
    ...config.githubIssueLabels,
    "linear",
    identifier ? normalizeGitHubLabel(`linear-${identifier}`) : undefined,
  ].filter(Boolean) as string[]));
}

function getLinearRecordTitle(issue: LinearIssueRecord | CodingAutomationRecord): string {
  return "linearTitle" in issue ? issue.linearTitle : issue.title;
}

function getLinearRecordIdentifier(issue: LinearIssueRecord | CodingAutomationRecord): string | undefined {
  return "linearTitle" in issue ? issue.linearIdentifier : issue.identifier;
}

function getLinearRecordUrl(issue: LinearIssueRecord | CodingAutomationRecord): string | undefined {
  return "linearTitle" in issue ? issue.linearUrl : issue.url;
}

function normalizeGitHubLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 45);
}

function buildCodingAgentDescription(task: CodingAutomationRecord): string {
  return [
    task.prdItem ?? task.linearTitle,
    "",
    task.linearUrl ? `Linear: ${task.linearUrl}` : undefined,
    task.githubIssueUrl ? `GitHub issue: ${task.githubIssueUrl}` : undefined,
    "",
    "Create production-quality changes, include tests when relevant, and leave the PR ready for review.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildPullRequestBody(
  task: CodingAutomationRecord,
  result: {
    branchName: string;
    commitSha: string;
    changeSummary: string;
  },
): string {
  return [
    `## Linked Work`,
    task.linearIdentifier
      ? `- Linear: ${task.linearUrl ? `[${task.linearIdentifier}](${task.linearUrl})` : task.linearIdentifier}`
      : undefined,
    task.githubIssueNumber
      ? `- GitHub issue: #${task.githubIssueNumber}`
      : undefined,
    `- PRD session: \`${task.sessionId}\``,
    `- PRD item: ${task.prdItem ?? task.linearTitle}`,
    "",
    "## Codex Result",
    "```text",
    truncateForSlack(result.changeSummary || "No change summary returned.", 5000),
    "```",
    "",
    `Commit: \`${result.commitSha}\``,
    `Branch: \`${result.branchName}\``,
  ]
    .filter(Boolean)
    .join("\n");
}

async function postSlackPRReview(task: CodingAutomationRecord): Promise<void> {
  const session = await sessionStore.getSession(task.sessionId);
  const webhookUrl = session ? getSessionSlackWebhook(session) : config.slackWebhookUrl;
  await postSlackWebhook(webhookUrl, buildSlackPRReviewMessage(task));
}

function buildSlackPRReviewMessage(task: CodingAutomationRecord): SlackWebhookPayload {
  const fields: Array<Record<string, string>> = [
    {
      type: "mrkdwn",
      text: `*Linear*\n${task.linearUrl ? `<${task.linearUrl}|${task.linearIdentifier ?? task.linearTitle}>` : task.linearIdentifier ?? task.linearTitle}`,
    },
    {
      type: "mrkdwn",
      text: `*GitHub Issue*\n${task.githubIssueUrl ? `<${task.githubIssueUrl}|#${task.githubIssueNumber}>` : "Pending"}`,
    },
    {
      type: "mrkdwn",
      text: `*Pull Request*\n${task.githubPrUrl ? `<${task.githubPrUrl}|#${task.githubPrNumber}>` : "Pending"}`,
    },
    {
      type: "mrkdwn",
      text: `*PRD Item*\n${truncateForSlack(task.prdItem ?? task.linearTitle, 160)}`,
    },
  ];

  return {
    text: `Codex opened PR ${task.githubPrUrl ?? ""}`,
    response_type: "in_channel",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "Codex PR Ready",
          emoji: true,
        },
      },
      {
        type: "section",
        fields,
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Code changes*\n\`\`\`\n${truncateForSlack(task.codexSummary ?? "No summary captured.", 1800)}\n\`\`\``,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "open_codex_live_task",
            url: buildCodexLiveUrl({ taskId: task.id }),
            text: {
              type: "plain_text",
              text: "Watch Live Codex",
              emoji: true,
            },
          },
          {
            type: "button",
            action_id: "merge_github_pr",
            style: "primary",
            text: {
              type: "plain_text",
              text: "Merge PR",
              emoji: true,
            },
            value: task.id,
            confirm: {
              title: {
                type: "plain_text",
                text: "Merge this PR?",
              },
              text: {
                type: "mrkdwn",
                text: "This will squash-merge the linked GitHub PR, close the GitHub issue, close the linked Linear ticket, and post a final summary.",
              },
              confirm: {
                type: "plain_text",
                text: "Merge",
              },
              deny: {
                type: "plain_text",
                text: "Cancel",
              },
            },
          },
        ],
      },
    ],
  };
}

async function postSlackAutomationError(task: CodingAutomationRecord, message: string): Promise<void> {
  const session = await sessionStore.getSession(task.sessionId);
  const webhookUrl = session ? getSessionSlackWebhook(session) : config.slackWebhookUrl;
  await postSlackWebhook(webhookUrl, {
    text: `Coding automation failed for ${task.linearIdentifier ?? task.linearTitle}: ${message}`,
    response_type: "in_channel",
  });
}

async function postSlackAutomationComplete(
  task: CodingAutomationRecord,
  approvedBy?: string,
): Promise<void> {
  const session = await sessionStore.getSession(task.sessionId);
  const webhookUrl = session ? getSessionSlackWebhook(session) : config.slackWebhookUrl;
  await postSlackWebhook(webhookUrl, buildAutomationCompleteMessage(task, approvedBy));
}

function buildAutomationCompleteMessage(
  task: CodingAutomationRecord,
  approvedBy?: string,
): SlackWebhookPayload {
  const linearLabel = task.linearIdentifier ?? task.linearTitle;
  return {
    response_type: "in_channel",
    text: `Merged ${task.githubPrUrl ?? "the linked PR"} and closed ${linearLabel}.`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "PR Merged and Task Closed",
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            approvedBy ? `*Approved by:* ${approvedBy}` : undefined,
            `*Linear:* ${task.linearUrl ? `<${task.linearUrl}|${linearLabel}>` : linearLabel}`,
            `*GitHub issue:* ${task.githubIssueUrl ? `<${task.githubIssueUrl}|#${task.githubIssueNumber}>` : "Closed"}`,
            `*Pull request:* ${task.githubPrUrl ? `<${task.githubPrUrl}|#${task.githubPrNumber}>` : "Merged"}`,
            `*PRD item:* ${task.prdItem ?? task.linearTitle}`,
          ].filter(Boolean).join("\n"),
        },
      },
    ],
  };
}

function truncateForSlack(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 20)}\n...truncated...`;
}

function buildCodexLiveUrl(options: { sessionId?: string; taskId?: string } = {}): string {
  const url = new URL("/codex-live", config.publicBaseUrl);
  if (options.sessionId) url.searchParams.set("session", options.sessionId);
  if (options.taskId) url.searchParams.set("task", options.taskId);
  return url.toString();
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
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "open_codex_live_session",
            url: buildCodexLiveUrl({ sessionId }),
            text: {
              type: "plain_text",
              text: "Watch Live Codex",
              emoji: true,
            },
          },
        ],
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

  if (config.codingAgentEnabled) {
    logger.info("CodingAgent", "Starting coding automation worker", {
      pollMs: config.codingAgentPollMs,
      githubRepo: config.githubRepo,
      baseBranch: config.codingAgentBaseBranch,
    });
    setInterval(() => {
      processCodingAutomationQueue().catch((err) => {
        logger.error("CodingAgent", "Coding automation worker failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, config.codingAgentPollMs).unref();
    processCodingAutomationQueue().catch((err) => {
      logger.error("CodingAgent", "Initial coding automation worker run failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

startServer().catch((err) => {
  logger.error("Server", "Failed to start server", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
});
