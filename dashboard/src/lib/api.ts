// Typed wrappers around the agent's Express API.
// All paths are relative so the same code works in dev (Vite proxy → :3500)
// and in prod (served from the same origin as the API).

export interface AgentState {
  state: "running" | "paused" | "stopped" | "stopping";
  uptime?: number;
  memory?: { rss: number; heapUsed: number };
  pausedSystems?: string[];
}

export interface ProposalRow {
  id?: number;
  job_id: string;
  job_title: string;
  job_url: string;
  job_description?: string;
  budget?: string;
  score?: number;
  pre_score?: number;
  status: string;
  proposal_text?: string;
  proposal_slots_json?: Record<string, string>;
  reasoning?: string;
  tags?: string[];
  submitted_bid_amount?: number;
  submitted_connects_cost?: number;
  client_hire_rate?: number;
  competitive_bid_avg?: number;
  created_at?: string;
  updated_at?: string;
  submitted_at?: string;
  posted_at?: string;
  viewed_at?: string;
  outcome_at?: string;
  proposals_when_submitted?: number;
  proof_artifact_url?: string;
}

export interface NicheRow {
  niche: string;
  win_rate: number | null;
  response_rate: number | null;
  sample_count: number;
  won_count: number;
  lost_count: number;
  no_response_count: number;
  interviewed_count: number;
  winning_patterns: string | null;
  winning_slot_freq: Record<string, number> | null;
  avg_win_bid: number | null;
  avg_loss_bid: number | null;
  updated_at: string;
}

export interface CharacterConfig {
  name: string;
  persona: string;
  name_signoff?: string;
  tone?: string;
  icp?: { roles?: string[]; companyStage?: string; revenueRange?: string; painPoints?: string[] };
  portfolio?: {
    url?: string;
    label?: string;
    nicheAnchors?: Record<string, { anchor: string; keywords: string[] }>;
    templates?: Record<string, string>;
  };
  showcaseProjects?: Array<{ name: string; description: string; liveUrl?: string; keywords: string[]; featured?: boolean }>;
  github?: { username?: string; repos?: Record<string, { url: string; description: string; keywords: string[] }> };
  youtube?: { channelUrl?: string; videos?: Record<string, { url: string; title: string; keywords: string[] }> };
  winningExamples?: unknown;
  upwork?: unknown;
}

export interface NicheSpeedRow {
  niche: string;
  submissions: number;
  median_time_to_submit_sec: number | null;
  median_time_from_scrape_sec: number | null;
  avg_connects: number | null;
  median_proposals_when_submitted: number | null;
  win_rate: number | null;
  response_rate: number | null;
  won: number;
  rejected: number;
  no_response: number;
  interviewed: number;
}

export interface InFlightState {
  jobId: string;
  jobTitle: string;
  jobUrl: string;
  step: "starting" | "navigating" | "cloudflare" | "applying" | "form_open" | "filling" | "submitting" | "verifying" | "boosting";
  startedAt: string;
  stepStartedAt: string;
  elapsed_sec: number;
  step_elapsed_sec: number;
}

