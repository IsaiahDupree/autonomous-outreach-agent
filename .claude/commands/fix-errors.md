Find and fix errored proposals in the pipeline.

Steps:

1. Get errored proposals: `curl -s http://localhost:4000/api/upwork/status | jq '.errors'` (or parse JSON if jq not available)
2. For each errored job, analyze:
   - Does it have a cover letter? (check `hasCoverLetter` field)
   - What's the score?
   - What's the job URL (still valid?)
3. Check recent error logs: `grep -i "error\|fail\|timeout" logs/*.log 2>/dev/null | tail -30`
4. Categorize errors:
   - Missing cover letter → regenerate via API
   - Cloudflare block → note for retry later
   - Form fill failure → check if Upwork UI changed
   - Network timeout → retry candidate
5. For retryable errors, suggest specific fix actions (dry-run first, then submit)

Report a clear summary of errors and recommended actions.
