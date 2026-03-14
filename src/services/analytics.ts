/**
 * src/services/analytics.ts — Comprehensive Upwork analytics from proposal data
 * Pricing intelligence, close rates, timing, text mining, pipeline health
 */
import { SUPABASE_URL, SUPABASE_KEY, ANTHROPIC_API_KEY } from "../secret";
import Anthropic from "@anthropic-ai/sdk";
import logger from "../config/logger";

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const supabaseHeaders = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
});

async function safeFetch(url: string, opts: RequestInit = {}, retries = 2): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("safeFetch: unreachable");
}

// ── Types ──────────────────────────────────────────────

interface ProposalRow {
  job_id: string;
  job_title: string;
  job_description: string | null;
  job_url: string;
  budget: string | null;
  score: number;
  pre_score: number | null;
  status: string;
  proposal_text: string | null;
  submitted_bid_amount: number | null;
  submitted_connects_cost: number | null;
  tags: string[] | null;
  source: string | null;
  reasoning: string | null;
  created_at: string;
  updated_at: string | null;
  outcome_at: string | null;
  // Plus insights
  client_hire_rate: number | null;
  client_hires: number | null;
  competitive_bid_low: number | null;
  competitive_bid_avg: number | null;
  competitive_bid_high: number | null;
  interviewing: number | null;
  invites_sent: number | null;
  unanswered_invites: number | null;
  payment_verified: boolean | null;
  screening_question_count: number | null;
  bid_competitiveness: number | null;
  submitted_at: string | null;
}

export interface FullAnalytics {
  overview: OverviewStats;
  pricing: PricingIntelligence;
  closeRate: CloseRateAnalytics;
  timing: TimingAnalysis;
  textInsights: TextMiningInsights;
  pipeline: PipelineHealth;
  plusInsights: PlusInsightsAnalytics;
  niches: NichePerformance[];
  recommendations: string[];
}

interface PlusInsightsAnalytics {
  competitiveBidding: {
    jobsWithBidData: number;
    avgCompetitiveBid: number;
    avgOurBid: number;
    avgBidCompetitiveness: number;  // < 1 = we undercut, > 1 = premium
    bidCompetitivenessVsOutcome: Array<{ range: string; count: number; winRate: number }>;
  };
  clientQuality: {
    avgHireRate: number;
    hireRateVsOutcome: Array<{ range: string; count: number; winRate: number }>;
    paymentVerifiedRate: number;
    verifiedVsUnverified: { verified: { count: number; winRate: number }; unverified: { count: number; winRate: number } };
  };
  competitionLevel: {
    avgInterviewing: number;
    avgInvitesSent: number;
    lowCompetitionWinRate: number;  // < 5 interviewing
    highCompetitionWinRate: number; // >= 5 interviewing
  };
  responseSpeed: {
    avgTimeToSubmit: number | null;  // hours from scrape to submit
    fastSubmitWinRate: number;       // submitted within 2 hours
    slowSubmitWinRate: number;       // submitted after 2 hours
  };
}

interface OverviewStats {
  totalJobs: number;
  totalBudget: number;
  avgBudget: number;
  maxBudget: number;
  avgScore: number;
  scoreDistribution: Record<string, number>;
  statusBreakdown: Record<string, number>;
  dateRange: { first: string; last: string };
}

interface PricingIntelligence {
  budgetTiers: Array<{ tier: string; count: number; pct: number; avgScore: number; winRate: number }>;
  hourlyVsFixed: { hourly: number; fixed: number; unclear: number };
  optimalBidRange: { min: number; max: number; sweetSpot: number };
  budgetScoreCorrelation: string;
}

interface CloseRateAnalytics {
  overall: { submitted: number; won: number; rejected: number; noResponse: number; interviewed: number; winRate: number };
  byScoreBracket: Array<{ bracket: string; submitted: number; won: number; winRate: number }>;
  byNiche: Array<{ niche: string; submitted: number; won: number; winRate: number }>;
  avgTimeToOutcome: number | null;
}

interface TimingAnalysis {
  bestDays: Array<{ day: string; avgScore: number; count: number }>;
  jobsPerWeek: Array<{ week: string; count: number; avgScore: number }>;
  volumeTrend: string;
}

interface TextMiningInsights {
  topTechCombos: Array<{ combo: string; count: number }>;
  clientPainPoints: Array<{ phrase: string; count: number }>;
  redFlagPatterns: Array<{ pattern: string; avgScore: number; count: number }>;
  topSkillTags: Array<{ tag: string; count: number; avgScore: number; winRate: number }>;
}

interface PipelineHealth {
  errorRate: number;
  errorCount: number;
  sourceComparison: { search: { count: number; avgScore: number }; bestMatches: { count: number; avgScore: number } };
  avgScoreTrend: Array<{ period: string; avgScore: number; count: number }>;
  proposalQuality: { avgLength: number; avgLengthWon: number; avgLengthLost: number };
}

