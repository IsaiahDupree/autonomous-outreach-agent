/**
 * Generate a fresh proposal and submit it for a specific job.
 * Usage: npx ts-node src/scripts/submit-fresh.ts <jobId>
 */
import { initAgent, generateCoverLetter, qualityCheckCoverLetter, refineCoverLetter } from "../Agent/index";
import { researchJob, formatResearchBrief } from "../services/research";
import * as cloud from "../services/cloud";

const jobId = process.argv[2];
if (!jobId) {
  console.error("Usage: npx ts-node src/scripts/submit-fresh.ts <jobId>");
  process.exit(1);
}

async function main() {
  initAgent();

  // Fetch job from Supabase
  const rows = await cloud.getProposalsByFilter({ jobId });
  if (rows.length === 0) {
    console.error(`Job ${jobId} not found`);
    process.exit(1);
  }
  const row = rows[0];
  const job = {
    id: row.job_id as string,
    title: (row.job_title as string) || "Untitled",
    description: (row.job_description as string) || (row.job_title as string) || "",
    budget: row.budget as string | undefined,
    skills: (row.skills as string[]) || [],
    tags: (row.tags as string[]) || [],
  };

  console.log(`\nJob: ${job.title}`);
  console.log(`Budget: ${job.budget || "n/a"}`);
  console.log(`URL: ${row.job_url}\n`);

  // Research
  let researchBrief: string | undefined;
  try {
    const research = await researchJob({ title: job.title, description: job.description, budget: job.budget, skills: job.skills });
    if (research) {
      researchBrief = formatResearchBrief(research);
      console.log(`[Research] ${research.techInsights?.length || 0} insights`);
    }
  } catch (e) {
    console.log(`[Research] Skipped: ${(e as Error).message}`);
  }

  // Generate
  let coverLetter = await generateCoverLetter({
    title: job.title, description: job.description, budget: job.budget, researchBrief,
  });

  // Quality gate
  const check = qualityCheckCoverLetter(coverLetter, job);
  console.log(`[Quality] ${check.score}/100 — ${check.passed ? "PASSED" : "FAILED"}`);
  if (!check.passed) {
    coverLetter = await refineCoverLetter(coverLetter, job, check);
    const r = qualityCheckCoverLetter(coverLetter, job);
    console.log(`[Re-check] ${r.score}/100 — ${r.passed ? "PASSED" : "FAILED"}`);
  }

  console.log("\n--- PROPOSAL ---");
  console.log(coverLetter);
  console.log("--- END ---\n");

  // Save to Supabase
  await cloud.updateProposalStatus(job.id, "queued", { proposal_text: coverLetter });
  console.log("[Saved to Supabase]");
}

main().catch(console.error);
