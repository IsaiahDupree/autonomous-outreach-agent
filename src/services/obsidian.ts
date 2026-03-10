/**
 * src/services/obsidian.ts — Obsidian vault logging
 */
import fs from "fs";
import path from "path";
import { OBSIDIAN_VAULT } from "../secret";
import logger from "../config/logger";

function today(): string { return new Date().toISOString().split("T")[0]; }
function ensureDir(dir: string): void { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

export function appendDailyNote(bullet: string): void {
  if (!OBSIDIAN_VAULT) return;
  try {
    const dir = path.join(OBSIDIAN_VAULT, "DAILY-NOTES");
    ensureDir(dir);
    fs.appendFileSync(path.join(dir, `${today()}.md`), `- ${new Date().toLocaleTimeString()} ${bullet}\n`);
  } catch { /* vault not mounted */ }
}

export function logProposal(job: { title: string; score: number; bid: number }, event: string): void {
  const e = { queued: "📋", approved: "✅", skipped: "❌", submitted: "🚀", won: "🏆" }[event] || "📌";
  appendDailyNote(`${e} Upwork ${event}: *${job.title}* (score ${job.score}/10, $${job.bid})`);
}

export function logProspect(prospect: { displayName?: string; username?: string; icpScore?: number }, event: string): void {
  appendDailyNote(`🔍 Chrome ${event}: *${prospect.displayName || prospect.username}* ICP ${prospect.icpScore}/10`);
}

export function createWonJobNote(job: { title: string; budget?: number; url?: string; coverLetter?: string }): void {
  if (!OBSIDIAN_VAULT) return;
  try {
    const dir = path.join(OBSIDIAN_VAULT, "Upwork");
    ensureDir(dir);
    const slug = job.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
    const file = path.join(dir, `${today()}-${slug}.md`);
    fs.writeFileSync(file, [
      `# ${job.title}`, ``, `**Date:** ${today()}`,
      `**Budget:** $${job.budget || "TBD"}`, `**URL:** ${job.url || ""}`,
      ``, `## Cover Letter`, ``, job.coverLetter || "_none_",
    ].join("\n"));
    appendDailyNote(`🏆 WON: [[Upwork/${today()}-${slug}]]`);
  } catch { /* non-critical */ }
}
