/**
 * src/client/Upwork.ts — Upwork platform client (mirrors Riona's Instagram.ts)
 * Talks to Safari automation service at SAFARI_UPWORK_PORT
 */
import logger from "../config/logger";
import { SAFARI_UPWORK_PORT } from "../secret";
import * as cloud from "../services/cloud";
import * as obsidian from "../services/obsidian";
import * as tg from "../services/telegram";
import { generateCoverLetter } from "../Agent";

const BASE = `http://localhost:${SAFARI_UPWORK_PORT}`;

export interface UpworkJob {
  id: string;
  title: string;
  description: string;
  url: string;
  budget?: string;
  score?: number;
  bid?: number;
  coverLetter?: string;
}

let _initialized = false;

export async function init(): Promise<void> {
  const up = await cloud.checkService(SAFARI_UPWORK_PORT);
  if (!up) {
    logger.warn(`[Upwork] Safari service at :${SAFARI_UPWORK_PORT} is DOWN`);
  } else {
    logger.info(`[Upwork] Safari service UP at :${SAFARI_UPWORK_PORT}`);
  }
  _initialized = true;
}

export async function scanJobs(keywords: string[], limit = 20): Promise<UpworkJob[]> {
  if (!_initialized) await init();
  try {
    const res = await fetch(`${BASE}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keywords, limit }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Scan failed: ${res.status}`);
    return res.json() as Promise<UpworkJob[]>;
  } catch (e) {
    logger.error(`[Upwork] scanJobs error: ${(e as Error).message}`);
    return [];
  }
}

export async function buildProposal(job: UpworkJob): Promise<UpworkJob> {
  const coverLetter = await generateCoverLetter({
    title: job.title,
    description: job.description,
    budget: job.budget,
  });
  return { ...job, coverLetter };
}

export async function submitProposal(job: UpworkJob): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: job.id, coverLetter: job.coverLetter, bid: job.bid }),
      signal: AbortSignal.timeout(30000),
    });
    return res.ok;
  } catch (e) {
    logger.error(`[Upwork] submitProposal error: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Full cycle: scan → score → build cover letter → Telegram approval → submit
 */
export async function runProposalCycle(keywords: string[], threshold = 7): Promise<void> {
  logger.info("[Upwork] Starting proposal cycle");

  const jobs = await scanJobs(keywords);
  logger.info(`[Upwork] Found ${jobs.length} jobs`);

  for (const job of jobs.filter((j) => (j.score || 0) >= threshold)) {
    const proposal = await buildProposal(job);
    await cloud.saveProposal({
      jobId: proposal.id, title: proposal.title, url: proposal.url,
      score: proposal.score || 0, bid: proposal.bid || 0,
      coverLetter: proposal.coverLetter || "", status: "queued",
    });
    obsidian.logProposal({ title: proposal.title, score: proposal.score || 0, bid: proposal.bid || 0 }, "queued");

    await tg.sendForApproval({
      id: proposal.id, type: "proposal",
      title: `Upwork: ${proposal.title}`,
      preview: proposal.coverLetter || "(no cover letter)",
    });

    const { approved } = await tg.waitForApproval(proposal.id, "upwork");

    if (approved) {
      const ok = await submitProposal(proposal);
      const status = ok ? "submitted" : "error";
      await cloud.updateProposalStatus(proposal.id, status);
      obsidian.logProposal({ title: proposal.title, score: proposal.score || 0, bid: proposal.bid || 0 }, status);
      await tg.notify(ok ? `🚀 Upwork proposal submitted: ${proposal.title}` : `❌ Submission failed: ${proposal.title}`);
    } else {
      await cloud.updateProposalStatus(proposal.id, "skipped");
      obsidian.logProposal({ title: proposal.title, score: proposal.score || 0, bid: proposal.bid || 0 }, "skipped");
    }
  }

  logger.info("[Upwork] Proposal cycle complete");
}
