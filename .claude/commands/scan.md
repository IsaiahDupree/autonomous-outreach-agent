Analyze the current scan cycle results and job pipeline.

Steps (run in parallel where possible):

1. Get current status: `curl -s http://localhost:4000/api/upwork/status`
2. Get connects: `curl -s http://localhost:4000/api/connects`
3. Get metrics: `curl -s http://localhost:4000/api/metrics`
4. Check recent logs for scan activity: `grep -i "proposal cycle\|best matches\|qualified\|auto-send\|pre-filtered\|dupes" logs/*.log 2>/dev/null | tail -30`

Report:
- How many jobs were found in the last scan cycle
- How many passed pre-filter vs AI scoring
- How many are queued vs submitted vs errored
- Current connects budget and estimated proposals remaining
- Close rate (won/submitted)
- Any errors or warnings from recent scans
- Recommendations (e.g., "low connects — buy more", "scoring too strict — lower threshold")
