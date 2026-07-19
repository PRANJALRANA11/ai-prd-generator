# SDLC0 AI PRD Generator

Meetings in. PRDs out. Tickets ready. Code in motion.

SDLC0 joins a Google Meet call, records the discussion, creates a PRD with
OpenAI, posts it to Slack, creates one approved Linear ticket, mirrors it to a
GitHub issue, and lets Codex open a pull request.

## Try The Product

1. Create a temporary email account for testing.
2. Open the landing page and use the buttons to join the Slack and Linear workspaces.
3. Paste a Google Meet URL and click **Add bot to Meet**.
4. Admit the bot into the meeting.

That is it. After the meeting ends, the bot creates the PRD, posts it to Slack,
and shows an approval button. Approving it creates one Linear ticket, mirrors it
to GitHub, and starts the Codex worker.

The default coding workspace is:

[PRANJALRANA11/vision-frontend](https://github.com/PRANJALRANA11/vision-frontend)

You can watch the generated issues, Codex changes, and pull requests in that
repository.

## Product Flow

```text
Google Meet
  -> transcript
  -> OpenAI PRD
  -> Slack PRD post
  -> approve Linear ticket
  -> GitHub issue
  -> Codex code change
  -> pull request
```

## Useful Links

- App: `https://ai-prd-generator-fshh.onrender.com`
- Live Codex: `https://ai-prd-generator-fshh.onrender.com/codex-live`
- Health: `https://ai-prd-generator-fshh.onrender.com/health`
- Default repo: [PRANJALRANA11/vision-frontend](https://github.com/PRANJALRANA11/vision-frontend)

## Slack Commands

```text
/prd help
/prd history
/prd show v1
/prd diff v1 v2
/prd What are the main requirements?
/prd roadmap Q3 beta, Q4 launch
```

You can also mention the Slack bot and ask for status:

```text
@bot status
```

## Local Development

```bash
npm install
npx playwright install chromium
cp .env.example .env
npm run auth-setup
npm run dev
```

Open:

```text
http://localhost:3000
```

## Required Environment

```text
OPENAI_API_KEY=...
DEEPGRAM_API_KEY=...
DATABASE_URL=...
SLACK_WEBHOOK_URL=...
SLACK_SIGNING_SECRET=...
SLACK_BOT_TOKEN=...
LINEAR_API_KEY=...
LINEAR_TEAM_ID=...
GITHUB_TOKEN=...
GITHUB_REPO=PRANJALRANA11/vision-frontend
AUTH_STATE_PATH=/etc/secrets/auth-state.json
PLAYWRIGHT_HEADLESS=true
PUBLIC_BASE_URL=https://ai-prd-generator-fshh.onrender.com
```

Optional:

```text
OPENAI_MODEL=gpt-4o-mini
CODEX_API_KEY=... # defaults to OPENAI_API_KEY when omitted
SLACK_INVITE_URL=...
LINEAR_INVITE_URL=...
CODING_AGENT_ENABLED=true
CODING_AGENT_BASE_BRANCH=master
CODING_AGENT_WORKDIR=/tmp/ai-prd-coding-agent
CODING_AGENT_COMMAND=codex exec --model gpt-4o-mini --sandbox danger-full-access --skip-git-repo-check {prompt}
```

## Render Deployment

This app should run as a long-running Docker web service, not as serverless
functions. The Meet bot needs Playwright Chromium to stay alive for the full
meeting.

Use:

- `Dockerfile`
- `render.yaml`
- Render Postgres
- Render secret file for `auth-state.json`

Upload Google auth state to Render at:

```text
/etc/secrets/auth-state.json
```

The repo also includes a GitHub Actions keepalive workflow that pings Render
every 15 minutes:

```text
.github/workflows/render-keepalive.yml
```

## Main Endpoints

```text
GET  /health
GET  /codex-live
POST /api/start-bot
POST /api/stop-bot
GET  /api/status/:id
POST /api/slack/prd
POST /api/slack/interactions
POST /api/slack/events
```

## Stack

- Node.js + TypeScript
- Playwright
- Deepgram
- OpenAI Responses API
- PostgreSQL
- Slack
- Linear
- GitHub
- Codex CLI
