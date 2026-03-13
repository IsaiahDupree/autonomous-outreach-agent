Run a dry-run test on queued proposals to verify the submission pipeline works without actually sending.

Arguments: $ARGUMENTS (optional: jobId to test a specific job, or "batch" to test all queued)

Steps:

1. If a specific jobId is provided, call: `curl -s -X POST http://localhost:4000/api/upwork/dry-run -H "Content-Type: application/json" -d '{"jobId":"<jobId>"}'`
2. If "batch" or no argument, call: `curl -s -X POST http://localhost:4000/api/upwork/dry-run-batch -H "Content-Type: application/json" -d '{"minScore":5,"limit":3}'`
3. Parse and display the results clearly:
   - For each job: title, score, pass/fail, cover letter length, connects cost
   - Summary: total tested, passed, failed
4. If any failed, read the server logs to diagnose: `tail -50 logs/*.log 2>/dev/null`

Report results in a clear table format.
