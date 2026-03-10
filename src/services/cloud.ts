/**
 * src/services/cloud.ts — Supabase + CRMLite cloud layer
 */
import { SUPABASE_URL, SUPABASE_KEY, CRMLITE_URL, CRMLITE_API_KEY } from "../secret";
import logger from "../config/logger";

const supabaseHeaders = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
});

export async function logAction(agentId: string, action: string, status: string, detail: Record<string, unknown> = {}): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/actp_agent_audit_log`, {
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
}): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/upwork_proposals`, {
      method: "POST",
      headers: { ...supabaseHeaders(), Prefer: "return=representation,resolution=merge-duplicates" },
      body: JSON.stringify({
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
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    });
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
  await fetch(`${SUPABASE_URL}/rest/v1/upwork_proposals?job_id=eq.${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    headers: supabaseHeaders(),
    body: JSON.stringify({ status, updated_at: new Date().toISOString(), ...extra }),
  });
}

export async function getPendingProposals(): Promise<Record<string, unknown>[]> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/upwork_proposals?status=eq.queued&order=created_at.asc`,
    { headers: supabaseHeaders() }
  );
  return res.ok ? (await res.json()) as Record<string, unknown>[] : [];
}

/**
 * Check if a job_id already exists in proposals (avoid re-processing).
 */
export async function proposalExists(jobId: string): Promise<boolean> {
  try {
    const res = await fetch(
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
  await fetch(`${SUPABASE_URL}/rest/v1/crm_contacts`, {
    method: "POST",
    headers: { ...supabaseHeaders(), Prefer: "resolution=ignore-duplicates" },
    body: JSON.stringify({
      platform: prospect.platform, username: prospect.username,
      display_name: prospect.displayName, bio: prospect.bio,
      follower_count: prospect.followers, icp_score: prospect.icpScore,
      pipeline_stage: "new", source: "chrome_agent",
      profile_url: prospect.url, created_at: new Date().toISOString(),
    }),
  }).catch(() => {});

  if (CRMLITE_URL && CRMLITE_API_KEY) {
    await fetch(`${CRMLITE_URL}/api/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": CRMLITE_API_KEY },
      body: JSON.stringify({ platform: prospect.platform, username: prospect.username, display_name: prospect.displayName, icp_score: prospect.icpScore }),
    }).catch(() => {});
  }
}

export async function checkService(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}
