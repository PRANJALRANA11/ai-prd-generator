# AI PRD Generator Bot

A Node.js/TypeScript backend service that joins **Google Meet** calls via **Playwright**, captures live captions, generates a **Product Requirements Document (PRD)** using **Google Gemini**, and posts it to a **Slack** channel.

## Architecture

```
HTTP POST /api/start-bot
    │
    ▼
┌──────────────┐     ┌────────────────┐     ┌───────────┐
│  Playwright  │────▶│  Google Gemini  │────▶│   Slack   │
│  (Meet Bot)  │     │  (PRD Gen)     │     │  (Post)   │
└──────────────┘     └────────────────┘     └───────────┘
  Join meeting        Transcript → PRD       PRD → Channel
  Scrape captions
```

## Prerequisites

- **Node.js** ≥ 18
- A **dedicated Google account** for the bot (don't use your personal account)
- A **Google Gemini API key** ([Get one here](https://aistudio.google.com/app/apikey))
- A **Slack Bot Token** with `chat:write` scope ([Create a Slack App](https://api.slack.com/apps))

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

## Important Notes

- The meeting host must **admit the bot** from the waiting room.
- **Captions must be enabled** in the meeting for the bot to capture text.
- The bot uses a simple generated fake-camera background when `assets/bot-background.y4m` exists. Run `npm run generate-bot-background` to recreate it.
- Google Meet's DOM structure may change — if caption scraping breaks, selectors in `meetBot.ts` may need updating.

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Browser Automation**: Playwright
- **LLM**: Google Gemini (gemini-2.5-flash)
- **Messaging**: Slack Web API
- **Server**: Express