interface NichePerformance {
  niche: string;
  count: number;
  avgScore: number;
  avgBudget: number;
  winRate: number;
  submitted: number;
  won: number;
}

// ── Helpers ────────────────────────────────────────────

function parseBudget(budget: string | null): number {
  if (!budget) return 0;
  const m = budget.match(/\$([\d,]+)/);
  return m ? parseFloat(m[1].replace(/,/g, "")) : 0;
}

function isHourly(budget: string | null): boolean {
  return !!(budget && /\/hr|hourly|per hour/i.test(budget));
}

const NICHE_KEYWORDS: Record<string, string[]> = {
  "AI/Automation": ["ai agent", "ai automation", "ai engineer", "autonomous", "ai specialist"],
  "LLM/GPT": ["llm", "claude", "openai", "gpt", "rag", "langchain", "anthropic"],
  "No-Code (n8n/Make)": ["n8n", "make.com", "zapier", "no-code", "workflow automation"],
  "Web Scraping": ["web scraping", "scraper", "data extraction", "crawler"],
  "Full Stack/MVP": ["full stack", "full-stack", "mvp", "saas", "web app", "dashboard"],
  "Lead Gen/CRM": ["lead generation", "lead gen", "crm", "marketing automation", "outreach"],
  "Voice AI": ["elevenlabs", "11labs", "voice ai", "text to speech", "voice agent"],
  "Mobile App": ["mobile app", "react native", "flutter", "ios app", "android app"],
  "Data Pipeline": ["data pipeline", "etl", "data integration", "api integration"],
  "Messaging": ["whatsapp", "twilio", "discord bot", "telegram bot", "sms"],
  "Python": ["python automation", "python script", "python developer"],
};

function classifyNiche(title: string): string {
  const t = title.toLowerCase();
  for (const [niche, keywords] of Object.entries(NICHE_KEYWORDS)) {
    if (keywords.some((kw) => t.includes(kw))) return niche;
  }
  return "Other";
}

const PAIN_PHRASES = [
  "save time", "automate", "replace manual", "too slow", "repetitive",
  "scale", "streamline", "reduce cost", "increase efficiency", "hands-free",
  "no-code", "without coding", "easy to use", "plug and play",
  "real-time", "24/7", "instant", "fast turnaround", "urgent",
];

const RED_FLAGS = [
  "unlimited revisions", "unpaid", "trial", "test task", "free sample",
  "equity only", "revenue share", "exposure", "tight budget",
  "need asap", "very simple", "should be easy", "quick fix",
];

const TECH_TERMS = [
  "n8n", "make.com", "zapier", "openai", "claude", "gpt", "langchain",
  "puppeteer", "playwright", "selenium", "python", "node", "react",
  "next.js", "supabase", "firebase", "airtable", "notion", "slack",
  "twilio", "whatsapp", "telegram", "discord", "stripe", "shopify",
  "hubspot", "salesforce", "elevenlabs", "rag", "vector", "pinecone",
  "postgresql", "mongodb", "redis", "docker", "aws", "vercel",
  "flutter", "react native", "typescript", "tailwind",
];

// ── Data Fetching ──────────────────────────────────────

async function fetchAllProposals(): Promise<ProposalRow[]> {
  const allRows: ProposalRow[] = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const res = await safeFetch(
      `${SUPABASE_URL}/rest/v1/upwork_proposals?select=job_id,job_title,job_description,job_url,budget,score,pre_score,status,proposal_text,submitted_bid_amount,submitted_connects_cost,tags,source,reasoning,created_at,updated_at,outcome_at,client_hire_rate,client_hires,competitive_bid_low,competitive_bid_avg,competitive_bid_high,interviewing,invites_sent,unanswered_invites,payment_verified,screening_question_count,bid_competitiveness,submitted_at&order=created_at.desc&limit=${limit}&offset=${offset}`,
      { headers: supabaseHeaders() },
    );
    if (!res.ok) {
      logger.error(`[Analytics] Failed to fetch proposals: ${res.status}`);
      break;
    }
    const rows = (await res.json()) as ProposalRow[];
    allRows.push(...rows);
    if (rows.length < limit) break;
    offset += limit;
  }

  logger.info(`[Analytics] Loaded ${allRows.length} proposals`);
  return allRows;
}

// ── Analytics Computation ──────────────────────────────

