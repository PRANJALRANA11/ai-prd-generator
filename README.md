# AI PRD Generator Bot

A Node.js/TypeScript backend service that joins **Google Meet** calls via **Playwright**, records meeting audio, transcribes speaker turns with **Deepgram**, generates a **Product Requirements Document (PRD)** using **Google Gemini**, and posts it to a **Slack** channel.

## Architecture

```
HTTP POST /api/start-bot
    │
    ▼
┌──────────────┐     ┌──────────┐     ┌────────────────┐     ┌───────────┐
│  Playwright  │────▶│ Deepgram │────▶│  Google Gemini  │────▶│   Slack   │
│  (Meet Bot)  │     │  (STT)   │     │   (PRD Gen)    │     │  (Post)   │
└──────────────┘     └──────────┘     └────────────────┘     └───────────┘
  Join + record       Audio → text     Transcript → PRD       PRD → Channel
```

## Prerequisites

- **Node.js** ≥ 18
- A **dedicated Google account** for the bot (don't use your personal account)
- A **Google Gemini API key** ([Get one here](https://aistudio.google.com/app/apikey))
- A **Deepgram API key** ([Get one here](https://console.deepgram.com/))
- A **PostgreSQL database** for stateful sessions, transcripts, PRDs, and roadmap updates
- A **Slack Incoming Webhook URL** ([Create an incoming webhook](https://api.slack.com/messaging/webhooks))

## Quick Start

### 1. Install

```bash
npm install
npx playwright install chromium
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your API keys
```

Create a local PostgreSQL database and set `DATABASE_URL`:

```bash
createdb ai_prd_generator
```

The app creates the required `bot_sessions` and `prd_versions` tables on startup.

### 3. Authenticate with Google (one-time)

```bash
npm run auth-setup
```

This opens a browser window. Log into the dedicated Google account, navigate to [meet.google.com](https://meet.google.com) to confirm access, then press `Ctrl+C` in the terminal. The session is saved to `auth-state.json`.

### 4. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to add the bot to a Meet
call and choose the Slack channel webhook for that session.

### 5. Start the bot from the API

```bash
curl -X POST http://localhost:3000/api/start-bot \
  -H "Content-Type: application/json" \
  -d '{"meetUrl": "https://meet.google.com/xxx-yyyy-zzz", "slackWebhookUrl": "https://hooks.slack.com/services/..."}'
```

## API Endpoints

| Method | Endpoint               | Description                    |
|--------|------------------------|--------------------------------|
| POST   | `/api/start-bot`       | Start the bot with a Meet URL  |
| POST   | `/api/slack/test`      | Send a test message to a Slack incoming webhook |
| POST   | `/api/stop-bot`        | Stop a running bot session     |
| POST   | `/api/slack/prd`       | Slack slash command for PRD Q&A and roadmap updates |
| GET    | `/api/config`          | Frontend config and setup status |
| GET    | `/api/status/:id`      | Check bot session status       |
| GET    | `/health`              | Health check                   |

### POST /api/start-bot

```json
{
  "meetUrl": "https://meet.google.com/xxx-yyyy-zzz",
  "slackWebhookUrl": "https://hooks.slack.com/services/..."
}
```

`meetUrl` may also be a meeting code such as `xxx-yyyy-zzz`. `slackWebhookUrl`
is optional; when omitted, the app uses `SLACK_WEBHOOK_URL`.
**Response (202):**
```json
{
  "sessionId": "abc-123-...",
  "message": "Bot is joining the meeting..."
}
```

### POST /api/stop-bot

```json
{ "sessionId": "abc-123-..." }
```

### GET /api/status/:sessionId

**Response:**
```json
{
  "sessionId": "abc-123-...",
  "status": "in-meeting",
  "meetUrl": "https://meet.google.com/xxx-yyyy-zzz",
  "startedAt": "2025-01-01T00:00:00Z",
  "endedAt": null,
  "transcriptSegments": 42,
  "error": null
}
```

### Slack PRD Command

Configure a Slack slash command such as `/prd` with this request URL:

```text
https://your-public-server.example.com/api/slack/prd
```

If your tunnel logs show `POST / 404 Not Found`, the Slack Request URL is missing
the `/api/slack/prd` path. `POST /` is also accepted as a compatibility fallback,
but the explicit path above is recommended.

Examples:

```text
/prd What are the MVP requirements?
/prd roadmap Q3 beta, Q4 launch, Q1 admin analytics
/prd history
/prd show v2
/prd diff v1 v2
/prd <sessionId> What are the main risks?
```

Questions are answered from the latest completed PRD, transcript, and roadmap context. Roadmap updates rewrite the stored PRD, create a new PRD version, and repost the refreshed PRD using the session Slack webhook, or `SLACK_WEBHOOK_URL` when no session webhook was provided.

Additional Slack workflow features:

- `history` lists all PRD versions for the current or targeted session.
- `show vN` reposts a specific PRD version in the formatted Slack layout.
- `diff vA vB` summarizes product, scope, roadmap, and risk changes between two versions.

## Important Notes

- The meeting host must **admit the bot** from the waiting room.
- Meeting audio is recorded to `recordings/<sessionId>.webm` and sent to Deepgram after the call ends. The `recordings/` directory is ignored by Git.
- Session status, transcripts, generated PRDs, roadmap updates, and PRD version history are stored in PostgreSQL so Slack Q&A works after app restarts.
- PRDs are posted as Slack Block Kit sections with metadata, command hints, and section-level formatting rather than a raw Markdown dump.
- Deepgram diarization labels speakers as `Speaker 0`, `Speaker 1`, etc. Raw mixed meeting audio does not include Google Meet participant names.
- The bot keeps camera off in Meet so it appears as a named participant rather than a video/background tile.
- The bot keeps its microphone muted and captures remote meeting audio for transcription.
- Incoming webhooks only post messages. Slack questions and roadmap updates require configuring the `/api/slack/prd` slash command endpoint.
- Google Meet's WebRTC internals may change; if audio capture breaks, the recorder hook in `meetBot.ts` may need updating.

## Production Deployment

Deploy the full app as a long-running Docker web service with PostgreSQL. The
Meet bot controls a Playwright Chromium browser for the duration of a call, so
serverless platforms with short function lifetimes are not a good fit for the
complete bot workflow.

This repo includes:

- `Dockerfile` for the Playwright runtime and Node.js app.
- `render.yaml` for a Render web service plus Render Postgres.
- `.dockerignore` to keep local secrets, recordings, and build output out of the Docker context.

### 1. Prepare Google auth

Run this locally with the dedicated bot Google account:

```bash
npm run auth-setup
```

Do not commit `auth-state.json`. Upload it to Render as a secret file at:

```text
/etc/secrets/auth-state.json
```

### 2. Configure Render

Create a Render Blueprint from this repo, or create a Docker Web Service and
Postgres database manually. Use these production environment variables:

```text
GEMINI_API_KEY=...
DEEPGRAM_API_KEY=...
DATABASE_URL=...
SLACK_WEBHOOK_URL=...
BOT_DISPLAY_NAME=AI Notetaker
AUTH_STATE_PATH=/etc/secrets/auth-state.json
PLAYWRIGHT_HEADLESS=true
```

Optional:

```text
SLACK_SLASH_COMMAND_TOKEN=...
```

### 3. Verify

After deploy, check:

```text
https://your-render-service.onrender.com/health
```

Expected response:

```json
{ "status": "ok" }
```

Use this URL for the Slack slash command:

```text
https://your-render-service.onrender.com/api/slack/prd
```

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Browser Automation**: Playwright
- **Speech-to-Text**: Deepgram Nova-3 with utterances and diarization
- **LLM**: Google Gemini (gemini-2.5-flash)
- **Database**: PostgreSQL
- **Messaging**: Slack incoming webhooks and slash commands
- **Server**: Express
