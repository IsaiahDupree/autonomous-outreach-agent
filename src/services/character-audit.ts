import * as fs from "fs";
import * as path from "path";
import logger from "../config/logger";

export interface CharacterAuditEntry {
  ts: string;            // ISO timestamp
  kind: "section" | "variants" | "custom-context" | "slot-prompt";
  section?: string;      // for kind=section: which key changed
  source: string;        // "dashboard" | "api" | "cli" — caller-provided
  summary: string;       // short human-readable description
  backup?: string;       // basename of .bak file if one was written
  before_size?: number;  // chars in old value (for value-level diffs)
  after_size?: number;   // chars in new value
}

const AUDIT_DIR = path.join(__dirname, "..", "Agent", "characters");
const AUDIT_PATH = path.join(AUDIT_DIR, "audit.log");
const MAX_AUDIT_LINES = 500;

export function recordCharacterEdit(entry: Omit<CharacterAuditEntry, "ts">): void {
  try {
    const full: CharacterAuditEntry = { ts: new Date().toISOString(), ...entry };
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.appendFileSync(AUDIT_PATH, JSON.stringify(full) + "\n");
  } catch (e) {
    logger.warn(`[character-audit] append failed: ${(e as Error).message}`);
  }
}

export function readCharacterAudit(limit = 100): CharacterAuditEntry[] {
  try {
    if (!fs.existsSync(AUDIT_PATH)) return [];
    const lines = fs.readFileSync(AUDIT_PATH, "utf8").split("\n").filter(Boolean);
    if (lines.length > MAX_AUDIT_LINES) {
      const trimmed = lines.slice(-MAX_AUDIT_LINES).join("\n") + "\n";
      try { fs.writeFileSync(AUDIT_PATH, trimmed); } catch { /* not fatal */ }
    }
    const recent = lines.slice(-limit).reverse();
    const out: CharacterAuditEntry[] = [];
    for (const line of recent) {
      try { out.push(JSON.parse(line) as CharacterAuditEntry); } catch { /* skip malformed */ }
    }
    return out;
  } catch (e) {
    logger.warn(`[character-audit] read failed: ${(e as Error).message}`);
    return [];
  }
}