function computeOverview(rows: ProposalRow[]): OverviewStats {
  const budgets = rows.map((r) => parseBudget(r.budget)).filter((b) => b > 0);
  const scores = rows.filter((r) => r.score > 0).map((r) => r.score);

  const scoreDist: Record<string, number> = {};
  for (const s of scores) {
    const bracket = s >= 9 ? "9-10" : s >= 7 ? "7-8" : s >= 5 ? "5-6" : s >= 3 ? "3-4" : "1-2";
    scoreDist[bracket] = (scoreDist[bracket] || 0) + 1;
  }

  const statusBreak: Record<string, number> = {};
  for (const r of rows) {
    statusBreak[r.status] = (statusBreak[r.status] || 0) + 1;
  }

  const dates = rows.map((r) => r.created_at).filter(Boolean).sort();

  return {
    totalJobs: rows.length,
    totalBudget: budgets.reduce((a, b) => a + b, 0),
    avgBudget: budgets.length > 0 ? Math.round(budgets.reduce((a, b) => a + b, 0) / budgets.length) : 0,
    maxBudget: budgets.length > 0 ? Math.max(...budgets) : 0,
    avgScore: scores.length > 0 ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : 0,
    scoreDistribution: scoreDist,
    statusBreakdown: statusBreak,
    dateRange: { first: dates[0] || "N/A", last: dates[dates.length - 1] || "N/A" },
  };
}

function computePricing(rows: ProposalRow[]): PricingIntelligence {
  const withBudget = rows.filter((r) => parseBudget(r.budget) > 0);
  const outcomes = rows.filter((r) => ["won", "rejected", "no_response", "interviewed"].includes(r.status));

  const tiers = [
    { tier: "Under $100", min: 0, max: 100 },
    { tier: "$100 - $500", min: 100, max: 500 },
    { tier: "$500 - $1,500", min: 500, max: 1500 },
    { tier: "$1,500 - $5,000", min: 1500, max: 5000 },
    { tier: "Over $5,000", min: 5000, max: Infinity },
  ];

  const tierStats = tiers.map((t) => {
    const inTier = withBudget.filter((r) => {
      const b = parseBudget(r.budget);
      return b >= t.min && b < t.max;
    });
    const wonInTier = inTier.filter((r) => r.status === "won").length;
    const outcomesInTier = inTier.filter((r) => ["won", "rejected", "no_response", "interviewed"].includes(r.status)).length;
    return {
      tier: t.tier,
      count: inTier.length,
      pct: withBudget.length > 0 ? Math.round((inTier.length / withBudget.length) * 100) : 0,
      avgScore: inTier.length > 0 ? Math.round((inTier.reduce((s, r) => s + r.score, 0) / inTier.length) * 10) / 10 : 0,
      winRate: outcomesInTier > 0 ? Math.round((wonInTier / outcomesInTier) * 100) : 0,
    };
  });

  const hourly = rows.filter((r) => isHourly(r.budget)).length;
  const fixed = withBudget.length - hourly;
  const unclear = rows.length - withBudget.length;

  // Optimal bid range from winning proposals
  const wonBids = rows.filter((r) => r.status === "won" && r.submitted_bid_amount).map((r) => r.submitted_bid_amount!);
  const optMin = wonBids.length > 0 ? Math.min(...wonBids) : 0;
  const optMax = wonBids.length > 0 ? Math.max(...wonBids) : 0;
  const optSweet = wonBids.length > 0 ? Math.round(wonBids.reduce((a, b) => a + b, 0) / wonBids.length) : 0;

  // Budget-score correlation
  const highBudget = withBudget.filter((r) => parseBudget(r.budget) >= 1000);
  const lowBudget = withBudget.filter((r) => parseBudget(r.budget) < 500);
  const highAvg = highBudget.length > 0 ? highBudget.reduce((s, r) => s + r.score, 0) / highBudget.length : 0;
  const lowAvg = lowBudget.length > 0 ? lowBudget.reduce((s, r) => s + r.score, 0) / lowBudget.length : 0;
  const correlation = highAvg > lowAvg + 1 ? "positive" : highAvg < lowAvg - 1 ? "negative" : "neutral";

  return {
    budgetTiers: tierStats,
    hourlyVsFixed: { hourly, fixed, unclear },
    optimalBidRange: { min: optMin, max: optMax, sweetSpot: optSweet },
    budgetScoreCorrelation: correlation,
  };
}

