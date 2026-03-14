Run the full Upwork analytics engine and present a comprehensive dashboard. Do these in parallel:

1. Hit the analytics endpoint: `curl -s http://localhost:4000/api/analytics 2>/dev/null || echo "Server not running — run with: npx tsx src/index.ts"`
2. Check current proposal pipeline: `curl -s http://localhost:4000/api/upwork/status 2>/dev/null`

If the server is running, present the analytics in this format:

**Overview**
- Total jobs analyzed, total budget pool, avg budget, max budget
- Average score, score distribution

**Pricing Intelligence**
- Budget tier breakdown (under $100, $100-500, $500-1500, $1500-5000, $5000+) with % and win rates
- Hourly vs fixed split
- Optimal bid range (sweet spot)
- Budget-score correlation

**Close Rate**
- Overall: submitted → won/rejected/no_response/interviewed, win rate %
- By score bracket (which scores actually convert?)
- By niche (which skills land contracts?)
- Avg days to outcome

**Timing**
- Best days for high-quality jobs
- Volume trend (increasing/stable/decreasing)

**Text Mining**
- Top tech combinations requested
- Client pain points (most common phrases)
- Red flag patterns to avoid

**Pipeline Health**
- Error rate, source comparison (search vs best_matches)
- Proposal quality (avg length, won vs lost)

**Top Niches** (table: niche, count, avg budget, win rate)

**AI Recommendations** (numbered list)

If the server is NOT running, offer to start it or run analytics directly with: `npx tsx -e "import { runFullAnalytics } from './src/services/analytics'; runFullAnalytics().then(a => console.log(JSON.stringify(a, null, 2))).catch(console.error)"`
