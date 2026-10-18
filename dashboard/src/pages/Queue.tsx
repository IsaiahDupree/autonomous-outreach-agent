import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type ProposalRow } from "../lib/api";
import { SlotBadges } from "../components/SlotBadges";
import { InFlightCard } from "../components/InFlightCard";
import { CooldownPanel } from "../components/CooldownPanel";
import { KPIStrip } from "../components/KPIStrip";
import { ScoreChip } from "../components/ScoreChip";

const FILTERS = [
  { key: "queued", label: "Queued" },
  { key: "pending", label: "Awaiting Approval" },
  { key: "auto_sending", label: "Auto-sending" },
  { key: "submitted", label: "Submitted" },
  { key: "won", label: "Won" },
  { key: "rejected", label: "Rejected" },
];

function fmtRelative(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

export function Queue() {
  const [filter, setFilter] = useState<string>("queued");
  const [rows, setRows] = useState<ProposalRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpanded(jobId: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId); else next.add(jobId);
      return next;
    });
  }

  function expandAll() {
    setExpanded(new Set(rows.map(r => r.job_id)));
  }

  function collapseAll() {
    setExpanded(new Set());
  }

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.listProposals({ status: filter, limit: 100 });
      setRows(r.proposals);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter]);

  async function dryRun(jobId: string) {
    setActing(jobId);
    try {
      await api.dryRun(jobId);
      await refresh();
    } catch (e) {
      alert(`Dry run failed: ${(e as Error).message}`);
    } finally {
      setActing(null);
    }
  }

  async function submitNow(jobId: string) {
    if (!confirm("Submit this proposal to Upwork now?")) return;
    setActing(jobId);
    try {
      await api.submitOne(jobId);
      await refresh();
    } catch (e) {
      alert(`Submit failed: ${(e as Error).message}`);
    } finally {
      setActing(null);
    }
  }

  async function skip(jobId: string) {
    if (!confirm("Skip this proposal? It will be moved out of the queue.")) return;
    setActing(jobId);
    try {
      await api.skipProposal(jobId, "dashboard");
      await refresh();
    } catch (e) {
      alert(`Skip failed: ${(e as Error).message}`);
    } finally {
      setActing(null);
    }
  }

  return (
    <>
      <KPIStrip />
      <InFlightCard />
      <CooldownPanel />
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {FILTERS.map(f => (
          <button
            key={f.key}
            className={`btn ${filter === f.key ? "btn-primary" : ""}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
        <button className="btn" onClick={refresh} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
        {rows.length > 0 && (
          <>
            <button className="btn" onClick={expandAll} disabled={loading}>Expand all</button>
            <button className="btn" onClick={collapseAll} disabled={loading || expanded.size === 0}>Collapse all</button>
          </>
        )}
      </div>

      {error && <div className="error">{error}</div>}
      {!loading && !error && rows.length === 0 && <div className="empty">No proposals in this state.</div>}

      {rows.map(p => {
        const isOpen = expanded.has(p.job_id);
        return (
        <div key={p.job_id} className="card">
          <div className="card-header">
            <div>
              <div className="card-title">
                <Link to={`/proposals/${encodeURIComponent(p.job_id)}`}>{p.job_title || "(untitled)"}</Link>
              </div>
              <div className="card-meta">
                {p.score != null && <ScoreChip score={p.score} />}
                {p.budget && <span>💰 {p.budget}</span>}
                {p.submitted_bid_amount && <span>Bid ${p.submitted_bid_amount}</span>}
                {p.client_hire_rate != null && <span>Hire {p.client_hire_rate}%</span>}
                {p.posted_at && <span title={p.posted_at}>📅 Posted {fmtRelative(p.posted_at)}</span>}
                {p.tags && p.tags.length > 0 && <span>🏷 {p.tags.slice(0, 4).join(", ")}</span>}
                <a href={p.job_url} target="_blank" rel="noreferrer">↗ Upwork</a>
              </div>
              <SlotBadges slots={p.proposal_slots_json} />
            </div>
          </div>
          {p.reasoning && <div style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 4 }}>{p.reasoning}</div>}

          <button
            className="btn"
            onClick={() => toggleExpanded(p.job_id)}
            style={{ marginTop: 8, fontSize: 12, padding: "4px 10px" }}
            aria-expanded={isOpen}
          >
            {isOpen ? "▴ Hide details" : "▾ Show details"}
          </button>

          {isOpen && (
            <div className="job-details" style={{
              marginTop: 10,
              padding: 12,
              background: "var(--bg-soft, #f7f6f1)",
              border: "1px solid var(--border, #e3e0d4)",
              borderRadius: 6,
              fontSize: 13,
            }}>
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: "6px 14px",
                marginBottom: 10,
                color: "var(--text-dim)",
              }}>
                {p.budget && <div><strong>Budget:</strong> {p.budget}</div>}
                {p.posted_at && <div><strong>Posted:</strong> {fmtRelative(p.posted_at)}</div>}
                {p.created_at && <div><strong>Scraped:</strong> {fmtRelative(p.created_at)}</div>}
                {p.submitted_at && <div><strong>Submitted:</strong> {fmtRelative(p.submitted_at)}</div>}
                {p.viewed_at && <div><strong>Viewed:</strong> {fmtRelative(p.viewed_at)}</div>}
                {p.client_hire_rate != null && <div><strong>Client hire rate:</strong> {p.client_hire_rate}%</div>}
                {p.competitive_bid_avg != null && <div><strong>Avg competing bid:</strong> ${p.competitive_bid_avg}</div>}
                {p.proposals_when_submitted != null && <div><strong>Proposals at submit:</strong> {p.proposals_when_submitted}</div>}
                {p.submitted_connects_cost != null && <div><strong>Connects spent:</strong> {p.submitted_connects_cost}</div>}
                {p.pre_score != null && <div><strong>Pre-score:</strong> {p.pre_score}</div>}
              </div>

              {p.tags && p.tags.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <strong style={{ fontSize: 12 }}>Tags:</strong>{" "}
                  {p.tags.map(t => (
                    <span key={t} style={{
                      display: "inline-block",
                      padding: "2px 8px",
                      margin: "2px 4px 2px 0",
                      background: "var(--accent-soft, #ece9d8)",
                      borderRadius: 10,
                      fontSize: 11,
                    }}>{t}</span>
                  ))}
                </div>
              )}

              {p.job_description ? (
                <div>
                  <strong style={{ fontSize: 12, display: "block", marginBottom: 4 }}>Job description (scraped):</strong>
                  <div style={{
                    whiteSpace: "pre-wrap",
                    maxHeight: 320,
                    overflow: "auto",
                    padding: 10,
                    background: "var(--bg, #fff)",
                    border: "1px solid var(--border, #e3e0d4)",
                    borderRadius: 4,
                    lineHeight: 1.5,
                  }}>{p.job_description}</div>
                </div>
              ) : (
                <div style={{ color: "var(--text-dim)", fontStyle: "italic" }}>No scraped description on file.</div>
              )}

              {p.proof_artifact_url && (
                <div style={{ marginTop: 10 }}>
                  <strong style={{ fontSize: 12 }}>Proof artifact:</strong>{" "}
                  <a href={p.proof_artifact_url} target="_blank" rel="noreferrer">{p.proof_artifact_url}</a>
                </div>
              )}
            </div>
          )}

          {p.proposal_text && <div className="cover-letter">{p.proposal_text}</div>}
          <div className="actions">
            <Link to={`/proposals/${encodeURIComponent(p.job_id)}`} className="btn">Open</Link>
            {(p.status === "queued" || p.status === "pending") && (
              <>
                <button className="btn" onClick={() => dryRun(p.job_id)} disabled={acting === p.job_id}>Dry-run</button>
                <button className="btn btn-primary" onClick={() => submitNow(p.job_id)} disabled={acting === p.job_id}>
                  {acting === p.job_id ? "Submitting…" : "Approve"}
                </button>
                <button className="btn" onClick={() => skip(p.job_id)} disabled={acting === p.job_id}>
                  Skip
                </button>
              </>
            )}
          </div>
        </div>
        );
      })}
    </>
  );
}