function computeCloseRate(rows: ProposalRow[]): CloseRateAnalytics {
  const submitted = rows.filter((r) => ["submitted", "won", "rejected", "no_response", "interviewed"].includes(r.status));
  const won = submitted.filter((r) => r.status === "won");
  const rejected = submitted.filter((r) => r.status === "rejected");
  const noResponse = submitted.filter((r) => r.status === "no_response");
  const interviewed = submitted.filter((r) => r.status === "interviewed");
  const withOutcome = submitted.filter((r) => ["won", "rejected", "no_response", "interviewed"].includes(r.status));

  // By score bracket
  const brackets = [
    { bracket: "9-10", min: 9, max: 10 },
    { bracket: "7-8", min: 7, max: 8.99 },
    { bracket: "5-6", min: 5, max: 6.99 },
    { bracket: "3-4", min: 3, max: 4.99 },
    { bracket: "1-2", min: 1, max: 2.99 },
  ];

  const byScore = brackets.map((b) => {
    const inBracket = submitted.filter((r) => r.score >= b.min && r.score <= b.max);
    const wonInBracket = inBracket.filter((r) => r.status === "won").length;
    const outcomeInBracket = inBracket.filter((r) => ["won", "rejected", "no_response", "interviewed"].includes(r.status)).length;
    return {
      bracket: b.bracket,
      submitted: inBracket.length,
      won: wonInBracket,
      winRate: outcomeInBracket > 0 ? Math.round((wonInBracket / outcomeInBracket) * 100) : 0,
    };
  });

  // By niche
  const nicheMap = new Map<string, { submitted: number; won: number }>();
  for (const r of submitted) {
    const niche = classifyNiche(r.job_title);
    const entry = nicheMap.get(niche) || { submitted: 0, won: 0 };
    entry.submitted++;
    if (r.status === "won") entry.won++;
    nicheMap.set(niche, entry);
  }
  const byNiche = [...nicheMap.entries()]
    .map(([niche, data]) => ({
      niche,
      submitted: data.submitted,
      won: data.won,
      winRate: data.submitted > 0 ? Math.round((data.won / data.submitted) * 100) : 0,
    }))
    .sort((a, b) => b.submitted - a.submitted);

  // Average time to outcome
  const timesToOutcome = withOutcome
    .filter((r) => r.outcome_at && r.created_at)
    .map((r) => (new Date(r.outcome_at!).getTime() - new Date(r.created_at).getTime()) / (1000 * 60 * 60 * 24));
  const avgTime = timesToOutcome.length > 0 ? Math.round((timesToOutcome.reduce((a, b) => a + b, 0) / timesToOutcome.length) * 10) / 10 : null;

  return {
    overall: {
      submitted: submitted.length,
      won: won.length,
      rejected: rejected.length,
      noResponse: noResponse.length,
      interviewed: interviewed.length,
      winRate: withOutcome.length > 0 ? Math.round((won.length / withOutcome.length) * 100) : 0,
    },
    byScoreBracket: byScore,
    byNiche,
    avgTimeToOutcome: avgTime,
  };
}

function computeTiming(rows: ProposalRow[]): TimingAnalysis {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayStats = new Map<string, { scores: number[]; count: number }>();

  for (const r of rows) {
    if (!r.created_at) continue;
    const d = new Date(r.created_at);
    const dayName = days[d.getUTCDay()];
    const entry = dayStats.get(dayName) || { scores: [], count: 0 };
    entry.scores.push(r.score);
    entry.count++;
    dayStats.set(dayName, entry);
  }

  const bestDays = days
    .filter((d) => dayStats.has(d))
    .map((d) => {
      const s = dayStats.get(d)!;
      return {
        day: d,
        avgScore: Math.round((s.scores.reduce((a, b) => a + b, 0) / s.scores.length) * 10) / 10,
        count: s.count,
      };
    })
    .sort((a, b) => b.avgScore - a.avgScore);

  // Weekly volume
  const weekMap = new Map<string, { scores: number[]; count: number }>();
  for (const r of rows) {
    if (!r.created_at) continue;
    const d = new Date(r.created_at);
    const weekStart = new Date(d);
    weekStart.setUTCDate(d.getUTCDate() - d.getUTCDay());
    const weekKey = weekStart.toISOString().slice(0, 10);
    const entry = weekMap.get(weekKey) || { scores: [], count: 0 };
    entry.scores.push(r.score);
    entry.count++;
    weekMap.set(weekKey, entry);
  }

  const weeks = [...weekMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, data]) => ({
      week,
      count: data.count,
      avgScore: Math.round((data.scores.reduce((a, b) => a + b, 0) / data.scores.length) * 10) / 10,
    }));

  // Trend: compare last 2 weeks vs prior 2 weeks
  const recentWeeks = weeks.slice(-2);
  const priorWeeks = weeks.slice(-4, -2);
  const recentAvg = recentWeeks.length > 0 ? recentWeeks.reduce((s, w) => s + w.count, 0) / recentWeeks.length : 0;
  const priorAvg = priorWeeks.length > 0 ? priorWeeks.reduce((s, w) => s + w.count, 0) / priorWeeks.length : 0;
  const trend = recentAvg > priorAvg * 1.15 ? "increasing" : recentAvg < priorAvg * 0.85 ? "decreasing" : "stable";

  return { bestDays, jobsPerWeek: weeks.slice(-12), volumeTrend: trend };
}

