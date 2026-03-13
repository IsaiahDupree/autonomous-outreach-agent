# CLAUDE.md — Project Guide for Claude Code

## Project Overview

Autonomous Upwork outreach agent: scans jobs → AI scores → generates cover letters → submits proposals via Puppeteer. Runs 24/7 with 3-hour cron cycles.

## Quick Reference

```
npm run dev          # Start with ts-node
npm run build        # Compile + copy character files
npm test             # Run vitest (56 tests)
npm run test:watch   # Watch mode
npm run once         # Single scan cycle
npm run status       # Check agent status
```

## Architecture

```
src/index.ts           → Entry point, cron scheduler, keyword config
src/Agent/index.ts     → Claude API: cover letters, screening answers
src/Agent/scorer.ts    → Two-stage scoring: deterministic pre-filter + AI
src/browser/upwork.ts  → Puppeteer CDP automation (search, scrape, submit)
src/browser/engine.ts  → Browser connection, Cloudflare handling
src/client/Upwork.ts   → Orchestration: scan → score → approve → submit
src/routes/api.ts      → REST endpoints
src/services/cloud.ts  → Supabase persistence (safeFetch with retry)
src/services/telegram.ts → Approval flow + notifications
```

## Key Patterns

- **`fastType()`** — Use CDP `Input.insertText` for text entry, never `keyboard.type()` (Upwork pages are too heavy)
- **`safeFetch()`** — All Supabase calls go through retry wrapper (2 retries, 10s timeout)
- **`_browserBusy`** — Flag that pauses scan loop during proposal submission
- **Tab cleanup** — Close stale tabs every 5 keywords and before each submission
- **Vue reactivity** — Upwork uses Vue 2; use Puppeteer keyboard input, not nativeSetter for form fields
- **Plain text only** — Cover letters must have NO markdown (no bold, bullets, asterisks)

## Testing

Tests are in `tests/` using vitest. All tests mock external dependencies (Supabase, Claude API, Puppeteer).

- `scorer.test.ts` — Deterministic pre-filter (28 tests)
- `cloud.test.ts` — Supabase persistence with 409 fallback (14 tests)
- `agent.test.ts` — AI generation with mocked Claude (3 tests)
- `api.test.ts` — REST endpoints (11 tests)

Always run `npm test` before committing.

## Common Tasks

### Add a new search keyword
Edit `UPWORK_KEYWORDS` array in `src/index.ts`

### Adjust scoring
- Hard excludes: `HARD_EXCLUDES` in `src/Agent/scorer.ts`
- ICP keywords: `ICP_STRONG_KEYWORDS` / `ICP_WEAK_KEYWORDS` in scorer.ts
- Budget floors: `BUDGET_FLOOR_HOURLY` / `BUDGET_FLOOR_FIXED` in scorer.ts
- AI scoring prompt: `scoreJob()` in scorer.ts

### Add a new API endpoint
Add route in `src/routes/api.ts`, add test in `tests/api.test.ts`

### Modify proposal form filling
Edit `submitProposal()` in `src/browser/upwork.ts`. Use `fastType()` for text fields. Always test with dry-run first (`POST /api/upwork/dry-run`).

## Gotchas

- CDP `protocolTimeout` is 5min in engine.ts — don't lower it
- Upwork changes their UI frequently — selectors may break
- The `AbortSignal.timeout()` in safeFetch doesn't compose with other signals
- `msg.content[0]` from Claude API can be empty — always use null guards
- Browser must be Chrome with `--remote-debugging-port=9222`
