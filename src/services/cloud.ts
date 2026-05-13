/**
 * src/services/cloud.ts — Supabase + CRMLite cloud layer
 */
import { SUPABASE_URL, SUPABASE_KEY, CRMLITE_URL, CRMLITE_API_KEY } from "../secret";
import logger from "../config/logger";

/** Retry-enabled fetch with timeout — retries on network/timeout/5xx errors, skips retries on 4xx */
async function safeFetch(url: string, opts: RequestInit = {}, retries = 2, timeoutMs = 10000): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
      if (!res) throw new Error("fetch returned undefined");
      // Don't retry client errors (4xx) except 408 (timeout) and 429 (rate limit)
      if (!res.ok && res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        return res;
      }
      // Retry on 429 (rate limit) and 5xx (server errors)
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const delay = res.status === 429 ? 2000 : 1000;
        logger.warn(`[Cloud] Server error ${res.status} — retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (e) {
      if (attempt === retries) throw e;
      logger.warn(`[Cloud] Fetch attempt ${attempt + 1} failed: ${(e as Error).message} — retrying in 1s...`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error("safeFetch: unreachable");
}

const supabaseHeaders = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
});

export async function logAction(agentId: string, action: string, status: string, detail: Record<string, unknown> = {}): Promise<void> {
  try {
    await safeFetch(`${SUPABASE_URL}/rest/v1/actp_agent_audit_log`, {
      method: "POST",
      headers: supabaseHeaders(),
      body: JSON.stringify({ agent_id: agentId, action_type: action, status, result: detail, started_at: new Date().toISOString() }),
    });
  } catch { /* fire and forget */ }
}

/**
 * Save or upsert a proposal to Supabase (matches full table schema).
 * Uses job_id as the conflict key for upserts.
 */
export async function saveProposal(proposal: {
  jobId: string;
  title: string;
  url: string;
  description?: string;
  budget?: string;
  score: number;
  preScore?: number;
  bid?: number;
  coverLetter?: string;
  status?: string;
  reasoning?: string;
  tags?: string[];
  excluded?: string;
  milestonesJson?: string;
  connectsCost?: number;
  offerType?: string;
  // Freelancer Plus insights
  clientHireRate?: number;
  clientHires?: number;
  competitiveBidRange?: { low?: number; avg?: number; high?: number };
  interviewing?: number;
  invitesSent?: number;
  unansweredInvites?: number;
  // Enhanced insights
  paymentVerified?: boolean;
  screeningQuestionCount?: number;
  // Structured proposal beats (problem / solution / proof / portfolio / prior_results / cta)
  slots?: Record<string, string>;
  // ISO timestamp of when the job was posted on Upwork (parsed from relative "X minutes ago").
  postedAt?: string | null;
  // A/B variant tracking: which prompt-variant fragment (if any) was injected at gen time.
  variantNiche?: string | null;
  variantName?: string | null;
  // Raw Stage-2 Claude rating + reasoning (before niche-bias adjustment). Audited
  // separately from the bias-adjusted `score`/`reasoning` to detect prompt drift.
  aiScore?: number | null;
  aiReasoning?: string | null;
}): Promise<boolean> {
  try {
    const body: Record<string, unknown> = {
      job_id: proposal.jobId,
      job_title: proposal.title,
      job_url: proposal.url,
      job_description: proposal.description || null,
      budget: proposal.budget || null,
      score: proposal.score,
      proposal_text: proposal.coverLetter || null,
      proposal_slots_json: proposal.slots && Object.keys(proposal.slots).length > 0 ? proposal.slots : null,
      status: proposal.status || "queued",
      offer_type: proposal.offerType || null,
      submitted_bid_amount: proposal.bid || null,
      submitted_connects_cost: proposal.connectsCost || null,
      milestones_json: proposal.milestonesJson || null,
      updated_at: new Date().toISOString(),
      // Freelancer Plus insights (nullable — only present if Plus is active)
      client_hire_rate: proposal.clientHireRate ?? null,
      client_hires: proposal.clientHires ?? null,
      competitive_bid_low: proposal.competitiveBidRange?.low ?? null,
      competitive_bid_avg: proposal.competitiveBidRange?.avg ?? null,
      competitive_bid_high: proposal.competitiveBidRange?.high ?? null,
      interviewing: proposal.interviewing ?? null,
      invites_sent: proposal.invitesSent ?? null,
      unanswered_invites: proposal.unansweredInvites ?? null,
      // Enhanced insights
      payment_verified: proposal.paymentVerified ?? null,
      screening_question_count: proposal.screeningQuestionCount ?? null,
      // Speed metrics
      tags: proposal.tags && proposal.tags.length > 0 ? proposal.tags : null,
      posted_at: proposal.postedAt ?? null,
      reasoning: proposal.reasoning ?? null,
      variant_niche: proposal.variantNiche ?? null,
      variant_name: proposal.variantName ?? null,
      ai_score: proposal.aiScore ?? null,
      ai_reasoning: proposal.aiReasoning ?? null,
    };

    // Calculate bid competitiveness: our bid / avg competitive bid
    if (proposal.bid && proposal.competitiveBidRange?.avg && proposal.competitiveBidRange.avg > 0) {
      body.bid_competitiveness = Math.round((proposal.bid / proposal.competitiveBidRange.avg) * 100) / 100;
    }

    // Try upsert first, fall back to PATCH if 409
    let res = await safeFetch(`${SUPABASE_URL}/rest/v1/upwork_proposals`, {
      method: "POST",
      headers: { ...supabaseHeaders(), Prefer: "return=representation,resolution=merge-duplicates" },
      body: JSON.stringify(body),
    });
    if (res.status === 409) {
      // Row exists — update via PATCH instead
      const { job_id: _id, ...updateBody } = body;
      res = await safeFetch(
        `${SUPABASE_URL}/rest/v1/upwork_proposals?job_id=eq.${encodeURIComponent(proposal.jobId)}`,
        { method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify(updateBody) },
      );
    }
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      logger.warn(`[Cloud] saveProposal failed (${res.status}): ${err.slice(0, 200)}`);
    }
    return res.ok;
  } catch (e) {
    logger.error(`[Cloud] saveProposal error: ${(e as Error).message}`);
    return false;
  }
}

export async function updateProposalStatus(jobId: string, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  try {
    const updateBody: Record<string, unknown> = { status, updated_at: new Date().toISOString(), ...extra };
    // Track actual submission time
    if (status === "submitted") {
      updateBody.submitted_at = new Date().toISOString();
    }
    const res = await safeFetch(`${SUPABASE_URL}/rest/v1/upwork_proposals?job_id=eq.${encodeURIComponent(jobId)}`, {
      method: "PATCH",
      headers: supabaseHeaders(),
      body: JSON.stringify(updateBody),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      logger.warn(`[Cloud] updateProposalStatus failed (${res.status}) for ${jobId}: ${err.slice(0, 200)}`);
    }
  } catch (e) {
    logger.error(`[Cloud] updateProposalStatus error for ${jobId}: ${(e as Error).message}`);
  }
}

export async function getPendingProposals(): Promise<Record<string, unknown>[]> {
  const res = await safeFetch(
    `${SUPABASE_URL}/rest/v1/upwork_proposals?status=eq.queued&order=created_at.asc`,
    { headers: supabaseHeaders() }
  );
  return res.ok ? (await res.json()) as Record<string, unknown>[] : [];
}

export async function getProposalsByFilter(filter: {
  status?: string | string[];
  minScore?: number;
  jobId?: string;
  limit?: number;
}): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams();
  params.set("order", "score.desc");
  if (filter.limit) params.set("limit", String(filter.limit));
  if (filter.jobId) params.set("job_id", `eq.${filter.jobId}`);
  if (filter.status) {
    const s = Array.isArray(filter.status) ? filter.status : [filter.status];
    params.set("status", s.length === 1 ? `eq.${s[0]}` : `in.(${s.join(",")})`);
  }
  if (filter.minScore) params.set("score", `gte.${filter.minScore}`);
  const res = await safeFetch(`${SUPABASE_URL}/rest/v1/upwork_proposals?${params}`, { headers: supabaseHeaders() });
  return res.ok ? (await res.json()) as Record<string, unknown>[] : [];
}

export async function getStatusCounts(): Promise<Record<string, number>> {
  const res = await safeFetch(`${SUPABASE_URL}/rest/v1/upwork_proposals?select=status`, { headers: supabaseHeaders() });
  if (!res.ok) return {};
  const rows = (await res.json()) as Array<{ status: string }>;
  const counts: Record<string, number> = {};
  rows.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
  return counts;
}

/**
 * Check if a job_id already exists in proposals (avoid re-processing).
 */
export async function proposalExists(jobId: string): Promise<boolean> {
  try {
    const res = await safeFetch(
      `${SUPABASE_URL}/rest/v1/upwork_proposals?job_id=eq.${encodeURIComponent(jobId)}&select=id&limit=1`,
      { headers: supabaseHeaders() }
    );
    if (!res.ok) return false;
    const data = await res.json() as unknown[];
    return data.length > 0;
  } catch {
    return false;
  }
}

/**
 * Batch check which job IDs already exist in proposals.
 * Returns a Set of IDs that exist. Single query instead of N+1.
 */
export async function proposalExistsBatch(jobIds: string[]): Promise<Set<string>> {
  if (jobIds.length === 0) return new Set();
  try {
    const ids = jobIds.map(id => encodeURIComponent(id)).join(",");
    const res = await safeFetch(
      `${SUPABASE_URL}/rest/v1/upwork_proposals?job_id=in.(${ids})&select=job_id`,
      { headers: supabaseHeaders() }
    );
    if (!res.ok) return new Set();
    const data = await res.json() as Array<{ job_id: string }>;
    return new Set(data.map(r => r.job_id));
  } catch {
    return new Set();
  }
}

export async function saveProspect(prospect: {
  platform: string; username: string; displayName?: string;
  bio?: string; followers?: number; icpScore?: number; url?: string;
}): Promise<void> {
  await safeFetch(`${SUPABASE_URL}/rest/v1/crm_contacts`, {
    method: "POST",
    headers: { ...supabaseHeaders(), Prefer: "resolution=ignore-duplicates" },
    body: JSON.stringify({
      platform: prospect.platform, username: prospect.username,
      display_name: prospect.displayName, bio: prospect.bio,
      follower_count: prospect.followers, icp_score: prospect.icpScore,
      pipeline_stage: "new", source: "chrome_agent",
      profile_url: prospect.url, created_at: new Date().toISOString(),
    }),
  }).catch((e) => logger.warn(`[Cloud] saveProspect error: ${(e as Error).message}`));

  if (CRMLITE_URL && CRMLITE_API_KEY) {
    await safeFetch(`${CRMLITE_URL}/api/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": CRMLITE_API_KEY },
      body: JSON.stringify({ platform: prospect.platform, username: prospect.username, display_name: prospect.displayName, icp_score: prospect.icpScore }),
    }).catch((e) => logger.warn(`[Cloud] saveProspect error: ${(e as Error).message}`));
  }
}