function computeTextInsights(rows: ProposalRow[]): TextMiningInsights {
  const descriptions = rows.map((r) => (r.job_description || r.job_title || "").toLowerCase());

  // Tech combos
  const comboCount = new Map<string, number>();
  for (const desc of descriptions) {
    const found = TECH_TERMS.filter((t) => desc.includes(t));
    for (let i = 0; i < found.length; i++) {
      for (let j = i + 1; j < found.length; j++) {
        const combo = [found[i], found[j]].sort().join(" + ");
        comboCount.set(combo, (comboCount.get(combo) || 0) + 1);
      }
    }
  }
  const topCombos = [...comboCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([combo, count]) => ({ combo, count }));

  // Pain points
  const painCount = new Map<string, number>();
  for (const desc of descriptions) {
    for (const phrase of PAIN_PHRASES) {
      if (desc.includes(phrase)) {
        painCount.set(phrase, (painCount.get(phrase) || 0) + 1);
      }
    }
  }
  const clientPains = [...painCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([phrase, count]) => ({ phrase, count }));

  // Red flags
  const flagStats = RED_FLAGS.map((pattern) => {
    const matching = rows.filter((r) => (r.job_description || r.job_title || "").toLowerCase().includes(pattern));
    return {
      pattern,
      avgScore: matching.length > 0 ? Math.round((matching.reduce((s, r) => s + r.score, 0) / matching.length) * 10) / 10 : 0,
      count: matching.length,
    };
  }).filter((f) => f.count > 0).sort((a, b) => b.count - a.count);

  // Top skill tags
  const tagMap = new Map<string, { count: number; scores: number[]; won: number }>();
  for (const r of rows) {
    if (!r.tags) continue;
    for (const tag of r.tags) {
      const entry = tagMap.get(tag) || { count: 0, scores: [], won: 0 };
      entry.count++;
      entry.scores.push(r.score);
      if (r.status === "won") entry.won++;
      tagMap.set(tag, entry);
    }
  }
  const topTags = [...tagMap.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 15)
    .map(([tag, data]) => ({
      tag,
      count: data.count,
      avgScore: Math.round((data.scores.reduce((a, b) => a + b, 0) / data.scores.length) * 10) / 10,
      winRate: data.count > 0 ? Math.round((data.won / data.count) * 100) : 0,
    }));

  return { topTechCombos: topCombos, clientPainPoints: clientPains, redFlagPatterns: flagStats, topSkillTags: topTags };
}

function computePipeline(rows: ProposalRow[]): PipelineHealth {
  const errors = rows.filter((r) => r.status === "error");

  // Source comparison
  const search = rows.filter((r) => r.source === "search" || !r.source);
  const bestMatches = rows.filter((r) => r.source === "best_matches");

  // Score trend by month
  const monthMap = new Map<string, { scores: number[]; count: number }>();
  for (const r of rows) {
    if (!r.created_at) continue;
    const month = r.created_at.slice(0, 7);
    const entry = monthMap.get(month) || { scores: [], count: 0 };
    entry.scores.push(r.score);
    entry.count++;
    monthMap.set(month, entry);
  }
  const trend = [...monthMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, data]) => ({
      period,
      avgScore: Math.round((data.scores.reduce((a, b) => a + b, 0) / data.scores.length) * 10) / 10,
      count: data.count,
    }));

  // Proposal quality
  const withText = rows.filter((r) => r.proposal_text && r.proposal_text.length > 10);
  const wonWithText = withText.filter((r) => r.status === "won");
  const lostWithText = withText.filter((r) => ["rejected", "no_response"].includes(r.status));

  return {
    errorRate: rows.length > 0 ? Math.round((errors.length / rows.length) * 100 * 10) / 10 : 0,
    errorCount: errors.length,
    sourceComparison: {
      search: {
        count: search.length,
        avgScore: search.length > 0 ? Math.round((search.reduce((s, r) => s + r.score, 0) / search.length) * 10) / 10 : 0,
      },
      bestMatches: {
        count: bestMatches.length,
        avgScore: bestMatches.length > 0 ? Math.round((bestMatches.reduce((s, r) => s + r.score, 0) / bestMatches.length) * 10) / 10 : 0,
      },
    },
    avgScoreTrend: trend,
    proposalQuality: {
      avgLength: withText.length > 0 ? Math.round(withText.reduce((s, r) => s + r.proposal_text!.length, 0) / withText.length) : 0,
      avgLengthWon: wonWithText.length > 0 ? Math.round(wonWithText.reduce((s, r) => s + r.proposal_text!.length, 0) / wonWithText.length) : 0,
      avgLengthLost: lostWithText.length > 0 ? Math.round(lostWithText.reduce((s, r) => s + r.proposal_text!.length, 0) / lostWithText.length) : 0,
    },
  };
}

function computeNiches(rows: ProposalRow[]): NichePerformance[] {
  const nicheMap = new Map<string, { rows: ProposalRow[] }>();
  for (const r of rows) {
    const niche = classifyNiche(r.job_title);
    const entry = nicheMap.get(niche) || { rows: [] };
    entry.rows.push(r);
    nicheMap.set(niche, entry);
  }

  return [...nicheMap.entries()]
    .map(([niche, data]) => {
      const budgets = data.rows.map((r) => parseBudget(r.budget)).filter((b) => b > 0);
      const submitted = data.rows.filter((r) => ["submitted", "won", "rejected", "no_response", "interviewed"].includes(r.status));
      const won = data.rows.filter((r) => r.status === "won");
      const withOutcome = data.rows.filter((r) => ["won", "rejected", "no_response", "interviewed"].includes(r.status));
      return {
        niche,
        count: data.rows.length,
        avgScore: Math.round((data.rows.reduce((s, r) => s + r.score, 0) / data.rows.length) * 10) / 10,
        avgBudget: budgets.length > 0 ? Math.round(budgets.reduce((a, b) => a + b, 0) / budgets.length) : 0,
        winRate: withOutcome.length > 0 ? Math.round((won.length / withOutcome.length) * 100) : 0,
        submitted: submitted.length,
        won: won.length,
      };
    })
    .sort((a, b) => b.count - a.count);
}

