# Autonomous Outreach Agent

AI-powered autonomous agent for Upwork proposal submission and LinkedIn prospecting. Scans jobs, scores them with a two-stage AI pipeline, generates cover letters, and submits proposals — all on autopilot.

## Architecture

```
src/
├── index.ts              # Entry point — Express server + cron scheduler
├── app.ts                # Express app setup
├── Agent/
│   ├── index.ts          # Claude AI — cover letters, screening answers, prospect scoring
│   ├── scorer.ts         # Two-stage scorer: deterministic pre-filter + Claude AI
│   └── characters/       # Character config files (persona, ICP, portfolio)
├── browser/
│   ├── engine.ts         # Puppeteer/CDP connection management, Cloudflare handling
│   └── upwork.ts         # Upwork browser automation (search, scrape, submit)
├── client/
│   ├── Upwork.ts         # Upwork orchestration: scan → score → approve → submit
│   └── Chrome.ts         # Chrome/LinkedIn discovery cycle
├── routes/
│   └── api.ts            # REST endpoints (status, dry-run, submit, metrics)
├── services/
│   ├── cloud.ts          # Supabase persistence (proposals, outcomes, metrics)
│   ├── telegram.ts       # Telegram approval flow + notifications
│   └── obsidian.ts       # Obsidian vault logging
├── config/
│   └── logger.ts         # Winston logging with daily rotation
└── secret/               # Environment variables
```

## How It Works

### Pipeline

1. **Scan** — Cron triggers every 3 hours. Puppeteer searches Upwork with 33 keywords + scrapes Best Matches feed
2. **Dedup** — Skips jobs already in Supabase
3. **Pre-filter** (Stage 1) — Deterministic scoring (0-100): hard excludes, budget floors, ICP keyword matching, proposal count ceiling
4. **AI Score** (Stage 2) — Claude Haiku scores fit (0-10) with bid range and reasoning
5. **Cover Letter** — Claude generates plain-text, human-sounding cover letter at queue time
6. **Approval** — Jobs above `AUTO_SEND_MIN_SCORE` auto-submit. Others go to Telegram for approval (send / send with portfolio / skip)
7. **Submit** — Puppeteer fills the Upwork proposal form (cover letter, bid, milestones, screening questions)
8. **Track** — Connects balance, close rate, win/loss outcomes tracked in Supabase

### Scoring

**Stage 1 — Deterministic Pre-filter (no API calls):**

| Check | Action |
|-------|--------|
| Hard excludes (WordPress, Shopify, etc.) | Instant drop |
| Budget < $200 fixed or < $20/hr | Instant drop |
| 50+ proposals | Instant drop |
| No ICP strong keyword match | Instant drop |
| Strong keywords (ai automation, web scraping, n8n...) | +20 each, cap 60 |
| Weak keywords (api, typescript, docker...) | +8 each, cap 24 |
| Budget $1K+ → +20, $500+ → +10 | Budget bonus |
| Posted < 4h → +15, < 24h → +8 | Recency bonus |

**Stage 2 — Claude AI Scoring (1-10):**
- 9-10: Dream job (core skill + good budget + ideal client)
- 7-8: Strong fit (most skills align, reasonable budget)
- 5-6: Decent fit (some overlap, not sweet spot)
- 3-4: Weak fit
- 1-2: No fit

### Smart Bidding

- Fixed-price $1K+: bid $75 under client budget
- Fixed-price $300-999: bid 5% under
- Hourly: calculates rate from client's range

## Setup

### Prerequisites

- Node.js 18+
- Chrome with remote debugging enabled (`--remote-debugging-port=9222`)
- Supabase project with `upwork_proposals` table
- Telegram bot for approval notifications
- Anthropic API key for Claude

### Install

```bash
npm install
```

### Environment Variables

Create `src/secret/index.ts` or `.env` with:

```
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-chat-id
PORT=4000
BROWSER_MODE=puppeteer
AUTO_SEND=true
AUTO_SEND_MIN_SCORE=8
```

### Run

```bash
# Development
npm run dev

# Production build
npm run build && npm start

# Single scan cycle
npm run once

# Check status
npm run status
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Service health check |
| GET | `/api/connects` | Current connects balance |
| GET | `/api/metrics` | Close rate metrics |
| GET | `/api/upwork/status` | Full dashboard (counts, queued, submitted, errors) |
| GET | `/api/upwork/proposals` | Pending proposals queue |
| POST | `/api/upwork/scan` | Trigger manual scan |
| POST | `/api/upwork/submit` | Submit a single proposal `{ jobId }` |
| POST | `/api/upwork/submit-batch` | Batch submit `{ minScore?, statuses? }` |
| POST | `/api/upwork/dry-run` | Test a proposal without submitting `{ jobId }` |
| POST | `/api/upwork/dry-run-batch` | Test batch `{ minScore?, limit? }` |
| POST | `/api/upwork/outcome` | Record outcome `{ jobId, outcome }` |

## Testing

```bash
# Run all tests
npx vitest

# Run in watch mode
npx vitest --watch

# Run specific test file
npx vitest tests/scorer.test.ts
```

### Test Coverage

- **scorer.test.ts** — Deterministic pre-filter: hard excludes, budget floors, ICP matching, proposal limits, scoring math, edge cases
- **cloud.test.ts** — Supabase persistence: upsert with 409 fallback, filter building, status counting, metrics
- **agent.test.ts** — AI agent: cover letter generation, screening answers, portfolio line matching
- **api.test.ts** — REST endpoints: connects, metrics, proposals, outcomes, dry-run, status dashboard

## Operational Notes

- **Connects**: Each proposal costs 16-27 connects. Auto-submissions pause when < 16 remaining
- **Tab cleanup**: Chrome tabs are closed every 5 keywords during scan and before each submission
- **Rate limiting**: 3-8 second random delay between submissions to avoid detection
- **Cloudflare**: Engine handles Cloudflare challenges automatically with stealth plugin
- **CDP timeout**: Set to 5 minutes for heavy Upwork pages
- **Browser busy flag**: Prevents scan loop from navigating while a submission is in progress
