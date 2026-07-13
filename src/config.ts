import "dotenv/config";

export interface AppConfig {
  geminiApiKey: string;
  slackBotToken: string;
  slackChannelId: string;
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
  return {
    geminiApiKey: requireEnv("GEMINI_API_KEY"),
    slackBotToken: requireEnv("SLACK_BOT_TOKEN"),
    slackChannelId: requireEnv("SLACK_CHANNEL_ID"),
    botDisplayName: process.env.BOT_DISPLAY_NAME ?? "AI Notetaker",
    port: parseInt(process.env.PORT ?? "3000", 10),
    authStatePath: process.env.AUTH_STATE_PATH ?? "./auth-state.json",
  };
}