// ── Plus Insights Analytics ─────────────────────────────

function computePlusInsights(rows: ProposalRow[]): PlusInsightsAnalytics {
  const withBidData = rows.filter((r) => r.competitive_bid_avg !== null && r.competitive_bid_avg > 0);
  const withOutcome = (subset: ProposalRow[]) => subset.filter((r) => ["won", "rejected", "no_response", "interviewed"].includes(r.status));
  const winRate = (subset: ProposalRow[]) => {
    const oc = withOutcome(subset);
    if (oc.length === 0) return 0;
    return Math.round((oc.filter((r) => r.status === "won").length / oc.length) * 100);
  };

  // Competitive bidding analysis
  const avgCompBid = withBidData.length > 0
    ? Math.round(withBidData.reduce((s, r) => s + (r.competitive_bid_avg || 0), 0) / withBidData.length)
    : 0;
  const withOurBid = rows.filter((r) => r.submitted_bid_amount !== null && r.submitted_bid_amount > 0);
  const avgOurBid = withOurBid.length > 0
    ? Math.round(withOurBid.reduce((s, r) => s + (r.submitted_bid_amount || 0), 0) / withOurBid.length)
    : 0;
  const withCompScore = rows.filter((r) => r.bid_competitiveness !== null);
  const avgCompetitiveness = withCompScore.length > 0
    ? Math.round((withCompScore.reduce((s, r) => s + (r.bid_competitiveness || 0), 0) / withCompScore.length) * 100) / 100
    : 0;

  // Bid competitiveness vs outcome
  const compRanges = [
    { range: "< 0.8 (undercut)", min: 0, max: 0.8 },
    { range: "0.8 - 1.0 (competitive)", min: 0.8, max: 1.0 },
    { range: "1.0 - 1.2 (at market)", min: 1.0, max: 1.2 },
    { range: "> 1.2 (premium)", min: 1.2, max: Infinity },
  ];
  const bidCompVsOutcome = compRanges.map((r) => {
    const inRange = withCompScore.filter((row) => (row.bid_competitiveness || 0) >= r.min && (row.bid_competitiveness || 0) < r.max);
    return { range: r.range, count: inRange.length, winRate: winRate(inRange) };
  });

  // Client quality
  const withHireRate = rows.filter((r) => r.client_hire_rate !== null);
  const avgHireRate = withHireRate.length > 0
    ? Math.round(withHireRate.reduce((s, r) => s + (r.client_hire_rate || 0), 0) / withHireRate.length)
    : 0;
  const hireRateRanges = [
    { range: "0-25%", min: 0, max: 25 },
    { range: "25-50%", min: 25, max: 50 },
    { range: "50-75%", min: 50, max: 75 },
    { range: "75-100%", min: 75, max: 101 },
  ];
  const hireRateVsOutcome = hireRateRanges.map((r) => {
    const inRange = withHireRate.filter((row) => (row.client_hire_rate || 0) >= r.min && (row.client_hire_rate || 0) < r.max);
    return { range: r.range, count: inRange.length, winRate: winRate(inRange) };
  });

  const verified = rows.filter((r) => r.payment_verified === true);
  const unverified = rows.filter((r) => r.payment_verified === false);
  const paymentVerifiedRate = rows.length > 0 ? Math.round((verified.length / rows.length) * 100) : 0;

  // Competition level
  const withInterview = rows.filter((r) => r.interviewing !== null);
  const avgInterviewing = withInterview.length > 0
    ? Math.round((withInterview.reduce((s, r) => s + (r.interviewing || 0), 0) / withInterview.length) * 10) / 10
    : 0;
  const withInvites = rows.filter((r) => r.invites_sent !== null);
  const avgInvites = withInvites.length > 0
    ? Math.round((withInvites.reduce((s, r) => s + (r.invites_sent || 0), 0) / withInvites.length) * 10) / 10
    : 0;
  const lowComp = withInterview.filter((r) => (r.interviewing || 0) < 5);
  const highComp = withInterview.filter((r) => (r.interviewing || 0) >= 5);

  // Response speed
  const submitted = rows.filter((r) => r.submitted_at && r.created_at);
  const submitTimes = submitted.map((r) =>
    (new Date(r.submitted_at!).getTime() - new Date(r.created_at).getTime()) / (1000 * 60 * 60)
  ).filter((h) => h >= 0 && h < 168); // Filter out negative/extreme values
  const avgSubmitTime = submitTimes.length > 0
    ? Math.round((submitTimes.reduce((a, b) => a + b, 0) / submitTimes.length) * 10) / 10
    : null;
  const fastSubmit = submitted.filter((r) => {
    const hours = (new Date(r.submitted_at!).getTime() - new Date(r.created_at).getTime()) / (1000 * 60 * 60);
    return hours >= 0 && hours <= 2;
  });
  const slowSubmit = submitted.filter((r) => {
    const hours = (new Date(r.submitted_at!).getTime() - new Date(r.created_at).getTime()) / (1000 * 60 * 60);
    return hours > 2;
  });

  return {
    competitiveBidding: {
      jobsWithBidData: withBidData.length,
      avgCompetitiveBid: avgCompBid,
      avgOurBid: avgOurBid,
      avgBidCompetitiveness: avgCompetitiveness,
      bidCompetitivenessVsOutcome: bidCompVsOutcome,
    },
    clientQuality: {
      avgHireRate,
      hireRateVsOutcome,
      paymentVerifiedRate,
      verifiedVsUnverified: {
        verified: { count: verified.length, winRate: winRate(verified) },
        unverified: { count: unverified.length, winRate: winRate(unverified) },
      },
    },
    competitionLevel: {
      avgInterviewing,
      avgInvitesSent: avgInvites,
      lowCompetitionWinRate: winRate(lowComp),
      highCompetitionWinRate: winRate(highComp),
    },
    responseSpeed: {
      avgTimeToSubmit: avgSubmitTime,
      fastSubmitWinRate: winRate(fastSubmit),
      slowSubmitWinRate: winRate(slowSubmit),
    },
  };
}

