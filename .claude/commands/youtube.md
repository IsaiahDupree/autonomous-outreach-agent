YouTube content intelligence from Upwork market data. Accepts an optional argument for which action to take.

Arguments: $ARGUMENTS

Based on the argument, do ONE of the following:

**"ideas"** (or no argument) — Analyze niches and show content gaps:
`curl -s http://localhost:4000/api/youtube/ideas 2>/dev/null || echo "Server not running"`
Present each niche with job count, avg budget, budget range, and top example jobs.

**"generate"** — Run the full idea generation pipeline (analyze → Claude generates → save to Supabase):
`curl -s -X POST http://localhost:4000/api/youtube/generate 2>/dev/null || echo "Server not running"`
Show how many niches analyzed, ideas generated, and saved. List each idea with title, category, score.

**"report"** — Generate a "What People Want from AI" style market analysis script:
`curl -s http://localhost:4000/api/youtube/report 2>/dev/null || echo "Server not running"`
Show the full narrated report text.

**"analytics"** — Generate a comprehensive analytics-based video script:
`curl -s http://localhost:4000/api/analytics/report 2>/dev/null || echo "Server not running"`
Show the full analytics data plus the narrated video script.

If the server is not running, suggest: `npx tsx src/index.ts` to start it first.
