import "dotenv/config";
import fs from "fs";
import path from "path";

export interface AppConfig {
  geminiApiKey: string;
  deepgramApiKey: string;
  databaseUrl: string;
  slackWebhookUrl: string;
  slackSlashCommandToken?: string;
  botDisplayName: string;
  port: number;
  authStatePath: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  const authStatePath = process.env.AUTH_STATE_PATH ?? "./auth-state.json";
  writeAuthStateFromEnv(authStatePath);

  return {
    geminiApiKey: requireEnv("GEMINI_API_KEY"),
    deepgramApiKey: requireEnv("DEEPGRAM_API_KEY"),
    databaseUrl: requireEnv("DATABASE_URL"),
    slackWebhookUrl: requireEnv("SLACK_WEBHOOK_URL"),
    slackSlashCommandToken: process.env.SLACK_SLASH_COMMAND_TOKEN,
    botDisplayName: process.env.BOT_DISPLAY_NAME ?? "AI Notetaker",
    port: parseInt(process.env.PORT ?? "3000", 10),
    authStatePath,
  };
}

function writeAuthStateFromEnv(authStatePath: string): void {
  const encodedAuthState = process.env.AUTH_STATE_JSON_BASE64;
  if (!encodedAuthState || fs.existsSync(authStatePath)) return;

  const resolvedPath = path.resolve(authStatePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, Buffer.from(encodedAuthState, "base64").toString("utf8"), {
    mode: 0o600,
  });
}