/**
 * Get proposal metrics for close rate tracking.
 * Counts proposals by status: submitted, won, rejected, no_response.
 */
export async function getProposalMetrics(): Promise<{
  submitted: number;
  won: number;
  rejected: number;
  noResponse: number;
  avgScore: number;
}> {
  try {
    // Get all proposals that were submitted or beyond
    const res = await safeFetch(
      `${SUPABASE_URL}/rest/v1/upwork_proposals?status=in.(submitted,won,rejected,no_response,interviewed)&select=status,score`,
      { headers: supabaseHeaders() }
    );
    if (!res.ok) return { submitted: 0, won: 0, rejected: 0, noResponse: 0, avgScore: 0 };

    const data = await res.json() as Array<{ status: string; score: number }>;
    const submitted = data.length;
    const won = data.filter(d => d.status === "won").length;
    const rejected = data.filter(d => d.status === "rejected").length;
    const noResponse = data.filter(d => d.status === "no_response").length;
    const totalScore = data.reduce((sum, d) => sum + (d.score || 0), 0);
    const avgScore = submitted > 0 ? Math.round((totalScore / submitted) * 10) / 10 : 0;

    return { submitted, won, rejected, noResponse, avgScore };
  } catch (e) {
    logger.error(`[Cloud] getProposalMetrics error: ${(e as Error).message}`);
    return { submitted: 0, won: 0, rejected: 0, noResponse: 0, avgScore: 0 };
  }
}

