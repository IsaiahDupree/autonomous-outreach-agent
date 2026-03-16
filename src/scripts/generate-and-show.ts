/**
 * Generate fresh proposals for 2 target jobs, display them, and update Supabase.
 * Pulls real job descriptions from Supabase, runs full pipeline.
 * Usage: npx ts-node src/scripts/generate-and-show.ts
 */
import { initAgent, generateCoverLetter, qualityCheckCoverLetter, refineCoverLetter } from "../Agent/index";
import { researchJob, formatResearchBrief } from "../services/research";
import * as cloud from "../services/cloud";

const TARGET_IDS = [
  "2029580994852318967",  // AI-Powered Automation Suite + Web App | $5,000
  "2026738253000812031",  // RAG-Based Xactimate Line Item Translator | $5,000
];

async function generateProposal(job: {
  id: string; title: string; description: string;
  budget?: string; skills: string[]; tags: string[];
}) {
  console.log("\n" + "=".repeat(60));
  console.log(`JOB: ${job.title}`);
  console.log(`Budget: ${job.budget || "n/a"} | ID: ${job.id}`);
  console.log("=".repeat(60));

  // Research via Perplexity
  let researchBrief: string | undefined;
  try {
    const research = await researchJob({
      title: job.title,
      description: job.description,
      budget: job.budget,
      skills: job.skills,
    });
    if (research) {
      researchBrief = formatResearchBrief(research);
      console.log(`\n[Research] ${research.techInsights?.length || 0} insights found`);
    }
  } catch (e) {
    console.log(`[Research] Skipped: ${(e as Error).message}`);
  }

  // Generate cover letter
  let coverLetter = await generateCoverLetter({
    title: job.title,
    description: job.description,
    budget: job.budget,
    researchBrief,
  });

  // Quality gate
  const check = qualityCheckCoverLetter(coverLetter, job);
  console.log(`\n[Quality] Score: ${check.score}/100 — ${check.passed ? "PASSED" : "FAILED"}`);
  for (const c of check.checks) {
    console.log(`  ${c.passed ? "✅" : "❌"} ${c.name} — ${c.detail}`);
  }

  // Refine if needed
  if (!check.passed) {
    console.log("\n[Refining...]");
    coverLetter = await refineCoverLetter(coverLetter, job, check);
    const recheck = qualityCheckCoverLetter(coverLetter, job);
    console.log(`[Re-check] Score: ${recheck.score}/100 — ${recheck.passed ? "PASSED" : "FAILED"}`);
    for (const c of recheck.checks) {
      console.log(`  ${c.passed ? "✅" : "❌"} ${c.name} — ${c.detail}`);
    }
  }

  // Display final proposal
  console.log("\n" + "-".repeat(60));
  console.log("PROPOSAL TEXT:");
  console.log("-".repeat(60));
  console.log(coverLetter);
  console.log("-".repeat(60));

  // Update in Supabase
  try {
    await cloud.updateProposalStatus(job.id, "queued", { proposal_text: coverLetter });
    console.log(`\n[Supabase] Updated & queued for submission`);
  } catch (e) {
    console.log(`[Supabase] Update failed: ${(e as Error).message}`);
  }

  return coverLetter;
}

async function main() {
  initAgent();
  console.log("Character loaded. Fetching job details from Supabase...\n");

  // Pull real job data from Supabase
  for (const jobId of TARGET_IDS) {
    const rows = await cloud.getProposalsByFilter({ jobId });
    if (rows.length === 0) {
      console.log(`[SKIP] Job ${jobId} not found in Supabase`);
      continue;
    }
    const row = rows[0];
    await generateProposal({
      id: row.job_id as string,
      title: (row.job_title as string) || "Untitled",
      description: (row.job_description as string) || (row.job_title as string) || "",
      budget: row.budget as string | undefined,
      skills: ((row.skills as string[]) || []),
      tags: ((row.tags as string[]) || []),
    });
  }

  console.log("\n\n" + "=".repeat(60));
  console.log("Both proposals generated, quality-checked, and saved to Supabase.");
  console.log("Ready to submit via: POST /api/upwork/submit { jobId }");
  console.log("=".repeat(60));
}

main().catch(console.error);
