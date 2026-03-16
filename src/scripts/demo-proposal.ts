/**
 * Demo script: generates a full example proposal through the pipeline.
 * Usage: npx ts-node src/scripts/demo-proposal.ts
 */
import { initAgent, generateCoverLetter, qualityCheckCoverLetter, refineCoverLetter, getMatchingYouTubeVideos } from "../Agent/index";
import { researchJob, formatResearchBrief } from "../services/research";

const job = {
  title: "Agentic AI Developer, Data research Agent & Virtual Professional assistant",
  description: `We are seeking for an experienced AI/LLM developer to design, build and deploy two interconnected agentic AI Systems built on the Anthropic Claude API. The ideal candidate will have deep experience with agentic frameworks, prompt engineering, tool use, and memory-augmented architectures. You should be comfortable building production-grade AI agents that can reason, plan, and execute multi-step tasks autonomously.`,
  budget: "$5,000",
  skills: ["claude", "ai", "agent", "automation", "python"],
  tags: ["claude", "ai", "agent", "automation", "python"],
};

async function main() {
  console.log("=".repeat(60));
  console.log("DEMO: Full Proposal Pipeline");
  console.log("=".repeat(60));
  console.log(`\nJob: ${job.title}`);
  console.log(`Budget: ${job.budget}\n`);

  // 1. Init agent (loads character config)
  console.log("--- Step 1: Init Agent ---");
  initAgent();
  console.log("Character config loaded.\n");

  // 2. YouTube matching
  console.log("--- Step 2: YouTube Video Matching ---");
  const ytProof = getMatchingYouTubeVideos(job);
  console.log(ytProof || "(no YouTube matches)");
  console.log();

  // 3. Perplexity research
  console.log("--- Step 3: Perplexity Research ---");
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
      console.log(researchBrief.slice(0, 500) + "...\n");
    } else {
      console.log("(no research results)\n");
    }
  } catch (e) {
    console.log(`Research failed: ${(e as Error).message} — proceeding without\n`);
  }

  // 4. Generate cover letter
  console.log("--- Step 4: Generate Cover Letter ---");
  let coverLetter = await generateCoverLetter({
    title: job.title,
    description: job.description,
    budget: job.budget,
    researchBrief,
  });
  console.log(coverLetter);
  console.log();

  // 5. Quality gate
  console.log("--- Step 5: Quality Gate ---");
  const check = qualityCheckCoverLetter(coverLetter, job);
  console.log(`Score: ${check.score}/100 — ${check.passed ? "PASSED" : "FAILED"}`);
  for (const c of check.checks) {
    console.log(`  ${c.passed ? "✅" : "❌"} ${c.name} — ${c.detail}`);
  }
  if (check.suggestions.length > 0) {
    console.log("\nSuggestions:");
    check.suggestions.forEach(s => console.log(`  • ${s}`));
  }
  console.log();

  // 6. Refine if needed
  if (!check.passed) {
    console.log("--- Step 6: Refinement ---");
    try {
      coverLetter = await refineCoverLetter(coverLetter, job, check);
      console.log(coverLetter);
      console.log();

      const recheck = qualityCheckCoverLetter(coverLetter, job);
      console.log(`Re-check: ${recheck.score}/100 — ${recheck.passed ? "PASSED" : "FAILED"}`);
      for (const c of recheck.checks) {
        console.log(`  ${c.passed ? "✅" : "❌"} ${c.name} — ${c.detail}`);
      }
    } catch (e) {
      console.log(`Refinement failed: ${(e as Error).message}`);
    }
  } else {
    console.log("--- No refinement needed ---");
  }

  console.log("\n" + "=".repeat(60));
  console.log("FINAL PROPOSAL:");
  console.log("=".repeat(60));
  console.log(coverLetter);
}

main().catch(console.error);