/**
 * Mark a proposal outcome (won/rejected/no_response) for close rate tracking.
 */
/**
 * Fetch proposal rows created since the given ISO timestamp. Used by the weekly digest
 * to summarize last-7-days activity. Returns an empty array on transport failure.
 */
export async function fetchProposalsSince(sinceIso: string): Promise<Array<{
  status: string;
  score: number | null;
  pre_score: number | null;
  submitted_at: string | null;
  submitted_connects_cost: number | null;
  created_at: string;
}>> {
  try {
    const url = `${SUPABASE_URL}/rest/v1/upwork_proposals?select=status,score,pre_score,submitted_at,submitted_connects_cost,created_at&created_at=gte.${encodeURIComponent(sinceIso)}&order=created_at.desc`;
    const res = await safeFetch(url, { headers: supabaseHeaders() });
    if (!res.ok) {
      logger.error(`[Cloud] fetchProposalsSince failed: ${res.status}`);
      return [];
    }
    return (await res.json()) as Array<{
      status: string;
      score: number | null;
      pre_score: number | null;
      submitted_at: string | null;
      submitted_connects_cost: number | null;
      created_at: string;
    }>;
  } catch (e) {
    logger.error(`[Cloud] fetchProposalsSince error: ${(e as Error).message}`);
    return [];
  }
}

