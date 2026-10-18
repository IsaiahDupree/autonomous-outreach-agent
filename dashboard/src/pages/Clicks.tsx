import { useEffect, useMemo, useState } from "react";
import { api, type ClickStatRow } from "../lib/api";

const TYPES = ["all", "portfolio", "proof", "showcase", "github", "youtube"];

export function Clicks() {
  const [rows, setRows] = useState<ClickStatRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState("all");
  const [search, setSearch] = useState("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.clicks();
      setRows(r.rows);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (type !== "all" && r.link_type !== type) return false;
      if (q && !`${r.target_url} ${r.label || ""} ${r.niche || ""} ${r.job_id || ""}`.toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => b.click_count - a.click_count);
  }, [rows, type, search]);

  const totalClicks = filtered.reduce((sum, r) => sum + r.click_count, 0);
  const linksWithClicks = filtered.filter(r => r.click_count > 0).length;

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Click tracking</h2>
        <div style={{ color: "var(--text-dim)", fontSize: 13 }}>
          {filtered.length} links · {linksWithClicks} clicked · {totalClicks} total clicks
        </div>
        <button className="btn" onClick={load} disabled={loading}>Reload</button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {TYPES.map(t => (
          <button key={t} className={`btn ${type === t ? "btn-primary" : ""}`} onClick={() => setType(t)}>{t}</button>
        ))}
        <input
          type="search"
          placeholder="Search target / label / niche / jobId…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 240 }}
        />
      </div>

      {error && <div className="error">{error}</div>}
      {!loading && filtered.length === 0 && <div className="empty">No tracked links yet — proposals need to ship with shortlinks first.</div>}

      {filtered.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Label / Niche</th>
                <th>Target</th>
                <th>Job</th>
                <th>Clicks</th>
                <th>Last clicked</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.slug}>
                  <td>{r.link_type}</td>
                  <td>
                    {r.label || "—"}
                    {r.niche && <span style={{ color: "var(--text-dim)", marginLeft: 6 }}>({r.niche})</span>}
                  </td>
                  <td>
                    <a href={r.target_url} target="_blank" rel="noreferrer">
                      {r.target_url.length > 60 ? r.target_url.slice(0, 60) + "…" : r.target_url}
                    </a>
                  </td>
                  <td>
                    {r.job_id
                      ? <a href={`/proposals/${encodeURIComponent(r.job_id)}`}>{r.job_id.slice(0, 12)}…</a>
                      : "—"}
                  </td>
                  <td><strong>{r.click_count}</strong></td>
                  <td style={{ color: "var(--text-dim)" }}>{r.last_clicked_at ? new Date(r.last_clicked_at).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
