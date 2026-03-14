Record a proposal outcome. Requires a job ID and outcome type.

Arguments: $ARGUMENTS

Parse the arguments to extract jobId and outcome. Expected format: `<jobId> <won|rejected|no_response|interviewed>`

Example: `/outcome abc123 won`

Run:
`curl -s -X POST http://localhost:4000/api/upwork/outcome -H "Content-Type: application/json" -d '{"jobId":"<jobId>","outcome":"<outcome>"}' 2>/dev/null || echo "Server not running"`

Valid outcomes: won, rejected, no_response, interviewed

After recording, show updated close rate metrics:
`curl -s http://localhost:4000/api/metrics 2>/dev/null`

Report the result and current win rate.
