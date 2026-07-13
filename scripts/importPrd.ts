import "dotenv/config";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { PostgresSessionStore } from "../src/services/sessionStore.js";
import { postPRDToSlack } from "../src/services/slackService.js";
import type { BotSession } from "../src/services/meetBot.js";

const prdFilePath = process.argv[2];

if (!prdFilePath) {
  throw new Error("Usage: npm run import-prd -- /absolute/path/to/prd.txt");
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("Missing DATABASE_URL.");
}

const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
if (!slackWebhookUrl) {
  throw new Error("Missing SLACK_WEBHOOK_URL.");
}

const rawPrd = fs.readFileSync(path.resolve(prdFilePath), "utf8");
const prd = cleanPastedPRD(rawPrd);
const now = new Date();
const session: BotSession = {
  id: uuidv4(),
  meetUrl: "manual-prd-import",
  status: "completed",
  transcript: [],
  prd,
  startedAt: now,
  endedAt: now,
  _stopRequested: false,
};

const store = new PostgresSessionStore(databaseUrl);

await store.init();
await store.upsertSession(session);
const version = await store.createPRDVersion(session, {
  changeSummary: "Imported pasted PRD",
});

await postPRDToSlack(slackWebhookUrl, prd, {
  sessionId: session.id,
  version: version.version,
  reason: "Imported pasted PRD",
});

await store.close();

console.log(`Imported and posted PRD session ${session.id} v${version.version}`);

function cleanPastedPRD(input: string): string {
  return input
    .split(/\r?\n/)
    .filter((line) => !/^New PRD Generated from Meeting\s*$/.test(line))
    .filter((line) => !/^Generated at:/i.test(line))
    .filter((line) => !/^\d{1,2}:\d{2}\s*$/.test(line))
    .map((line) => line.replace(/^(\s*)\*\s{2,}/, "$1- "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
