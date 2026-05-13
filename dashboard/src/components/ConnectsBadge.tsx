/**
 * Compact "Connects: N" badge for the top bar. Polls /api/connects every 30s. The agent
 * tracks Upwork connects through the submission flow (parses the form's connect cost line)
 * so this stays current without re-scraping. Goes red below 50, amber below 16, neutral
 * otherwise. null = "not yet observed" (shows "—" until first scrape exposes the number).
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";

export function ConnectsBadge() {
  const [data, setData] = useState<{ connects: number | null; warning: string | null } | null>(null);

  async function refresh() {
    try { setData(await api.connects()); }
    catch { /* show stale data on transient errors */ }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, []);

  if (!data) return null;
  const n = data.connects;

  let tone = "neutral";
  let tooltip = "Upwork connects remaining (parsed from the proposal form on each submit)";
  if (n != null) {
    if (n < 16) { tone = "bad"; tooltip = "Critically low — auto-submit will refuse below 20"; }
    else if (n < 50) { tone = "warn"; tooltip = "Low — buy more soon"; }
  }

  const color =
    tone === "bad" ? "var(--bad, #c62828)"
    : tone === "warn" ? "var(--warn, #c77800)"
    : "var(--text)";
  const bg =
    tone === "bad" ? "rgba(198, 40, 40, 0.12)"
    : tone === "warn" ? "rgba(199, 120, 0, 0.12)"
    : "var(--panel-2, rgba(0,0,0,0.04))";

  return (
    <div
      title={tooltip}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        marginRight: 8,
        background: bg,
        border: "1px solid var(--border)",
        borderRadius: 14,
        fontSize: 12,
        color,
        fontFamily: "ui-monospace, monospace",
      }}
    >
      <span style={{ opacity: 0.7 }}>⚡</span>
      <span>{n != null ? `${n} connects` : "— connects"}</span>
    </div>
  );
}
