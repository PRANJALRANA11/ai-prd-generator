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

### 5. Start the bot

```bash
curl -X POST http://localhost:3000/api/start-bot \
  -H "Content-Type: application/json" \
  -d '{"meetUrl": "https://meet.google.com/xxx-yyyy-zzz"}'
```

## API Endpoints

| Method | Endpoint               | Description                    |
|--------|------------------------|--------------------------------|
| POST   | `/api/start-bot`       | Start the bot with a Meet URL  |
| POST   | `/api/stop-bot`        | Stop a running bot session     |
| POST   | `/api/slack/prd`       | Slack slash command for PRD Q&A and roadmap updates |
| GET    | `/api/status/:id`      | Check bot session status       |
| GET    | `/health`              | Health check                   |

### POST /api/start-bot

```json
{ "meetUrl": "https://meet.google.com/xxx-yyyy-zzz" }
```

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

Questions are answered from the latest completed PRD, transcript, and roadmap context. Roadmap updates rewrite the stored PRD, create a new PRD version, and repost the refreshed PRD using `SLACK_WEBHOOK_URL`.

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
- The bot uses a simple generated fake-camera background when `assets/bot-background.y4m` exists. Run `npm run generate-bot-background` to recreate it.
- Incoming webhooks only post messages. Slack questions and roadmap updates require configuring the `/api/slack/prd` slash command endpoint.
- Google Meet's WebRTC internals may change; if audio capture breaks, the recorder hook in `meetBot.ts` may need updating.

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Browser Automation**: Playwright
- **Speech-to-Text**: Deepgram Nova-3 with utterances and diarization
- **LLM**: Google Gemini (gemini-2.5-flash)
- **Database**: PostgreSQL
- **Messaging**: Slack incoming webhooks and slash commands
- **Server**: Express
