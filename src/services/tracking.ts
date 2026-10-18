/**
 * src/services/tracking.ts — short-link redirect + per-click logging.
 *
 * Cover letters embed `${TRACKING_BASE_URL}/r/<slug>` instead of raw URLs.
 * The /r/:slug Express route resolves the slug, fires off a click row, and 302s.
 */
import { randomBytes } from "crypto";
import { SUPABASE_URL, SUPABASE_KEY, TRACKING_BASE_URL } from "../secret";
import logger from "../config/logger";

export type LinkType = "portfolio" | "proof" | "showcase" | "github" | "youtube" | "other";

export interface TrackedLinkContext {
  jobId?: string;
  niche?: string;
  label?: string;
}

const supabaseHeaders = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
});

async function safeFetch(url: string, opts: RequestInit = {}, retries = 1, timeoutMs = 8000): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok && res.status >= 400 && res.status < 500 && res.status !== 429) return res;
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      return res;
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error("safeFetch unreachable");
}

/** Generate a URL-safe 8-char slug. */
function generateSlug(): string {
  return randomBytes(6).toString("base64url").slice(0, 8);
}

/**
 * Create a tracked short link for the given target URL.
 * Returns the full short URL (e.g. https://outreach.host/r/abc12xyz) ready to drop into a proposal.
 * On any failure, returns the original target URL — proposals never break because of tracking.
 */
export async function createTrackedLink(targetUrl: string, ctx: TrackedLinkContext, linkType: LinkType): Promise<string> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return targetUrl;
  if (!targetUrl) return targetUrl;

  const slug = generateSlug();
  try {
    const res = await safeFetch(`${SUPABASE_URL}/rest/v1/tracked_links`, {
      method: "POST",
      headers: supabaseHeaders(),
      body: JSON.stringify({
        slug,
        target_url: targetUrl,
        link_type: linkType,
        job_id: ctx.jobId || null,
        niche: ctx.niche || null,
        label: ctx.label || null,
      }),
    });
    if (!res.ok) {
      logger.warn(`[Tracking] Failed to create link (${res.status}) — falling back to raw URL`);
      return targetUrl;
    }
    return `${TRACKING_BASE_URL}/r/${slug}`;
  } catch (e) {
    logger.warn(`[Tracking] createTrackedLink failed: ${(e as Error).message} — falling back to raw URL`);
    return targetUrl;
  }
}

/** Resolve a slug to its target URL. Returns null if missing. */
export async function resolveSlug(slug: string): Promise<string | null> {
  if (!SUPABASE_URL || !SUPABASE_KEY || !slug) return null;
  try {
    const res = await safeFetch(
      `${SUPABASE_URL}/rest/v1/tracked_links?slug=eq.${encodeURIComponent(slug)}&select=target_url`,
      { headers: supabaseHeaders() }
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ target_url: string }>;
    return rows[0]?.target_url || null;
  } catch {
    return null;
  }
}

/** Fire-and-forget click logger. Never throws. */
export async function recordClick(slug: string, info: { ip?: string; userAgent?: string; referer?: string }): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_KEY || !slug) return;
  try {
    await safeFetch(`${SUPABASE_URL}/rest/v1/link_clicks`, {
      method: "POST",
      headers: supabaseHeaders(),
      body: JSON.stringify({
        slug,
        ip: info.ip || null,
        user_agent: info.userAgent || null,
        referer: info.referer || null,
      }),
    });
  } catch (e) {
    logger.warn(`[Tracking] recordClick failed for slug=${slug}: ${(e as Error).message}`);
  }
}

export interface ClickStatRow {
  slug: string;
  target_url: string;
  link_type: LinkType;
  job_id: string | null;
  niche: string | null;
  label: string | null;
  created_at: string;
  click_count: number;
  last_clicked_at: string | null;
}

/** Get per-link click stats. If jobId is given, scopes to that job. */
export async function getClickStats(jobId?: string, limit = 200): Promise<ClickStatRow[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  const filter = jobId ? `&job_id=eq.${encodeURIComponent(jobId)}` : "";
  try {
    const res = await safeFetch(
      `${SUPABASE_URL}/rest/v1/tracked_links_with_clicks?order=created_at.desc&limit=${limit}${filter}`,
      { headers: supabaseHeaders() }
    );
    if (!res.ok) return [];
    return (await res.json()) as ClickStatRow[];
  } catch {
    return [];
  }
}
