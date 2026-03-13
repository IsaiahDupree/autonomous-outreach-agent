Build, test, and deploy the outreach agent.

Steps (sequential — each must pass before the next):

1. Run tests: `npm test`
   - If any fail, stop and report failures. Do NOT proceed.
2. Type-check: `npx tsc --noEmit`
   - If errors, stop and report. Do NOT proceed.
3. Build: `npm run build`
   - If build fails, stop and report.
4. Check git status — warn about uncommitted changes
5. Report: "Ready to deploy" with test count, build status, and any warnings

Do NOT automatically restart the server or push to git — just verify everything builds and passes.
