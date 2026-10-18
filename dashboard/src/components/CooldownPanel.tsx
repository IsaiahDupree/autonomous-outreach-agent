/**
 * Failure-cooldown panel: lists jobs the submitter has temporarily parked after a failed
 * attempt (hard timeout, validation error, expired listing, etc). Each job sits out for the
 * window_minutes interval, then becomes eligible again. Use this to see at a glance which
 * jobs are stuck looping vs which are simply waiting to retry.
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";

type CooldownJob = { jobId: string; reason: string; age_sec: number };

function fmtAge(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

const REASON_LABELS: Record<string, string> = {
  hard_timeout: "Hard timeout (90s)",
  job_not_found: "Job not found / expired",
  apply_disabled: "Apply button disabled",
  cloudflare: "Cloudflare block",
  validation_error: "Form validation error",
  no_cover_letter: "Empty cover letter",
  low_connects: "Low connects",
  bid_out_of_range: "Bid out of range",
  puppeteer_error: "Browser error",
  unknown: "Unknown",
};

export function CooldownPanel() {
  const [data, setData] = useState<{ count: number; window_minutes: number; jobs: CooldownJob[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const r = await api.cooldown();
      setData(r);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  if (error) return <div className="error" style={{ marginBottom: 16 }}>Cooldown error: {error}</div>;
  if (!data || data.count === 0) return null;

  return (
    <div className="card" style={{ marginBottom: 16, padding: 0 }}>
      <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>⏸ Failure cooldown ({data.count})</strong>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
          {data.window_minutes}-min window · auto-refresh 15s
        </span>
      </div>
      <table style={{ width: "100%", fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Job ID</th>
            <th style={{ textAlign: "left" }}>Reason</th>
            <th>Failed</th>
            <th>Eligible in</th>
          </tr>
        </thead>
        <tbody>
          {data.jobs.map(j => {
            const eligibleSec = Math.max(0, data.window_minutes * 60 - j.age_sec);
            return (
              <tr key={j.jobId}>
                <td style={{ fontFamily: "monospace", fontSize: 11 }}>{j.jobId.slice(0, 12)}…</td>
                <td>{REASON_LABELS[j.reason] || j.reason}</td>
                <td style={{ color: "var(--text-dim)" }}>{fmtAge(j.age_sec)} ago</td>
                <td style={{ color: eligibleSec === 0 ? "var(--ok, #2e7d32)" : "var(--text-dim)" }}>
                  {eligibleSec === 0 ? "ready" : fmtAge(eligibleSec)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
