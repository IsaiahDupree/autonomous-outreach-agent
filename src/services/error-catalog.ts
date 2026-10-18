/**
 * src/services/error-catalog.ts — Error categorization + troubleshooting
 * Pattern-matches real error messages → category + actionable fix suggestions.
 */

export type ErrorCategory =
  | "browser"
  | "auth"
  | "network"
  | "cloudflare"
  | "form"
  | "scoring"
  | "rate_limit"
  | "config"
  | "unknown";

export interface ErrorDiagnosis {
  category: ErrorCategory;
  retryable: boolean;
  troubleshooting: string[];
  summary: string;
}

interface ErrorPattern {
  pattern: RegExp;
  category: ErrorCategory;
  retryable: boolean;
  troubleshooting: string[];
  summary: string;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  // Browser / CDP errors
  {
    pattern: /Protocol error|protocolTimeout|Target closed|Session closed|page has been closed/i,
    category: "browser",
    retryable: true,
    troubleshooting: [
      "Check Chrome is running with --remote-debugging-port=9222",
      "Restart Chrome browser",
      "Check for stale tabs — tab cleanup may be needed",
    ],
    summary: "Browser connection lost or page closed unexpectedly",
  },
  {
    pattern: /Navigation timeout|Timeout exceeded|waiting for selector|timeout/i,
    category: "browser",
    retryable: true,
    troubleshooting: [
      "Page may be loading slowly — check network connection",
      "Upwork may have changed their page structure",
      "Increase protocolTimeout in engine.ts if persistent",
    ],
    summary: "Page navigation or element wait timed out",
  },
  {
    pattern: /net::ERR_|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ECONNREFUSED|ENOTFOUND/i,
    category: "network",
    retryable: true,
    troubleshooting: [
      "Check internet connectivity",
      "DNS resolution may be failing — try a different DNS server",
      "Target service may be temporarily down",
    ],
    summary: "Network connection failed",
  },
  // Cloudflare
  {
    pattern: /cloudflare|cf-challenge|challenge-platform|turnstile|ray id/i,
    category: "cloudflare",
    retryable: true,
    troubleshooting: [
      "Wait 30-60 seconds and retry — Cloudflare challenges are often temporary",
      "Clear browser cookies and retry",
      "Check if IP is rate-limited — consider waiting longer between requests",
    ],
    summary: "Cloudflare challenge or block detected",
  },
  // Auth
  {
    pattern: /401|unauthorized|login required|session expired|not authenticated|oauth.*expired/i,
    category: "auth",
    retryable: true,
    troubleshooting: [
      "Re-login to Upwork: npm run once -- --login",
      "Check OAuth token freshness in ~/.claude/.credentials.json",
      "Session cookies may have expired — restart browser with fresh session",
    ],
    summary: "Authentication failed or session expired",
  },
  {
    pattern: /403|forbidden|access denied/i,
    category: "auth",
    retryable: false,
    troubleshooting: [
      "Account may be restricted or suspended",
      "Check Upwork account standing",
      "The endpoint or resource may require different permissions",
    ],
    summary: "Access forbidden — check account permissions",
  },
  // Rate limiting
  {
    pattern: /429|rate.?limit|too many requests|throttl/i,
    category: "rate_limit",
    retryable: true,
    troubleshooting: [
      "Wait 5-10 minutes before retrying",
      "Reduce scan frequency — currently every 20 min",
      "Check if multiple instances are running",
    ],
    summary: "Rate limited — too many requests",
  },
  // Form / submission errors
  {
    pattern: /cover letter|proposal text|bid amount|screening|form.*empty|form.*fill/i,
    category: "form",
    retryable: true,
    troubleshooting: [
      "Check that cover letter was generated (not empty)",
      "Verify bid amount is set correctly",
      "Run dry-run first: POST /api/upwork/dry-run",
      "Upwork form selectors may have changed — check upwork.ts",
    ],
    summary: "Proposal form filling failed",
  },
  {
    pattern: /connects|not enough connects|insufficient/i,
    category: "form",
    retryable: false,
    troubleshooting: [
      "Check connects balance: GET /api/connects",
      "Buy more connects on Upwork",
      "Pause auto-submissions until connects are replenished",
    ],
    summary: "Insufficient Upwork connects",
  },
  // Scoring
  {
    pattern: /score|scoring|pre.?filter|threshold/i,
    category: "scoring",
    retryable: false,
    troubleshooting: [
      "Check scoring config in scorer.ts",
      "Review HARD_EXCLUDES and ICP_KEYWORDS",
      "Lower UPWORK_SCORE_THRESHOLD in index.ts if too few jobs pass",
    ],
    summary: "Job scoring issue",
  },
  // Claude API (must be before config — "anthropic" matches both)
  {
    pattern: /claude.*error|anthropic.*(?:overloaded|error|failed)|overloaded.*529|529.*overloaded|model.*error/i,
    category: "rate_limit",
    retryable: true,
    troubleshooting: [
      "Claude API may be overloaded — wait and retry",
      "Check Anthropic API status: status.anthropic.com",
      "Verify ANTHROPIC_API_KEY is valid",
    ],
    summary: "Claude API error or overload",
  },
  // Config
  {
    pattern: /SUPABASE|TELEGRAM|API.?KEY|env|config|missing.*key/i,
    category: "config",
    retryable: false,
    troubleshooting: [
      "Check .env file has all required keys",
      "Verify API keys are valid and not expired",
      "Check src/secret/index.ts for required environment variables",
    ],
    summary: "Missing or invalid configuration",
  },
  // Supabase
  {
    pattern: /supabase|postgres|duplicate key|409|conflict/i,
    category: "network",
    retryable: true,
    troubleshooting: [
      "Supabase may be temporarily unavailable",
      "409 conflicts are usually harmless (duplicate job)",
      "Check Supabase dashboard for service status",
    ],
    summary: "Database operation failed",
  },
];

/**
 * Diagnose an error by matching against known patterns.
 */
export function diagnoseError(error: Error | string): ErrorDiagnosis {
  const message = typeof error === "string" ? error : error.message || String(error);

  for (const p of ERROR_PATTERNS) {
    if (p.pattern && p.pattern.test(message)) {
      return {
        category: p.category,
        retryable: p.retryable,
        troubleshooting: p.troubleshooting,
        summary: p.summary,
      };
    }
  }

  return {
    category: "unknown",
    retryable: false,
    troubleshooting: [
      "Check server logs for full error details",
      "This error is not in the known error catalog — investigate manually",
    ],
    summary: message.slice(0, 120),
  };
}
