/**
 * Per-niche speed leaderboard. Surfaces median time-to-submit, win rate, response rate, avg
 * connect cost, and median competing-proposals — i.e. the data needed to decide which niches
 * are profitable to keep on fast-poll vs which to drop.
 */
import { useEffect, useState } from "react";
import { api, type NicheSpeedRow } from "../lib/api";

function fmtSec(s: number | null): string {
  if (s === null) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function fmtPct(p: number | null): string {
  if (p === null) return "—";
  return `${Math.round(p * 100)}%`;
}

export function NicheSpeed() {
  const [rows, setRows] = useState<NicheSpeedRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.nicheSpeed();
      setRows(r.niches);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  if (error) return <div className="error">Niche speed error: {error}</div>;
  if (rows.length === 0 && !loading) {
    return (
      <div className="card">
        <strong>Niche speed leaderboard</strong>
        <div className="empty">No submitted proposals yet — submit a few to see niche speed metrics.</div>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 0 }}>
      <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>Niche speed leaderboard</strong>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>auto-refresh 30s</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Niche</th>
            <th>Subs</th>
            <th>Median t→submit (post)</th>
            <th>Median t→submit (scrape)</th>
            <th>Median # competing</th>
            <th>Avg connects</th>
            <th>Win rate</th>
            <th>Response rate</th>
            <th>Outcomes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.niche}>
              <td><strong>{r.niche}</strong></td>
              <td>{r.submissions}</td>
              <td>{fmtSec(r.median_time_to_submit_sec)}</td>
              <td>{fmtSec(r.median_time_from_scrape_sec)}</td>
              <td>{r.median_proposals_when_submitted ?? "—"}</td>
              <td>{r.avg_connects != null ? `${r.avg_connects}c` : "—"}</td>
              <td>{fmtPct(r.win_rate)}</td>
              <td>{fmtPct(r.response_rate)}</td>
              <td style={{ fontSize: 12, color: "var(--text-dim)" }}>
                {r.won}W · {r.interviewed}I · {r.rejected}R · {r.no_response}NR
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
