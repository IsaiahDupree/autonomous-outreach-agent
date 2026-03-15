# Upwork Agent - Notification System & Auto-Apply Pipeline

## Overview

The notification system monitors Upwork notifications every 6 hours, classifies them, forwards actionable ones to Telegram, auto-records outcomes (wins/rejections), and auto-applies to high-scoring interview invites.

## Schedule

| Time (UTC) | Action |
|---|---|
| Every 3h | Keyword search scan → score → queue |
| Every 3h (offset) | Best Matches scan → score → queue |
| 8 AM, 8 PM | Auto-submit top queued (daily minimum: 2/day) |
| 2 AM, 8 AM, 2 PM, 8 PM | Check notifications → forward → auto-apply invites |
| 9 AM | Daily metrics report |

## Notification Types

| Type | Emoji | Auto-Action |
|---|---|---|
| `interview_invite` | 📩 | Score job → auto-apply if score >= threshold |
| `message` | 💬 | Forward to Telegram |
| `offer` | 🎉 | Forward to Telegram |
| `hire` | 🏆 | Auto-record WIN in Supabase |
| `proposal_viewed` | 👁 | Log only |
| `proposal_declined` | ❌ | Auto-record REJECTED in Supabase |
| `milestone` | 📋 | Forward to Telegram |
| `payment` | 💰 | Forward to Telegram |
| `feedback` | ⭐ | Forward to Telegram |

## Interview Invite Auto-Apply

When an interview invite is detected:

1. Extract job URL from notification
2. Navigate to job page, scrape full details via `getJobDetails()`
3. Score with `scoreJob()` (same 2-stage pipeline)
4. **Invite threshold = AUTO_SEND_MIN_SCORE - 2** (lower bar since client chose us)
5. If score >= threshold: generate cover letter → submit proposal automatically
6. If below threshold: save as "queued" for manual review
7. Telegram notification sent either way

## Auto-Submit (Daily Minimum)

Ensures at least 2 proposals submitted per day:

1. Runs at 8 AM and 8 PM UTC
2. Checks how many already submitted today
3. If below target: picks highest-scoring queued jobs
4. Submits top N to meet daily quota
5. Checks connects balance before each submission
6. Telegram notifications for each submission

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/upwork/notifications` | GET | Check notifications now, forward to Telegram |
| `/api/upwork/auto-submit` | POST | Trigger daily auto-submit (`{ target: 2 }`) |
| `/api/analytics/plus` | GET | Freelancer Plus competitive insights |

## Data Flow

```
Upwork Notifications
  ↓
checkNotifications() — Puppeteer scrapes notification panel
  ↓
Classify: interview_invite | message | offer | hire | declined | ...
  ↓
┌─── interview_invite ──→ getJobDetails() → scoreJob() → auto-apply if high
├─── hire ──────────────→ recordOutcome("won") in Supabase
├─── declined ──────────→ recordOutcome("rejected") in Supabase
├─── interview ─────────→ recordOutcome("interviewed") in Supabase
└─── all actionable ────→ Forward to Telegram with details
```

## Plus Insights Analytics

Enhanced analytics from Freelancer Plus data:

- **Competitive Bidding**: avg market bid vs our bid, competitiveness ratio
- **Client Quality**: hire rate distribution, payment verified rate
- **Competition Level**: avg interviewing/invites, win rate by competition
- **Response Speed**: time-to-submit vs outcome correlation
- **Bid Competitiveness**: auto-calculated ratio (our bid / avg competitive bid)

## Files Modified

- `src/browser/upwork.ts` — `checkNotifications()`, `UpworkNotification` interface
- `src/client/Upwork.ts` — `checkAndProcessNotifications()`, `submitTopQueued()`, invite auto-apply
- `src/routes/api.ts` — `/notifications`, `/auto-submit` endpoints
- `src/index.ts` — Notification check cron (6h), auto-submit cron (12h)
- `src/services/analytics.ts` — `computePlusInsights()` module
- `src/services/cloud.ts` — `paymentVerified`, `bidCompetitiveness`, `submittedAt` columns

## Configuration

- `AUTO_SEND=true` — Enable auto-submissions
- `AUTO_SEND_MIN_SCORE=7` — Minimum score for auto-send during scans
- Invite threshold: `AUTO_SEND_MIN_SCORE - 2` (= 5 by default)
- Daily submit target: 2/day (configurable in index.ts)
