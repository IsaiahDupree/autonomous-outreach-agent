/**
 * src/services/cloud.ts — Supabase + CRMLite cloud layer
 */
import { SUPABASE_URL, SUPABASE_KEY, CRMLITE_URL, CRMLITE_API_KEY } from "../secret";
import logger from "../config/logger";

/** Retry-enabled fetch with timeout — 2 retries, 1s backoff */
async function safeFetch(url: string, opts: RequestInit = {}, retries = 2, timeoutMs = 10000): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
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
    };

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
  await safeFetch(`${SUPABASE_URL}/rest/v1/upwork_proposals?job_id=eq.${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    headers: supabaseHeaders(),
    body: JSON.stringify({ status, updated_at: new Date().toISOString(), ...extra }),
  });
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
export async function recordOutcome(jobId: string, outcome: "won" | "rejected" | "no_response" | "interviewed"): Promise<void> {
  try {
    await updateProposalStatus(jobId, outcome, { outcome_at: new Date().toISOString() });
  } catch (e) {
    logger.error(`[Cloud] recordOutcome error for ${jobId}: ${(e as Error).message}`);
  }
}

export async function checkService(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}
