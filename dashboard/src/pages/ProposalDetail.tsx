import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, scoreClass, SLOT_ORDER, type ProposalRow, type ClickStatRow } from "../lib/api";

function fmtSec(s: number | null): string {
  if (s === null) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function diffSec(a: string | undefined, b: string | undefined): number | null {
  if (!a || !b) return null;
  const t = (new Date(b).getTime() - new Date(a).getTime()) / 1000;
  return Number.isFinite(t) && t >= 0 ? Math.round(t) : null;
}

function SpeedMetadata({ row }: { row: ProposalRow }) {
  const cells: Array<{ label: string; value: string; tone?: "good" | "neutral" }> = [];
  const tps = diffSec(row.posted_at, row.submitted_at);
  const tss = diffSec(row.created_at, row.submitted_at);
  const tfv = diffSec(row.submitted_at, row.viewed_at);
  if (tps !== null) cells.push({ label: "Time from post → submit", value: fmtSec(tps), tone: tps < 600 ? "good" : "neutral" });
  if (tss !== null) cells.push({ label: "Time from scrape → submit", value: fmtSec(tss) });
  if (row.proposals_when_submitted != null) {
    cells.push({ label: "Proposals when submitted", value: String(row.proposals_when_submitted), tone: row.proposals_when_submitted < 5 ? "good" : "neutral" });
  }
  if (row.submitted_connects_cost != null) cells.push({ label: "Connects spent", value: `${row.submitted_connects_cost}c` });
  if (row.posted_at) cells.push({ label: "Posted", value: new Date(row.posted_at).toLocaleString() });
  if (row.submitted_at) cells.push({ label: "Submitted", value: new Date(row.submitted_at).toLocaleString() });
  if (row.viewed_at) cells.push({ label: "First viewed", value: new Date(row.viewed_at).toLocaleString(), tone: "good" });
  if (tfv !== null) cells.push({ label: "Time to first view", value: fmtSec(tfv), tone: "good" });
  if (cells.length === 0) return null;
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Speed & spend</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
        {cells.map(c => (
          <div key={c.label} style={{
            padding: "10px 12px",
            background: c.tone === "good" ? "var(--good-soft)" : "var(--panel-2)",
            color: c.tone === "good" ? "var(--good)" : "var(--text)",
            borderRadius: 6,
            border: "1px solid var(--border)",
          }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.85 }}>{c.label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>{c.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const SLOT_LABEL: Record<typeof SLOT_ORDER[number], string> = {
  problem: "Problem framing",
  solution: "Solution approach",
  proof: "Proof element",
  portfolio: "Portfolio link",
  prior_results: "Prior results",
  cta: "Call to action",
};

export function ProposalDetail() {
  const { jobId = "" } = useParams();
  const [row, setRow] = useState<ProposalRow | null>(null);
  const [clicks, setClicks] = useState<ClickStatRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  async function refresh() {
    try {
      const [p, c] = await Promise.all([
        api.getProposal(jobId),
        api.clicks(jobId).catch(() => ({ count: 0, rows: [] as ClickStatRow[] })),
      ]);
      setRow(p.proposals[0] || null);
      setClicks(c.rows);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [jobId]);

  async function record(outcome: "won" | "rejected" | "no_response" | "interviewed") {
    if (!confirm(`Record outcome: ${outcome}?`)) return;
    setActing(true);
    try {
      await api.recordOutcome(jobId, outcome);
      await refresh();
    } catch (e) {
      alert(`Failed: ${(e as Error).message}`);
    } finally {
      setActing(false);
    }
  }

  if (error) return <div className="error">{error}</div>;
  if (!row) return <div className="empty">Loading…</div>;

  const slots = row.proposal_slots_json || {};

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <Link to="/queue" className="btn">← Queue</Link>
      </div>

      <div className="card">
        <div className="card-header">
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: "0 0 6px" }}>{row.job_title}</h2>
            <div className="card-meta">
              {row.score != null && <span className={`score-badge ${scoreClass(row.score)}`}>{row.score}/10</span>}
              {row.budget && <span>💰 {row.budget}</span>}
              {row.submitted_bid_amount && <span>Bid ${row.submitted_bid_amount}</span>}
              {row.client_hire_rate != null && <span>Hire {row.client_hire_rate}%</span>}
              <span>Status: {row.status}</span>
              {row.tags && row.tags.length > 0 && <span>🏷 {row.tags.join(", ")}</span>}
              <a href={row.job_url} target="_blank" rel="noreferrer">↗ View on Upwork</a>
            </div>
          </div>
        </div>
        {row.reasoning && <p style={{ color: "var(--text-dim)", margin: "8px 0" }}>{row.reasoning}</p>}
      </div>

      {/* Speed + spend metadata: directly answers "did we get there fast and what did it cost?".
          Each card is omitted when the underlying field is null so we don't show a wall of em-dashes. */}
      <SpeedMetadata row={row} />

      {row.job_description && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Scraped job description</h3>
          <div className="cover-letter" style={{ maxHeight: 360 }}>{row.job_description}</div>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Proposal beats</h3>
        {SLOT_ORDER.map(name => {
          const value = (slots[name] || "").trim();
          return (
            <div key={name} className="slot-section">
              <h4>{SLOT_LABEL[name]}</h4>
              <div className={`body ${!value ? "missing" : ""}`}>{value || "— missing —"}</div>
            </div>
          );
        })}
      </div>

      {row.proposal_text && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Rendered cover letter</h3>
          <div className="cover-letter">{row.proposal_text}</div>
        </div>
      )}

      {clicks.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Tracked links</h3>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Label</th>
                <th>Target</th>
                <th>Clicks</th>
                <th>Last clicked</th>
              </tr>
            </thead>
            <tbody>
              {clicks.map(c => (
                <tr key={c.slug}>
                  <td>{c.link_type}</td>
                  <td>{c.label || "—"}</td>
                  <td><a href={c.target_url} target="_blank" rel="noreferrer">{c.target_url.slice(0, 60)}{c.target_url.length > 60 ? "…" : ""}</a></td>
                  <td>{c.click_count}</td>
                  <td>{c.last_clicked_at ? new Date(c.last_clicked_at).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Record outcome</h3>
        <div className="actions">
          <button className="btn btn-good" disabled={acting} onClick={() => record("won")}>Won</button>
          <button className="btn" disabled={acting} onClick={() => record("interviewed")}>Interviewed</button>
          <button className="btn btn-bad" disabled={acting} onClick={() => record("rejected")}>Rejected</button>
          <button className="btn" disabled={acting} onClick={() => record("no_response")}>No response</button>
        </div>
        {row.outcome_at && <p style={{ color: "var(--text-dim)", marginTop: 8, fontSize: 12 }}>Outcome recorded: {new Date(row.outcome_at).toLocaleString()}</p>}
      </div>
    </>
  );
}
