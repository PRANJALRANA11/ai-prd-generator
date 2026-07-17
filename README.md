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
- A **Slack Signing Secret** for slash commands and interactive approval buttons
- A **Linear API key** plus Linear team ID if you want approved PRDs to create Linear tickets

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
| GET    | `/codex-live`          | Live Codex coding-session dashboard |
| POST   | `/api/start-bot`       | Start the bot with a Meet URL  |
| POST   | `/api/stop-bot`        | Stop a running bot session     |
| POST   | `/api/slack/prd`       | Slack slash command for PRD Q&A and roadmap updates |
| POST   | `/api/slack/interactions` | Slack approval button callbacks for Linear ticket creation |
| GET    | `/api/config`          | Frontend config and setup status |
| GET    | `/api/coding/tasks`    | Recent Codex automation tasks |
| GET    | `/api/coding/tasks/:id` | Live Codex task snapshot |
| GET    | `/api/coding/tasks/:id/file` | Safe file preview for a Codex task |
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
- Each posted PRD includes an approval button. When approved, the app turns the PRD into coding-agent-ready Linear tickets and posts the ticket links back to Slack.

### Slack Linear Approval Setup

Incoming webhooks can post the PRD, but Slack buttons need an interactive
callback URL. In your Slack app:

1. Enable **Interactivity & Shortcuts**.
2. Set the Request URL to:

```text
https://your-public-server.example.com/api/slack/interactions
```

3. Copy the app **Signing Secret** into `SLACK_SIGNING_SECRET`.
4. Keep the slash command Request URL as:

```text
https://your-public-server.example.com/api/slack/prd
```

Configure Linear with:

```text
LINEAR_API_KEY=...
LINEAR_TEAM_ID=...
```

Optional Linear targeting:

```text
LINEAR_PROJECT_ID=...
LINEAR_ASSIGNEE_ID=...
LINEAR_LABEL_IDS=label_uuid_one,label_uuid_two
LINEAR_DONE_STATE_ID=...
```

`LINEAR_DONE_STATE_ID` is optional. If it is omitted, the app tries to close
merged work with a completed/done state from `LINEAR_TEAM_ID`.

The approval flow is idempotent per PRD session. If Slack retries an approval or
someone clicks again, the app returns the already-created Linear ticket links
instead of creating duplicates.

### GitHub + Codex automation

When GitHub automation is configured, every approved Linear ticket is mirrored
to a GitHub issue. If `CODING_AGENT_ENABLED=true`, a background worker picks up
those issues, creates a branch in the configured repo, runs the Codex CLI command,
pushes changes, opens a PR, and posts a Slack review card. The Slack card links
the PR, Linear ticket, PRD item, code-change summary, and Live Codex session.
Clicking **Merge PR** in Slack squash-merges the PR, closes the GitHub issue,
closes the linked Linear ticket, and posts the final summary to Slack.

```text
GITHUB_TOKEN=...
GITHUB_REPO=owner/repo
GITHUB_USERNAME=your_github_username
OPENAI_API_KEY=...
GITHUB_ISSUE_LABELS=prd-generated,codex-agent
CODING_AGENT_ENABLED=true
CODING_AGENT_BASE_BRANCH=master
CODING_AGENT_WORKDIR=/tmp/ai-prd-coding-agent
CODING_AGENT_COMMAND=codex exec --model gpt-4o-mini --full-auto --skip-git-repo-check {prompt}
```

`CODING_AGENT_COMMAND` is intentionally configurable because Codex CLI
installations and safety flags can differ by environment. The backend writes a
task prompt file and replaces `{prompt}`, `{promptFile}`, and `{branch}` before
running the command. Older commands using `--input-file {promptFile}` are
normalized to the current Codex positional prompt format automatically.

On Render, Codex runs inside the same Docker web service. The Dockerfile installs
`@openai/codex` globally, `OPENAI_API_KEY` authenticates the Codex CLI, and
`GITHUB_TOKEN` is used only for cloning/pushing the target repo and creating
GitHub issues/PRs. Use a GitHub token with access to `GITHUB_REPO`.

## Important Notes

- The meeting host must **admit the bot** from the waiting room.
- Meeting audio is recorded to `recordings/<sessionId>.webm` and sent to Deepgram after the call ends. The `recordings/` directory is ignored by Git.
- Session status, transcripts, generated PRDs, roadmap updates, and PRD version history are stored in PostgreSQL so Slack Q&A works after app restarts.
- PRDs are posted as Slack Block Kit sections with metadata, command hints, and section-level formatting rather than a raw Markdown dump.
- Linear approvals require Slack Interactivity & Shortcuts configured at `/api/slack/interactions`; an incoming webhook alone cannot receive button clicks.
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
PUBLIC_BASE_URL=https://your-render-service.onrender.com
SLACK_SIGNING_SECRET=...
LINEAR_API_KEY=...
LINEAR_TEAM_ID=...
BOT_DISPLAY_NAME=AI Notetaker
AUTH_STATE_PATH=/etc/secrets/auth-state.json
PLAYWRIGHT_HEADLESS=true
```

Optional:

```text
SLACK_SLASH_COMMAND_TOKEN=...
SLACK_INVITE_URL=...
LINEAR_PROJECT_ID=...
LINEAR_ASSIGNEE_ID=...
LINEAR_LABEL_IDS=label_uuid_one,label_uuid_two
LINEAR_DONE_STATE_ID=...
GITHUB_TOKEN=...
GITHUB_REPO=owner/repo
GITHUB_USERNAME=your_github_username
OPENAI_API_KEY=...
GITHUB_ISSUE_LABELS=prd-generated,codex-agent
CODING_AGENT_ENABLED=true
CODING_AGENT_BASE_BRANCH=master
CODING_AGENT_WORKDIR=/tmp/ai-prd-coding-agent
CODING_AGENT_COMMAND=codex exec --model gpt-4o-mini --full-auto --skip-git-repo-check {prompt}
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

Use this URL for Slack Interactivity & Shortcuts:

```text
https://your-render-service.onrender.com/api/slack/interactions
```

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Browser Automation**: Playwright
- **Speech-to-Text**: Deepgram Nova-3 with utterances and diarization
- **LLM**: Google Gemini (gemini-2.5-flash)
- **Database**: PostgreSQL
- **Messaging**: Slack incoming webhooks, slash commands, and interactive buttons
- **Issue Tracking**: Linear GraphQL API
- **Server**: Express