export interface ClickStatRow {
  slug: string;
  target_url: string;
  link_type: string;
  job_id: string | null;
  niche: string | null;
  label: string | null;
  created_at: string;
  click_count: number;
  last_clicked_at: string | null;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text || `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error) message = parsed.error;
    } catch { /* not JSON, keep raw text */ }
    throw new ApiError(`HTTP ${res.status}: ${message}`, res.status);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // Agent
  agentState: () => request<AgentState>("/api/agent/state"),
  connects: () => request<{ connects: number | null; warning: string | null }>("/api/connects"),
  pause: (reason?: string) => request("/api/agent/pause", { method: "POST", body: JSON.stringify({ reason: reason || "dashboard" }) }),
  resume: () => request("/api/agent/resume", { method: "POST", body: "{}" }),

  // Proposals
  listProposals: (params: { status?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.limit) q.set("limit", String(params.limit));
    return request<{ count: number; proposals: ProposalRow[] }>(`/api/upwork/proposals?${q}`);
  },
  getProposal: (jobId: string) =>
    request<{ count: number; proposals: ProposalRow[] }>(`/api/upwork/proposals?jobId=${encodeURIComponent(jobId)}`),
  submitOne: (jobId: string) => request("/api/upwork/submit", { method: "POST", body: JSON.stringify({ jobId }) }),
  skipProposal: (jobId: string, reason?: string) => request("/api/upwork/skip", { method: "POST", body: JSON.stringify({ jobId, reason }) }),
  dryRun: (jobId: string) => request("/api/upwork/dry-run", { method: "POST", body: JSON.stringify({ jobId }) }),
  recordOutcome: (jobId: string, outcome: "won" | "rejected" | "no_response" | "interviewed") =>
    request("/api/upwork/outcome", { method: "POST", body: JSON.stringify({ jobId, outcome }) }),

  // Close-rate metrics (overall + 7d / 30d / 90d windows)
  metrics: () => request<{
    submitted: number; won: number; rejected: number; noResponse: number;
    closeRate: number; avgScore: number;
    windows: {
      "7d": { submitted: number; won: number; closeRate: number };
      "30d": { submitted: number; won: number; closeRate: number };
      "90d": { submitted: number; won: number; closeRate: number };
    };
  }>("/api/metrics"),

  // Reinforcement
  niches: () => request<{ count: number; rows: NicheRow[] }>("/api/reinforcement/niches"),
  refreshReinforcement: () => request<{ ok: boolean; updated: number; skipped: number }>("/api/reinforcement/refresh", { method: "POST", body: "{}" }),

  // Operational health: typed-failure breakdown over the last N hours/days.
  failureBreakdown: (since = "24h") =>
    request<{ since: string; total: number; buckets: Record<string, number>; raw: Record<string, number> }>(`/api/analytics/failure-breakdown?since=${encodeURIComponent(since)}`),

  // Per-niche speed leaderboard
  nicheSpeed: () =>
    request<{ count: number; niches: NicheSpeedRow[] }>("/api/analytics/niche-speed"),

  // Per-(niche, variant) leaderboard. Rows tagged "(default)" cover the no-variant baseline.
  variantPerformance: () =>
    request<{
      count: number;
      variants: Array<{
        niche: string;
        variant: string;
        submissions: number;
        won: number;
        rejected: number;
        no_response: number;
        interviewed: number;
        win_rate: number | null;
        response_rate: number | null;
        is_default: boolean;
      }>;
    }>("/api/analytics/variant-performance"),

  // Submit → click → response → win funnel + per-niche CTR by link type.
  clickFunnel: () =>
    request<{
      funnel: { submitted: number; clicked: number; responded: number; won: number;
                click_rate: number; response_rate: number; win_rate: number;
                median_time_to_first_click_sec: number | null };
      niches: Array<{
        niche: string; submitted: number; clicked: number; responded: number; won: number;
        click_rate: number; response_rate: number; win_rate: number;
        median_time_to_first_click_sec: number | null;
        ctr_by_link_type: Record<string, { clicks: number; impressions: number; rate: number }>;
      }>;
    }>("/api/analytics/click-funnel"),

  // Live in-flight submission state
  inFlight: () => request<{ in_flight: InFlightState | null }>("/api/agent/in-flight"),

  // Snapshot of jobs currently in failure cooldown — they won't be re-attempted until the
  // 30-min window elapses or the daemon restarts.
  cooldown: () => request<{
    count: number;
    window_minutes: number;
    jobs: Array<{ jobId: string; reason: string; age_sec: number }>;
  }>("/api/agent/cooldown"),

  // Character config + slot prompt + per-niche custom context (Templates page)
  character: () => request<{
    character: CharacterConfig;
    slot_prompt: string;
    custom_context: Record<string, string>;
  }>("/api/character"),
  saveCustomContext: (context: Record<string, string>) =>
    request<{ ok: boolean; context: Record<string, string> }>("/api/character/custom-context", {
      method: "PUT",
      body: JSON.stringify({ context }),
    }),
  previewPrompt: (input: { title: string; description: string; budget?: string; tags?: string[] }) =>
    request<{ prompt: string; length: number; approximate_tokens: number }>("/api/character/preview-prompt", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  saveCharacterSection: (section: string, value: unknown) =>
    request<{ ok: boolean; section: string; backup: string }>("/api/character/section", {
      method: "PUT",
      body: JSON.stringify({ section, value }),
    }),
  promptVariants: () =>
    request<{ variants: Record<string, Array<{ name: string; fragment: string; weight?: number }>> }>("/api/character/variants"),
  characterAudit: (limit = 50) =>
    request<{
      count: number;
      entries: Array<{
        ts: string;
        kind: "section" | "variants" | "custom-context" | "slot-prompt";
        section?: string;
        source: string;
        summary: string;
        backup?: string;
        before_size?: number;
        after_size?: number;
      }>;
    }>(`/api/character/audit?limit=${limit}`),
  savePromptVariants: (variants: Record<string, Array<{ name: string; fragment: string; weight?: number }>>) =>
    request<{ ok: boolean }>("/api/character/variants", {
      method: "PUT",
      body: JSON.stringify({ variants }),
    }),

  // Tracking
  clicks: (jobId?: string) => {
    const q = jobId ? `?jobId=${encodeURIComponent(jobId)}` : "";
    return request<{ count: number; rows: ClickStatRow[] }>(`/api/tracking/stats${q}`);
  },
};

export const SLOT_ORDER = ["problem", "solution", "proof", "portfolio", "prior_results", "cta"] as const;

export function scoreClass(score?: number): string {
  if (score == null) return "s0";
  return `s${Math.max(0, Math.min(10, Math.round(score)))}`;
}