// ── AI-Powered Recommendations ─────────────────────────

async function generateRecommendations(analytics: Omit<FullAnalytics, "recommendations">): Promise<string[]> {
  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      messages: [{
        role: "user",
        content: `You are a freelancing strategist analyzing an Upwork freelancer's data. Based on these analytics, give exactly 5 actionable recommendations. Each should be 1-2 sentences, specific and data-backed.

Overview: ${analytics.overview.totalJobs} jobs, avg score ${analytics.overview.avgScore}/10, avg budget $${analytics.overview.avgBudget}
Win rate: ${analytics.closeRate.overall.winRate}% (${analytics.closeRate.overall.won} won / ${analytics.closeRate.overall.submitted} submitted)
Best niches: ${analytics.niches.slice(0, 3).map((n) => `${n.niche} (${n.count} jobs, ${n.winRate}% win)`).join(", ")}
Error rate: ${analytics.pipeline.errorRate}%
Volume trend: ${analytics.timing.volumeTrend}
Top tech combos: ${analytics.textInsights.topTechCombos.slice(0, 5).map((c) => `${c.combo} (${c.count}x)`).join(", ")}
Budget-score correlation: ${analytics.pricing.budgetScoreCorrelation}
Optimal bid: $${analytics.pricing.optimalBidRange.sweetSpot}
Best days: ${analytics.timing.bestDays.slice(0, 3).map((d) => `${d.day} (${d.avgScore})`).join(", ")}
Plus insights: ${analytics.plusInsights.competitiveBidding.jobsWithBidData} jobs with bid data, avg competitive bid $${analytics.plusInsights.competitiveBidding.avgCompetitiveBid}, our avg bid $${analytics.plusInsights.competitiveBidding.avgOurBid}, competitiveness ratio ${analytics.plusInsights.competitiveBidding.avgBidCompetitiveness}
Client quality: avg hire rate ${analytics.plusInsights.clientQuality.avgHireRate}%, payment verified ${analytics.plusInsights.clientQuality.paymentVerifiedRate}%
Competition: avg interviewing ${analytics.plusInsights.competitionLevel.avgInterviewing}, low comp win rate ${analytics.plusInsights.competitionLevel.lowCompetitionWinRate}% vs high comp ${analytics.plusInsights.competitionLevel.highCompetitionWinRate}%
Response speed: avg ${analytics.plusInsights.responseSpeed.avgTimeToSubmit || "N/A"}h to submit, fast (<2h) win rate ${analytics.plusInsights.responseSpeed.fastSubmitWinRate}% vs slow ${analytics.plusInsights.responseSpeed.slowSubmitWinRate}%

Reply as a JSON array of 5 strings. No markdown.`,
      }],
    });

    const block = msg.content?.[0];
    if (!block || !("text" in block)) return ["Unable to generate recommendations"];
    let text = block.text.trim();
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    return JSON.parse(text);
  } catch (e) {
    logger.error(`[Analytics] Failed to generate recommendations: ${(e as Error).message}`);
    return ["Run more proposals to generate data-backed recommendations"];
  }
}

// ── Main Export ────────────────────────────────────────

