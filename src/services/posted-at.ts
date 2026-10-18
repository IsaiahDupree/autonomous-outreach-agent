/**
 * src/services/posted-at.ts — convert Upwork's relative "posted" string to an absolute timestamp.
 *
 * Upwork's search tiles display things like:
 *   "Posted 5 minutes ago"
 *   "Posted 2 hours ago"
 *   "Posted 3 days ago"
 *   "Posted yesterday"
 *   "Posted last month"
 *
 * We snapshot a Date at scrape time and subtract the implied delta. Resolution is approximate
 * (the relative string itself rounds), but it's accurate to within a few minutes for fresh jobs
 * — which is the only window where time-to-submit speed actually matters for "first to apply".
 */

export function parseRelativePosted(input: string | undefined | null, now: Date = new Date()): Date | null {
  if (!input) return null;
  const text = input.toLowerCase().trim();

  // "yesterday" / "last week" / "last month" — coarse fallbacks
  if (text.includes("yesterday")) return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (text.includes("last week")) return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (text.includes("last month")) return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // "Posted 5 minutes ago" / "5 min ago" / "an hour ago" / "a day ago"
  const numMatch = text.match(/(\d+)\s*(second|sec|minute|min|hour|hr|day|week|month|year)s?\s*ago/);
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    const unit = numMatch[2];
    const ms = unitToMs(unit) * n;
    return new Date(now.getTime() - ms);
  }

  // "an hour ago" / "a day ago" — treat as 1 of that unit
  const articleMatch = text.match(/\b(?:an?|one)\s+(second|minute|min|hour|hr|day|week|month|year)s?\s*ago/);
  if (articleMatch) {
    const ms = unitToMs(articleMatch[1]);
    return new Date(now.getTime() - ms);
  }

  // "just now" / "moments ago"
  if (/just now|moments? ago/.test(text)) return new Date(now);

  return null;
}

function unitToMs(unit: string): number {
  switch (unit) {
    case "second": case "sec": return 1000;
    case "minute": case "min": return 60 * 1000;
    case "hour":   case "hr":  return 60 * 60 * 1000;
    case "day":               return 24 * 60 * 60 * 1000;
    case "week":              return 7 * 24 * 60 * 60 * 1000;
    case "month":             return 30 * 24 * 60 * 60 * 1000;
    case "year":              return 365 * 24 * 60 * 60 * 1000;
    default: return 0;
  }
}
