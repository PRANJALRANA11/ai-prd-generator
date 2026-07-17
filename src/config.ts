import "dotenv/config";

export interface AppConfig {
  geminiApiKey: string;
  deepgramApiKey: string;
  databaseUrl: string;
  slackWebhookUrl: string;
  slackInviteUrl?: string;
  slackSlashCommandToken?: string;
  slackSigningSecret?: string;
  linearApiKey?: string;
  linearTeamId?: string;
  linearProjectId?: string;
  linearAssigneeId?: string;
  linearLabelIds: string[];
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
    geminiApiKey: requireEnv("GEMINI_API_KEY"),
    deepgramApiKey: requireEnv("DEEPGRAM_API_KEY"),
    databaseUrl: requireEnv("DATABASE_URL"),
    slackWebhookUrl: requireEnv("SLACK_WEBHOOK_URL"),
    slackInviteUrl: process.env.SLACK_INVITE_URL,
    slackSlashCommandToken: process.env.SLACK_SLASH_COMMAND_TOKEN,
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
    linearApiKey: process.env.LINEAR_API_KEY,
    linearTeamId: process.env.LINEAR_TEAM_ID,
    linearProjectId: process.env.LINEAR_PROJECT_ID,
    linearAssigneeId: process.env.LINEAR_ASSIGNEE_ID,
    linearLabelIds: parseCsvEnv(process.env.LINEAR_LABEL_IDS),
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

function parseCsvEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
