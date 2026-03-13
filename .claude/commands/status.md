Check the full operational status of the outreach agent. Do all of these in parallel:

1. Run `npm test` to verify all tests pass
2. Check if the TypeScript compiles: `npx tsc --noEmit`
3. Hit the local API for live status: `curl -s http://localhost:4000/api/upwork/status 2>/dev/null || echo "Server not running"`
4. Hit the connects endpoint: `curl -s http://localhost:4000/api/connects 2>/dev/null || echo "Server not running"`
5. Hit the metrics endpoint: `curl -s http://localhost:4000/api/metrics 2>/dev/null || echo "Server not running"`
6. Check git status for uncommitted changes

Report a concise dashboard with:
- Tests: pass/fail count
- TypeScript: clean or errors
- Server: running or not
- Connects remaining + warning level
- Proposal counts by status (queued, submitted, error, etc.)
- Close rate metrics
- Uncommitted changes
