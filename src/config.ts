import "dotenv/config";

export interface AppConfig {
  openaiApiKey: string;
  deepgramApiKey: string;
  databaseUrl: string;
  slackWebhookUrl: string;
  publicBaseUrl: string;
  slackInviteUrl?: string;
  slackSlashCommandToken?: string;
  slackSigningSecret?: string;
  slackBotToken?: string;
  linearInviteUrl?: string;
  linearApiKey?: string;
  linearTeamId?: string;
  linearProjectId?: string;
  linearAssigneeId?: string;
  linearLabelIds: string[];
  linearDoneStateId?: string;
  githubToken?: string;
  githubRepo?: string;
  githubUsername?: string;
  githubIssueLabels: string[];
  codingAgentEnabled: boolean;
  codingAgentCommand?: string;
  codingAgentTimeoutMs: number;
  codingAgentWorkdir: string;
  codingAgentBaseBranch: string;
  codingAgentPollMs: number;
  botDisplayName: string;
  port: number;
  authStatePath: string;
  playwrightHeadless: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  return {
    openaiApiKey: requireEnv("OPENAI_API_KEY"),
    deepgramApiKey: requireEnv("DEEPGRAM_API_KEY"),
    databaseUrl: requireEnv("DATABASE_URL"),
    slackWebhookUrl: requireEnv("SLACK_WEBHOOK_URL"),
    publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? "3000"}`).replace(/\/+$/, ""),
    slackInviteUrl: process.env.SLACK_INVITE_URL,
    slackSlashCommandToken: process.env.SLACK_SLASH_COMMAND_TOKEN,
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    linearInviteUrl: process.env.LINEAR_INVITE_URL,
    linearApiKey: process.env.LINEAR_API_KEY,
    linearTeamId: process.env.LINEAR_TEAM_ID,
    linearProjectId: process.env.LINEAR_PROJECT_ID,
    linearAssigneeId: process.env.LINEAR_ASSIGNEE_ID,
    linearLabelIds: parseCsvEnv(process.env.LINEAR_LABEL_IDS),
    linearDoneStateId: process.env.LINEAR_DONE_STATE_ID,
    githubToken: process.env.GITHUB_TOKEN,
    githubRepo: process.env.GITHUB_REPO,
    githubUsername: process.env.GITHUB_USERNAME,
    githubIssueLabels: parseCsvEnv(process.env.GITHUB_ISSUE_LABELS, ["prd-generated", "codex-agent"]),
    codingAgentEnabled: parseBooleanEnv(process.env.CODING_AGENT_ENABLED, false),
    codingAgentCommand: process.env.CODING_AGENT_COMMAND,
    codingAgentTimeoutMs: parseInt(process.env.CODING_AGENT_TIMEOUT_MS ?? "1800000", 10),
    codingAgentWorkdir: process.env.CODING_AGENT_WORKDIR ?? "/tmp/ai-prd-coding-agent",
    codingAgentBaseBranch: process.env.CODING_AGENT_BASE_BRANCH ?? "master",
    codingAgentPollMs: parseInt(process.env.CODING_AGENT_POLL_MS ?? "30000", 10),
    botDisplayName: process.env.BOT_DISPLAY_NAME ?? "AI Notetaker",
    port: parseInt(process.env.PORT ?? "3000", 10),
    authStatePath: process.env.AUTH_STATE_PATH ?? "./auth-state.json",
    playwrightHeadless: parseBooleanEnv(process.env.PLAYWRIGHT_HEADLESS, false),
  };
}

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseCsvEnv(value: string | undefined, defaultValue: string[] = []): string[] {
  if (!value) return defaultValue;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
