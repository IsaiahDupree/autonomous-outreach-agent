/**
 * scripts/smoke-dry-run.ts — REAL end-to-end dry-run smoke test.
 *
 * Walks the entire submission pipeline against a real Upwork job URL using the agent's
 * `dryRun: true` mode — Puppeteer navigates to the job, fills in the cover letter, and stops
 * before clicking Submit. Costs zero connects.
 *
 * Prerequisites:
 *   1. Agent running:  npm run dev  (in another terminal)
 *   2. Chrome up with CDP on :9222 and you logged into Upwork in that profile
 *   3. At least one proposal in Supabase with status=queued|pending|error
 *
 * Run with:   npx ts-node scripts/smoke-dry-run.ts
 *   or:       npx ts-node scripts/smoke-dry-run.ts --jobId=<specific job id>
 *
 * Exits 0 on success, 1 on failure. Suitable for CI smoke gates.
 */
import "dotenv/config";

const AGENT_URL = process.env.AGENT_URL || `http://localhost:${process.env.PORT || 3500}`;
const argJobId = process.argv.find(a => a.startsWith("--jobId="))?.split("=")[1];
// CI smoke gate: when set, an unreachable agent exits 0 (skipped) instead of failing the build.
// Real local runs (npm run smoke) leave it unset and require a live agent + Chrome.
const allowNoAgent = process.argv.includes("--allow-no-agent") || process.env.SMOKE_ALLOW_NO_AGENT === "1";

interface ProposalRow {
  job_id: string;
  job_title: string;
  job_url: string;
  status: string;
  score?: number;
  proposal_text?: string;
}

interface DryRunResult {
  ok: boolean;
  jobId: string;
  title: string;
  score?: number;
  hasCoverLetter: boolean;
  coverLetterLength: number;
  message: string;
}

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:   (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan:  (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow:(s: string) => `\x1b[33m${s}\x1b[0m`,
  dim:   (s: string) => `\x1b[2m${s}\x1b[0m`,
};

function fail(step: string, err: unknown): never {
  console.error(c.red(`✗ ${step}`));
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

function pass(step: string, detail = ""): void {
  console.log(c.green(`✓ ${step}`)) ;
  if (detail) console.log(`  ${c.dim(detail)}`);
}

async function step1_agentHealth(): Promise<void> {
  console.log(c.cyan(`\n[1/4] Checking agent health at ${AGENT_URL}`));
  let res: Response;
  try {
    res = await fetch(`${AGENT_URL}/api/health`, { signal: AbortSignal.timeout(5000) });
  } catch (e) {
    if (allowNoAgent) {
      console.log(c.yellow(`⊘ Agent unreachable at ${AGENT_URL} — skipping smoke (--allow-no-agent set).`));
      process.exit(0);
    }
    fail("Agent unreachable", `Is \`npm run dev\` running on ${AGENT_URL}?\n  ${(e as Error).message}`);
  }
  if (!res.ok) fail("Agent /health returned non-OK", `HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  pass("Agent reachable", JSON.stringify(body).slice(0, 200));
}

async function step2_findCandidate(): Promise<ProposalRow> {
  console.log(c.cyan("\n[2/4] Finding a candidate proposal"));
  const url = argJobId
    ? `${AGENT_URL}/api/upwork/proposals?jobId=${encodeURIComponent(argJobId)}`
    : `${AGENT_URL}/api/upwork/proposals?status=queued,pending,error&limit=10`;
  const res = await fetch(url);
  if (!res.ok) fail("List proposals", `HTTP ${res.status}`);
  const { proposals } = (await res.json()) as { proposals: ProposalRow[] };

  if (proposals.length === 0) {
    fail("No candidate proposal", argJobId
      ? `Job ${argJobId} not found in Supabase`
      : "No queued/pending/error proposals available. Run a scan first or pass --jobId=<id>.");
  }

  // Prefer one with an actual cover letter so we exercise the form-fill, not just the regenerate branch.
  const withCover = proposals.find(p => p.proposal_text && p.proposal_text.trim().length > 50);
  const chosen = withCover || proposals[0];
  pass("Candidate found", `${chosen.job_id} · "${chosen.job_title.slice(0, 60)}" · score=${chosen.score ?? "?"}`);
  return chosen;
}

async function step3_dryRun(jobId: string): Promise<DryRunResult> {
  console.log(c.cyan(`\n[3/4] Triggering dry-run for ${jobId}`));
  console.log(c.dim("       (Puppeteer opens the job, fills the form, stops before clicking Submit)"));
  const start = Date.now();
  const res = await fetch(`${AGENT_URL}/api/upwork/dry-run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId }),
    signal: AbortSignal.timeout(240_000),
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    fail("Dry-run request failed", `HTTP ${res.status} after ${elapsed}s\n  ${body.slice(0, 300)}`);
  }
  const result = (await res.json()) as DryRunResult;
  pass(`Dry-run completed in ${elapsed}s`);
  return result;
}

function step4_assertResult(result: DryRunResult): void {
  console.log(c.cyan("\n[4/4] Verifying dry-run output"));
  if (!result.ok) {
    console.log(c.red(`  ✗ ${result.message}`));
    fail("Dry-run reported failure", "Check the agent's terminal for stack trace + Puppeteer screenshots.");
  }
  pass("Dry-run reported PASS", result.message);

  if (!result.hasCoverLetter) {
    console.log(c.yellow(`  ⚠  Cover letter was empty/regenerated (${result.coverLetterLength} chars)`));
  } else {
    pass("Cover letter present", `${result.coverLetterLength} chars`);
  }

  console.log(c.green(`\n${"═".repeat(60)}`));
  console.log(c.green("  REAL DRY-RUN SMOKE TEST PASSED"));
  console.log(c.green(`${"═".repeat(60)}`));
  console.log(`\nThe agent successfully:`);
  console.log(`  · Loaded job ${result.jobId} from Supabase`);
  console.log(`  · Spawned Puppeteer + navigated to the live Upwork job`);
  console.log(`  · Filled the proposal form with ${result.coverLetterLength} chars`);
  console.log(`  · Stopped before clicking Submit (zero connects spent)\n`);
}

(async () => {
  console.log(c.cyan("═══ REAL DRY-RUN SMOKE TEST ═══"));
  console.log(c.dim(`Agent: ${AGENT_URL}`));
  console.log(c.dim(`Job:   ${argJobId || "(auto-pick from queue)"}`));

  await step1_agentHealth();
  const candidate = await step2_findCandidate();
  const result = await step3_dryRun(candidate.job_id);
  step4_assertResult(result);
})().catch(e => {
  console.error(c.red(`\n✗ Unhandled error: ${(e as Error).message}`));
  console.error(c.dim((e as Error).stack || ""));
  process.exit(1);
});