export async function recordOutcome(jobId: string, outcome: "won" | "rejected" | "no_response" | "interviewed"): Promise<void> {
  try {
    await updateProposalStatus(jobId, outcome, { outcome_at: new Date().toISOString() });
  } catch (e) {
    logger.error(`[Cloud] recordOutcome error for ${jobId}: ${(e as Error).message}`);
  }
}

/**
 * Close rate (hires / submitted) over a rolling N-day window. Counts proposals whose
 * submitted_at (or created_at fallback) falls inside [now - days, now].
 */
export async function getCloseRateWindow(days: number): Promise<{ submitted: number; won: number; closeRate: number }> {
  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const res = await safeFetch(
      `${SUPABASE_URL}/rest/v1/upwork_proposals?status=in.(submitted,won,rejected,no_response,interviewed)&or=(submitted_at.gte.${cutoff},and(submitted_at.is.null,created_at.gte.${cutoff}))&select=status`,
      { headers: supabaseHeaders() }
    );
    if (!res.ok) return { submitted: 0, won: 0, closeRate: 0 };
    const rows = (await res.json()) as Array<{ status: string }>;
    const submitted = rows.length;
    const won = rows.filter(r => r.status === "won").length;
    const closeRate = submitted > 0 ? Math.round((won / submitted) * 1000) / 10 : 0;
    return { submitted, won, closeRate };
  } catch (e) {
    logger.error(`[Cloud] getCloseRateWindow(${days}d) error: ${(e as Error).message}`);
    return { submitted: 0, won: 0, closeRate: 0 };
  }
}

/**
 * Reply-rate per A/B prompt variant. Aggregates upwork_proposals by (variant_niche, variant_name)
 * and counts how many submitted proposals received a client response (won/rejected/interviewed).
 * Rows missing a variant are bucketed under niche="(default)", name="(default)" so the default
 * prompt path is comparable to variants.
 */
