Submit Upwork proposals. Accepts an argument for the action.

Arguments: $ARGUMENTS

Based on the argument:

**A job ID** (e.g., "abc123") — Submit a single proposal:
`curl -s -X POST http://localhost:4000/api/upwork/submit -H "Content-Type: application/json" -d '{"jobId":"$ARGUMENTS"}' 2>/dev/null || echo "Server not running"`

**"batch"** — Submit all queued proposals above score threshold:
`curl -s -X POST http://localhost:4000/api/upwork/submit-batch -H "Content-Type: application/json" -d '{"minScore":7}' 2>/dev/null || echo "Server not running"`

**"dry-run"** or no argument — Dry-run test the next queued proposal:
`curl -s -X POST http://localhost:4000/api/upwork/dry-run-batch -H "Content-Type: application/json" -d '{"minScore":7,"limit":1}' 2>/dev/null || echo "Server not running"`

**"dry-run-batch"** — Dry-run test all queued proposals:
`curl -s -X POST http://localhost:4000/api/upwork/dry-run-batch -H "Content-Type: application/json" -d '{"minScore":7,"limit":10}' 2>/dev/null || echo "Server not running"`

After any action, report the result clearly. For submissions, note that they run asynchronously — check `/api/upwork/status` after a minute to see results.
