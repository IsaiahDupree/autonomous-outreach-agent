/**
 * Click → response → win funnel. Three views in one component:
 *   1. Top-line funnel:  submitted → clicked → responded → won  (counts + rates)
 *   2. Time-to-first-click headline number
 *   3. Per-niche CTR by link type (which link types convert in which niches)
 *
 * Tells the operator whether tracked URLs in proposals actually do work, and which link types
 * (portfolio / proof / showcase / github / youtube) are pulling their weight per niche.
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";

type FunnelData = Awaited<ReturnType<typeof api.clickFunnel>>;

function fmtSec(s: number | null): string {
  if (s === null) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function fmtPct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

export function ClickFunnel() {
  const [data, setData] = useState<FunnelData | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      setData(await api.clickFunnel());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  if (error) return <div className="error">Click funnel error: {error}</div>;
  if (!data) return <div className="empty">Loading click funnel…</div>;

  const f = data.funnel;
  const stages = [
    { label: "Submitted", value: f.submitted, rate: 1 },
    { label: "Got a click", value: f.clicked, rate: f.click_rate },
    { label: "Got a response", value: f.responded, rate: f.response_rate },
    { label: "Won", value: f.won, rate: f.win_rate },
  ];

  // Niches with at least one click — sort by win_rate desc
  const nichesWithSignal = data.niches
    .filter(n => n.submitted >= 1)
    .sort((a, b) => b.win_rate - a.win_rate || b.clicked - a.clicked);

  return (
    <div className="card" style={{ padding: 0 }}>
      <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)" }}>
        <strong>Click → response → win funnel</strong>
        <span style={{ marginLeft: 12, fontSize: 12, color: "var(--text-dim)" }}>auto-refresh 30s</span>
      </div>
      <div style={{ padding: 18, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        {stages.map(s => (
          <div key={s.label} style={{
            padding: "12px 14px",
            background: "var(--panel-2)",
            borderRadius: 6,
            border: "1px solid var(--border)",
          }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text-dim)" }}>{s.label}</div>
            <div style={{ fontSize: 26, fontWeight: 700, marginTop: 2 }}>{s.value}</div>
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{s.rate < 1 ? `${fmtPct(s.rate)} of submitted` : "100%"}</div>
          </div>
        ))}
        <div style={{ padding: "12px 14px", background: "var(--accent-soft)", borderRadius: 6, border: "1px solid var(--border)" }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--accent-hover)" }}>Median time to first click</div>
          <div style={{ fontSize: 26, fontWeight: 700, marginTop: 2, color: "var(--accent-hover)" }}>{fmtSec(f.median_time_to_first_click_sec)}</div>
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>after submission</div>
        </div>
      </div>
      {nichesWithSignal.length > 0 && (
        <>
          <div style={{ padding: "12px 18px", borderTop: "1px solid var(--border)", fontSize: 13, fontWeight: 600 }}>
            CTR by niche & link type
          </div>
          <table>
            <thead>
              <tr>
                <th>Niche</th>
                <th>Subs</th>
                <th>Click rate</th>
                <th>Response rate</th>
                <th>Win rate</th>
                <th>t→click</th>
                <th>CTR by link type</th>
              </tr>
            </thead>
            <tbody>
              {nichesWithSignal.map(n => (
                <tr key={n.niche}>
                  <td><strong>{n.niche}</strong></td>
                  <td>{n.submitted}</td>
                  <td>{fmtPct(n.click_rate)}</td>
                  <td>{fmtPct(n.response_rate)}</td>
                  <td>{fmtPct(n.win_rate)}</td>
                  <td>{fmtSec(n.median_time_to_first_click_sec)}</td>
                  <td style={{ fontSize: 12 }}>
                    {Object.entries(n.ctr_by_link_type).length === 0 ? (
                      <span style={{ color: "var(--text-dim)" }}>—</span>
                    ) : (
                      Object.entries(n.ctr_by_link_type).map(([type, v]) => (
                        <span key={type} style={{ marginRight: 10 }}>
                          <strong>{type}</strong>: {v.clicks}/{v.impressions} ({fmtPct(v.rate)})
                        </span>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