export async function runFullAnalytics(): Promise<FullAnalytics> {
  logger.info("[Analytics] Starting full analytics computation...");
  const rows = await fetchAllProposals();

  const overview = computeOverview(rows);
  const pricing = computePricing(rows);
  const closeRate = computeCloseRate(rows);
  const timing = computeTiming(rows);
  const textInsights = computeTextInsights(rows);
  const pipeline = computePipeline(rows);
  const plusInsights = computePlusInsights(rows);
  const niches = computeNiches(rows);

  const partial = { overview, pricing, closeRate, timing, textInsights, pipeline, plusInsights, niches, recommendations: [] as string[] };
  const recommendations = await generateRecommendations(partial);

  logger.info(`[Analytics] Complete — ${rows.length} jobs analyzed across ${niches.length} niches (${plusInsights.competitiveBidding.jobsWithBidData} with Plus bid data)`);
  return { ...partial, recommendations };
}

/**
 * Generate a narrated market report from analytics (for YouTube scripts).
 */
export async function generateAnalyticsReport(analytics: FullAnalytics): Promise<string> {
  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2000,
    messages: [{
      role: "user",
      content: `You are Isaiah, host of "What People Want from AI" — a YouTube channel analyzing AI service demand using real Upwork market data.

Write a video script in your signature style. Use ONLY the real data below — never fabricate numbers.

DATA:
- Analyzed ${analytics.overview.totalJobs} real job postings, total budget pool $${analytics.overview.totalBudget.toLocaleString()}
- Average budget: $${analytics.overview.avgBudget}, highest: $${analytics.overview.maxBudget.toLocaleString()}
- Average fit score: ${analytics.overview.avgScore}/10
- Win rate: ${analytics.closeRate.overall.winRate}% (${analytics.closeRate.overall.won} won from ${analytics.closeRate.overall.submitted} submitted)
- Score distribution: ${JSON.stringify(analytics.overview.scoreDistribution)}
- Status breakdown: ${JSON.stringify(analytics.overview.statusBreakdown)}

BUDGET TIERS:
${analytics.pricing.budgetTiers.map((t) => `  ${t.tier}: ${t.count} jobs (${t.pct}%), avg score ${t.avgScore}, win rate ${t.winRate}%`).join("\n")}
Hourly: ${analytics.pricing.hourlyVsFixed.hourly}, Fixed: ${analytics.pricing.hourlyVsFixed.fixed}, Unclear: ${analytics.pricing.hourlyVsFixed.unclear}
Budget-score correlation: ${analytics.pricing.budgetScoreCorrelation}

TOP NICHES:
${analytics.niches.slice(0, 6).map((n) => `  ${n.niche}: ${n.count} jobs, avg $${n.avgBudget}, ${n.winRate}% win rate`).join("\n")}

TECH COMBOS MOST REQUESTED:
${analytics.textInsights.topTechCombos.slice(0, 8).map((c) => `  ${c.combo}: ${c.count} jobs`).join("\n")}

CLIENT PAIN POINTS:
${analytics.textInsights.clientPainPoints.slice(0, 6).map((p) => `  "${p.phrase}": ${p.count} mentions`).join("\n")}

RED FLAGS:
${analytics.textInsights.redFlagPatterns.slice(0, 5).map((f) => `  "${f.pattern}": ${f.count} jobs, avg score ${f.avgScore}`).join("\n")}

TIMING:
Best days: ${analytics.timing.bestDays.slice(0, 3).map((d) => `${d.day} (${d.avgScore} avg score, ${d.count} jobs)`).join(", ")}
Volume trend: ${analytics.timing.volumeTrend}

FREELANCER PLUS COMPETITIVE INSIGHTS:
- ${analytics.plusInsights.competitiveBidding.jobsWithBidData} jobs with competitive bid data
- Average competitor bid: $${analytics.plusInsights.competitiveBidding.avgCompetitiveBid}, Our avg bid: $${analytics.plusInsights.competitiveBidding.avgOurBid}
- Bid competitiveness ratio: ${analytics.plusInsights.competitiveBidding.avgBidCompetitiveness} (< 1 = undercutting, > 1 = premium)
- Avg client hire rate: ${analytics.plusInsights.clientQuality.avgHireRate}%
- Competition: avg ${analytics.plusInsights.competitionLevel.avgInterviewing} candidates interviewing per job
- Response speed: avg ${analytics.plusInsights.responseSpeed.avgTimeToSubmit || "N/A"} hours to submit

RECOMMENDATIONS:
${analytics.recommendations.map((r, i) => `${i + 1}. ${r}`).join("\n")}

Format: Opening hook with numbers → Key surprising insight → 3 major categories with % and ROI math → Budget sweet spot → 3 underserved opportunities → 5 actionable steps → Closing CTA
Tone: Conversational, data-driven, like presenting to a smart audience. Plain text script, no markdown.`,
    }],
  });

  const block = msg.content?.[0];
  if (!block || !("text" in block)) throw new Error("Empty Claude response");
  return block.text.trim();
}
