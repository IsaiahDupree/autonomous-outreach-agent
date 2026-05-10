# Autonomous Outreach Agent — Requirements

> **Status:** Living document. Last updated 2026-05-08.
> **Owner:** Isaiah Dupree
> **Audience:** Project owner (build spec) + future collaborators (handoff context).

---

## 1. Product Goal

A 24/7 autonomous system that finds Upwork jobs matching the operator's ICP, drafts human-quality cover letters, and submits proposals — with the operator maintaining oversight, not labor.

**Success metrics (in priority order):**
1. **Response rate** — % of submitted proposals that receive any client reply (target: >8%, current baseline: ~4%)
2. **Won contracts / week** — proposals that convert to hires (target: 1–2/week)
3. **Operator time-on-platform** — minutes/day spent in dashboard or Telegram (target: <15 min/day)
4. **Connect efficiency** — connects spent per response (target: <20)

**Explicitly NOT success metrics:** proposals submitted/day (volume is a means, not an end), uptime % (liveness alone doesn't generate revenue).

---

## 2. Users & Roles

### 2.1 Operator (primary)
- Single user today (Isaiah). Owns ICP, persona, templates, scoring rules.
- Engages 1–3× per day: morning review of overnight submissions, midday Telegram approvals, evening tuning.
- Technical: comfortable with TypeScript, Supabase, CLI. Will edit code for tuning, not just config.

### 2.2 Approver (same person, mobile context)
- Receives Telegram push when daemon needs sign-off on borderline proposals.
- Decides in <10 seconds based on job title + first 3 lines of proposal.
- Cannot edit proposal text from phone (gap — see §4.2).

### 2.3 Future: read-only collaborator (out of scope, but constrains design)
- A contractor or business partner viewing analytics without write access.
- Auth model should not preclude this — currently the API is localhost-trust, which is fine for now but a known ceiling.

---

## 3. Surfaces & Acceptance Criteria

### 3.1 Daemon (background process)
**JTBD:** Run the scan → score → draft → submit loop without human input.

**Acceptance criteria:**
- [x] Cron cycle every 3h with configurable keyword list
- [x] Two-stage scoring: deterministic pre-filter + Claude AI scorer
- [x] Cover letter generation with persona, ICP, slot prompts (problem/solution/proof/portfolio/prior_results/cta)
- [x] Cloudflare challenge recovery with screenshot logging
- [x] OAuth auto-refresh from `~/.claude/.credentials.json`
- [x] Watchdog restart on crash (Phase A scheduled task)
- [x] Survives session expiry, network blips, browser disconnects
- [ ] **Gap:** No graceful degradation when Claude API is down (today: hard-fails the cycle)

**Latency budget:** Full cycle <30 min for ~50 jobs across all keywords.

### 3.2 Dashboard (web, React + Vite)
**JTBD:** "Show me what happened, let me tune templates, let me intervene on individual proposals."

**Pages & acceptance criteria:**

| Page | Must have | Should have | Status |
|---|---|---|---|
| **Queue** | Filter by status (queued/pending/auto_sending/submitted/won/rejected); inline actions (dry-run, skip, submit, record outcome); in-flight live progress; cooldown panel | Bulk select + bulk action | ✅ Built |
| **Templates** | Read persona, ICP, slot prompts, portfolio, showcase, repos, videos; edit custom-context per niche; audit trail of edits; variant A/B management | Inline preview of generated proposal with current template | ✅ Built |
| **Niches** | Win/response rates per niche; failure breakdown; speed leaderboard; variant performance; click funnel | Time-series of niche performance | ✅ Built |
| **Clicks** | Tracked link grouping by type (portfolio/proof/showcase/github/youtube); click count + last-click; filter by job ID | Geographic / referrer breakdown | ✅ Built |
| **ProposalDetail** | Full job + proposal + slot breakdown + speed metadata + outcome timeline | Inline proposal text edit; resend with edits | ✅ Built (edit gap) |

**Latency budget:** First contentful paint <1s on localhost. API calls <200ms p95.

**Cross-cutting requirements:**
- Mobile-responsive — operator may check from phone in browser (currently desktop-only)
- Dark mode (currently light only)
- No auth today (localhost-trust); needs JWT/session before any non-localhost deploy

### 3.3 Desktop tray (Electron)
**JTBD:** "Is the agent alive right now? What is it doing this second?"

**Acceptance criteria:**
- [x] Tray icon with state color (green=running, yellow=paused, red=stopped, gray=unknown)
- [x] Tooltip shows current state + in-flight job title + elapsed time + step
- [x] Context menu: Open Dashboard, Pause/Resume, Restart, Show Logs, Health Check, Quit
- [x] Single-click opens dashboard
- [x] Quit only closes tray, not daemon (daemon owned by Phase A scheduled task)
- [ ] **Gap:** No native notifications on errors (operator must be in Telegram)
- [ ] **Gap:** No "snooze for 1h" quick action

**Latency budget:** State poll every 5s; tray must remain responsive even when daemon is unreachable.

### 3.4 Telegram approval gate
**JTBD:** "Approve this one proposal, on my phone, in bed."

**Acceptance criteria:**
- [x] Sends job title + proposal preview with inline buttons
- [x] Buttons: ✅ Send | 📋 With Portfolio | 🔗 View Job | ❌ Skip
- [x] 4h timeout → auto-skip
- [x] Polls Telegram API every 5s for callback queries
- [x] Notification broadcast for pause/resume/stop/errors
- [x] Weekly digest (Sunday 18:00) with pipeline stats
- [x] Approval preview includes: score, AI reasoning, budget, suggested bid, proposal count, skills, Plus-tier insights (hire rate, avg bid, interviewing count, invites), best-matches flag, full cover letter
- [ ] **Gap:** No niche-level historical response rate ("AI/Automation responds 13%") in approval message
- [ ] **Gap:** No time-since-posted ("posted 2h ago") in manual-approval preview (auto-send path has it)
- [ ] **Gap:** No way to edit proposal text before sending
- [ ] **Gap:** No bulk approval ("approve next 5 with portfolio")
- [ ] **Gap:** No "ask me later" / snooze on individual proposals

**Latency budget:** Time-from-send to button-tap <10s for typical operator. Round-trip from button-tap to action <5s.

### 3.5 REST API (`src/routes/api.ts`)
**JTBD:** Contract between daemon and all UIs. Single source of truth for state.

**Acceptance criteria:**
- [x] Agent control: state/pause/resume/stop
- [x] Ops tracking: list, summary, running, errors, retry, cancel
- [x] Proposals: filter, submit, skip, dry-run, outcome, batch
- [x] Metrics & analytics: variants, failures, click funnel, niche speed
- [x] Character/templates: read, edit, audit, preview
- [x] Reinforcement: niche refresh
- [x] Tracking: click stats
- [x] YouTube content endpoints
- [x] Health checks
- [ ] **Gap:** No auth (localhost-trust only)
- [ ] **Gap:** No rate limiting
- [ ] **Gap:** No streaming endpoints (in-flight uses 5s polling — should be SSE/WebSocket)
- [ ] **Gap:** No OpenAPI/typed schema export (types live only in `dashboard/src/lib/api.ts`)

**Latency budget:** <200ms p95 for read endpoints; <2s for submit (excluding browser automation time).

---

## 4. Functional Requirements

### 4.1 Must (built)
- Job scan + two-stage scoring (deterministic + AI)
- Cover letter generation with persona + slot prompts
- Submission via Puppeteer/CDP with Cloudflare recovery
- Telegram approval gate
- Outcome tracking (won/rejected/viewed)
- Variant A/B testing
- Click tracking on portfolio links
- Weekly analytics digest
- Notification monitoring + auto-apply for invites

### 4.2 Should (gaps from inventory)
- **Edit-proposal-before-send in Telegram** — currently the operator either accepts the AI's draft as-is or skips. Editing requires reverting to the dashboard. Inline edit via Telegram message reply would close this.
- **Niche-level response rate + age-of-job in approval preview** — score and Plus-insights are already there; what's missing is "this niche responds 13% historically" and "posted 2h ago," which are the two signals that actually change a tap decision.
- **Bulk operations** — approve N matching a filter, skip all in a niche, etc.
- **Streaming in-flight progress** — replace 5s polling with SSE for real-time tray + dashboard updates.
- **API authentication** — JWT or session-based, prerequisite for any non-localhost deploy.
- **Graceful Claude API degradation** — fallback to cached prompts or queue for retry instead of hard-failing the cycle.

### 4.3 Could (nice-to-have)
- Multi-account support (run two Upwork accounts from one daemon)
- Inline proposal edit in dashboard ProposalDetail
- "Do not submit" windows (e.g., pause overnight in client timezone)
- Slack integration (in addition to Telegram)
- Mobile-native app (replace browser-on-phone)
- Auto-tuning of scoring thresholds based on outcome feedback

### 4.4 Won't (out of scope)
- Other freelance platforms (Fiverr, Toptal, Contra)
- Post-acceptance client communication
- Invoice/contract management
- Public multi-tenant deployment
- LinkedIn or cold-email outreach

---

## 5. Non-Functional Requirements

### 5.1 Reliability
- Daemon survives Cloudflare challenges, OAuth refresh, network blips
- Watchdog restart on crash within 60s
- All Supabase calls go through `safeFetch` with retry (2 retries, 10s timeout)
- Browser auto-reconnect on CDP disconnect
- **Target:** >99% uptime measured as "ready to submit when next job appears"

### 5.2 Observability
- Every submission produces a screenshot (`debug-proposal-*.png`) — currently dumped at repo root, should move to `data/screenshots/`
- Every operation has a row in the `ops` table with status, duration, error
- Every error fires a Telegram notification
- Logs to `logs/` with daily rotation
- **Gap:** No structured log search (today: grep). Consider shipping to a log service (Better Stack, Axiom) if volume grows.

### 5.3 Cost
- Claude API: budget cap per cycle (today: implicit, should be explicit)
- Perplexity: only invoked on jobs scoring >threshold
- **Target:** <$50/month total LLM spend

### 5.4 Security & Privacy
- Credentials in `.env` and `.claude/.credentials.json`, gitignored
- Supabase service role key never logged
- Screenshots may contain client data → must not be committed
  - `.gitignore` already excludes `debug-*.png`, `form-*.png`, and the debug `.js`/`.ts` scratch files (verified). ~283 PNGs sit untracked in working tree — cosmetic clutter, not a leak.
  - Optional cleanup: move runtime screenshots to `data/screenshots/` so the repo root is glanceable, but no urgency.
- No PII in error messages sent to Telegram
- API runs on localhost only; if exposed, requires auth + TLS

### 5.5 Reversibility
- Dry-run mode for every submission (`POST /api/upwork/dry-run`)
- No submission without queued state
- Outcome tracking is append-only (corrections via new rows, not edits)
- Migrations are forward-only and committed before deploy

### 5.6 Performance
- Scan cycle <30 min for ~50 jobs across keywords
- Single proposal submission <90s end-to-end (including Cloudflare delays)
- Dashboard FCP <1s on localhost
- Tray polling every 5s without measurable CPU impact

---

## 6. UX Principles

1. **Glanceable over comprehensive** — operator should know "is it healthy?" in <2s from the tray.
2. **Trust through transparency** — show the prompt, show the score, show the screenshot. No black boxes. The operator must be able to answer "why did the agent do that?" for any single submission.
3. **Mobile-first for approvals, desktop-first for tuning** — Telegram is the mobile surface; dashboard is the deep-work surface; tray is the ambient surface.
4. **Quiet by default** — Telegram only fires for approvals, errors, and weekly digest. No happy-path noise. Operator should be able to ignore the agent for a week without missing anything critical.
5. **One operator, no committees** — no approval workflows beyond the single Telegram tap. No multi-step wizards. Bias toward defaults that work.
6. **Reversible by default** — dry-run is the path of least resistance for any new feature. Destructive actions require explicit confirmation.

---

## 7. Data & Integrations

### 7.1 Owned data (Supabase)
- `jobs` — scraped Upwork jobs
- `proposals` — generated proposals with status lifecycle
- `ops` — operation log
- `outcomes` — won/rejected/viewed with timestamps
- `clicks` — link tracking events
- `niches` — niche performance aggregations
- `character_audit` — template edit history

### 7.2 External dependencies
| Service | Purpose | Failure mode |
|---|---|---|
| Upwork | Source of jobs + submission target | Hard fail (no jobs to submit) |
| Claude API | Cover letter generation, scoring | Hard fail today, should degrade |
| Perplexity API | Job/client research | Soft fail (proposal still sends) |
| Supabase | Persistence | Hard fail with retry |
| Telegram | Approval + notifications | Soft fail (auto-submit fallback) |

---

## 8. Known Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Upwork UI changes break selectors | High | High | Screenshot diffing, fast-fail, multiple selector fallbacks |
| Cloudflare detection escalation | Medium | High | Human-like timing, real Chrome profile, recovery flow |
| Claude API output drift across versions | Medium | Medium | Pinned model ID, variant A/B testing, prompt versioning |
| Account ban for automation | Low | Critical | Human-like timing, conservative submission rate, Telegram approval for high-risk |
| Supabase row-limit on free tier | Low | Medium | Monitoring, archive old proposals/clicks to cold storage |
| Repo hygiene: debug PNGs cluttering working tree | Current | Low (cosmetic) | Already in `.gitignore`; optional move to `data/screenshots/` for glanceability |

---

## 9. Open Questions

1. Is the operator open to a paid plan for Better Stack / Axiom logging, or is `logs/` + grep sufficient?
2. Should the dashboard get auth before or after multi-account support?
3. Is "edit proposal in Telegram via message reply" worth the complexity vs. "just open dashboard"?
4. What's the trigger to add a second Upwork account — operator burnout, or proven response-rate plateau?

---

## 10. Roadmap (suggested, not committed)

**Q2 2026 — close the obvious gaps:**
- Repo hygiene (debug PNG cleanup)
- Telegram: score context + edit-before-send
- API: auth + streaming in-flight

**Q3 2026 — operational polish:**
- Mobile-responsive dashboard
- Dark mode
- Graceful Claude API degradation
- Structured log search

**Q4 2026 — scale:**
- Multi-account support (if response rate plateau confirms need)
- Auto-tuning scoring thresholds
- Public read-only analytics view (for collaborator)