export async function getVariantMetrics(): Promise<Array<{
  variant_niche: string;
  variant_name: string;
  submitted: number;
  replies: number;
  won: number;
  reply_rate: number;
}>> {
  try {
    const res = await safeFetch(
      `${SUPABASE_URL}/rest/v1/upwork_proposals?status=in.(submitted,won,rejected,no_response,interviewed)&select=variant_niche,variant_name,status`,
      { headers: supabaseHeaders() }
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<{ variant_niche: string | null; variant_name: string | null; status: string }>;
    const buckets = new Map<string, { variant_niche: string; variant_name: string; submitted: number; replies: number; won: number }>();
    for (const r of rows) {
      const niche = r.variant_niche || "(default)";
      const name = r.variant_name || "(default)";
      const key = `${niche}::${name}`;
      let b = buckets.get(key);
      if (!b) { b = { variant_niche: niche, variant_name: name, submitted: 0, replies: 0, won: 0 }; buckets.set(key, b); }
      b.submitted += 1;
      if (r.status === "won" || r.status === "rejected" || r.status === "interviewed") b.replies += 1;
      if (r.status === "won") b.won += 1;
    }
    return Array.from(buckets.values()).map(b => ({
      ...b,
      reply_rate: b.submitted > 0 ? Math.round((b.replies / b.submitted) * 1000) / 10 : 0,
    })).sort((a, b) => b.submitted - a.submitted);
  } catch (e) {
    logger.error(`[Cloud] getVariantMetrics error: ${(e as Error).message}`);
    return [];
  }
}

export async function checkService(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

// ── Analytics Snapshots — save computed analytics for external apps ──

export async function saveAnalyticsSnapshot(analytics: {
  overview: Record<string, unknown>;
  pricing: Record<string, unknown>;
  closeRate: Record<string, unknown>;
  timing: Record<string, unknown>;
  textInsights: Record<string, unknown>;
  pipeline: Record<string, unknown>;
  plusInsights?: Record<string, unknown>;
  niches: unknown[];
  recommendations: string[];
}, report?: string, contentIdeas?: unknown[]): Promise<string | null> {
  try {
    const overview = analytics.overview as any;
    const closeRate = analytics.closeRate as any;
    const pricing = analytics.pricing as any;
    const timing = analytics.timing as any;
    const textInsights = analytics.textInsights as any;
    const pipeline = analytics.pipeline as any;

    const body = {
      snapshot_type: "full",
      total_jobs: overview.totalJobs,
      total_budget: overview.totalBudget,
      avg_budget: overview.avgBudget,
      avg_score: overview.avgScore,
      status_breakdown: overview.statusBreakdown,
      score_distribution: overview.scoreDistribution,
      submitted: closeRate.overall?.submitted,
      won: closeRate.overall?.won,
      rejected: closeRate.overall?.rejected,
      win_rate: closeRate.overall?.winRate,
      avg_time_to_outcome: closeRate.avgTimeToOutcome,
      budget_tiers: pricing.budgetTiers,
      optimal_bid_range: pricing.optimalBidRange,
      hourly_vs_fixed: pricing.hourlyVsFixed,
      niches: analytics.niches,
      top_niches: (analytics.niches as any[]).sort((a, b) => b.count - a.count).slice(0, 5),
      top_tech_combos: textInsights.topTechCombos,
      client_pain_points: textInsights.clientPainPoints,
      red_flags: textInsights.redFlagPatterns,
      top_skills: textInsights.topSkillTags,
      best_days: timing.bestDays,
      volume_trend: timing.volumeTrend,
      jobs_per_week: timing.jobsPerWeek,
      error_rate: pipeline.errorRate,
      source_comparison: pipeline.sourceComparison,
      plus_insights: analytics.plusInsights || null,
      recommendations: analytics.recommendations,
      narrative_report: report || null,
      content_ideas: contentIdeas || null,
      date_range: overview.dateRange,
      proposal_count: overview.totalJobs,
    };

    const res = await safeFetch(`${SUPABASE_URL}/rest/v1/upwork_analytics_snapshots`, {
      method: "POST",
      headers: { ...supabaseHeaders(), Prefer: "return=representation" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      logger.warn(`[Cloud] saveAnalyticsSnapshot failed (${res.status}): ${err.slice(0, 200)}`);
      return null;
    }

    const [saved] = await res.json() as Array<{ id: string }>;
    logger.info(`[Cloud] Analytics snapshot saved: ${saved.id}`);
    return saved.id;
  } catch (e) {
    logger.error(`[Cloud] saveAnalyticsSnapshot error: ${(e as Error).message}`);
    return null;
  }
}

export async function saveContentBrief(brief: {
  type: string;
  title: string;
  summary?: string;
  content: string;
  dataSources?: Record<string, unknown>;
  tags?: string[];
  metadata?: Record<string, unknown>;
}): Promise<string | null> {
  try {
    const body = {
      brief_type: brief.type,
      title: brief.title,
      summary: brief.summary || null,
      full_content: brief.content,
      data_sources: brief.dataSources || null,
      tags: brief.tags || null,
      metadata: brief.metadata || null,
      status: "draft",
    };

    const res = await safeFetch(`${SUPABASE_URL}/rest/v1/content_briefs`, {
      method: "POST",
      headers: { ...supabaseHeaders(), Prefer: "return=representation" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      logger.warn(`[Cloud] saveContentBrief failed (${res.status}): ${err.slice(0, 200)}`);
      return null;
    }

    const [saved] = await res.json() as Array<{ id: string }>;
    logger.info(`[Cloud] Content brief saved: ${saved.id} — "${brief.title}"`);
    return saved.id;
  } catch (e) {
    logger.error(`[Cloud] saveContentBrief error: ${(e as Error).message}`);
    return null;
  }
}

export async function getLatestSnapshot(): Promise<Record<string, unknown> | null> {
  try {
    const res = await safeFetch(
      `${SUPABASE_URL}/rest/v1/upwork_analytics_snapshots?snapshot_type=eq.full&order=created_at.desc&limit=1`,
      { headers: supabaseHeaders() }
    );
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>[];
    return data.length > 0 ? data[0] : null;
  } catch {
    return null;
  }
}

/**
 * Get Plus insights data for analytics — competitive bid data, hire rates, etc.
 */
export async function getPlusInsightsData(): Promise<Record<string, unknown>[]> {
  try {
    const res = await safeFetch(
      `${SUPABASE_URL}/rest/v1/upwork_proposals?select=job_id,job_title,score,status,budget,submitted_bid_amount,client_hire_rate,client_hires,competitive_bid_low,competitive_bid_avg,competitive_bid_high,interviewing,invites_sent,unanswered_invites,payment_verified,screening_question_count,bid_competitiveness,submitted_at,outcome_at,created_at&competitive_bid_avg=not.is.null&order=created_at.desc`,
      { headers: supabaseHeaders() }
    );
    return res.ok ? (await res.json()) as Record<string, unknown>[] : [];
  } catch {
    return [];
  }
}

/**
 * Expire stale queued/error jobs that are older than 72 hours.
 * Returns the count of expired rows.
 */
export async function expireStaleJobs(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    // Get queued/error jobs older than cutoff
    const res = await safeFetch(
      `${SUPABASE_URL}/rest/v1/upwork_proposals?status=in.(queued,error)&created_at=lt.${cutoff}`,
      {
        method: "PATCH",
        headers: { ...supabaseHeaders(), Prefer: "return=representation,count=exact" },
        body: JSON.stringify({ status: "expired" }),
      }
    );
    if (!res.ok) {
      logger.warn(`[Cloud] expireStaleJobs failed: ${res.status}`);
      return 0;
    }
    const rows = await res.json() as unknown[];
    return rows.length;
  } catch (e) {
    logger.error(`[Cloud] expireStaleJobs error: ${(e as Error).message}`);
    return 0;
  }
}

/**
 * Requeue error-status jobs that are less than 48 hours old.
 * Returns the count of requeued rows.
 */
export async function requeueRecentErrors(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const res = await safeFetch(
      `${SUPABASE_URL}/rest/v1/upwork_proposals?status=eq.error&created_at=gt.${cutoff}`,
      {
        method: "PATCH",
        headers: { ...supabaseHeaders(), Prefer: "return=representation,count=exact" },
        body: JSON.stringify({ status: "queued" }),
      }
    );
    if (!res.ok) {
      logger.warn(`[Cloud] requeueRecentErrors failed: ${res.status}`);
      return 0;
    }
    const rows = await res.json() as unknown[];
    return rows.length;
  } catch (e) {
    logger.error(`[Cloud] requeueRecentErrors error: ${(e as Error).message}`);
    return 0;
  }
}

/**
 * Update the bid amount for a submitted proposal.
 */
export async function updateProposalBid(jobId: string, bid: number): Promise<void> {
  try {
    const res = await safeFetch(
      `${SUPABASE_URL}/rest/v1/upwork_proposals?job_id=eq.${jobId}`,
      {
        method: "PATCH",
        headers: supabaseHeaders(),
        body: JSON.stringify({ submitted_bid_amount: bid }),
      }
    );
    if (!res.ok) {
      logger.warn(`[Cloud] updateProposalBid failed (${res.status}) for ${jobId}`);
    }
  } catch (e) {
    logger.error(`[Cloud] updateProposalBid error for ${jobId}: ${(e as Error).message}`);
  }
}

// ── Proof-of-Work Artifact CRUD ──

export async function saveProofArtifact(jobId: string, artifact: {
  type: string;
  url?: string;
  brief: { analysis: string; architectureDiagram: string; codeSnippets: unknown[]; implementationPlan: string };
  generatedAt: string;
}): Promise<boolean> {
  try {
    const res = await safeFetch(
      `${SUPABASE_URL}/rest/v1/upwork_proposals?job_id=eq.${encodeURIComponent(jobId)}`,
      {
        method: "PATCH",
        headers: supabaseHeaders(),
        body: JSON.stringify({
          proof_artifact_url: artifact.url || null,
          proof_artifact_json: artifact,
          updated_at: new Date().toISOString(),
        }),
      }
    );
    if (!res.ok) {
      logger.warn(`[Cloud] saveProofArtifact failed (${res.status}) for ${jobId}`);
    }
    return res.ok;
  } catch (e) {
    logger.error(`[Cloud] saveProofArtifact error: ${(e as Error).message}`);
    return false;
  }
}

export async function getProofArtifact(jobId: string): Promise<{
  url?: string;
  brief: { analysis: string };
} | null> {
  try {
    const res = await safeFetch(
      `${SUPABASE_URL}/rest/v1/upwork_proposals?job_id=eq.${encodeURIComponent(jobId)}&select=proof_artifact_url,proof_artifact_json`,
      { headers: supabaseHeaders() }
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ proof_artifact_url?: string; proof_artifact_json?: Record<string, unknown> }>;
    if (!rows[0]?.proof_artifact_json) return null;
    const artifact = rows[0].proof_artifact_json as { url?: string; brief: { analysis: string } };
    return {
      url: rows[0].proof_artifact_url || artifact.url,
      brief: artifact.brief,
    };
  } catch {
    return null;
  }
}

export async function getContentBriefs(type?: string, limit = 10): Promise<Record<string, unknown>[]> {
  try {
    const params = new URLSearchParams({ order: "created_at.desc", limit: String(limit) });
    if (type) params.set("brief_type", `eq.${type}`);
    const res = await safeFetch(
      `${SUPABASE_URL}/rest/v1/content_briefs?${params}`,
      { headers: supabaseHeaders() }
    );
    return res.ok ? (await res.json()) as Record<string, unknown>[] : [];
  } catch {
    return [];
  }
}
