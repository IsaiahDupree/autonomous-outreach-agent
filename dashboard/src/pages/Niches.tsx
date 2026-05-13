import { useEffect, useState } from "react";
import { api, type NicheRow } from "../lib/api";
import { FailureBreakdown } from "../components/FailureBreakdown";
import { NicheSpeed } from "../components/NicheSpeed";
import { ClickFunnel } from "../components/ClickFunnel";
import { VariantPerformance } from "../components/VariantPerformance";

function pct(v: number | null): string {
  if (v == null) return "—";
  return `${Math.round(v * 100)}%`;
}

export function Niches() {
  const [rows, setRows] = useState<NicheRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.niches();
      setRows(r.rows);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function recompute() {
    if (!confirm("Recompute niche stats from all outcomed proposals? Takes a few seconds.")) return;
    setRefreshing(true);
    try {
      const r = await api.refreshReinforcement();
      alert(`Updated ${r.updated} niches, skipped ${r.skipped} (below sample threshold).`);
      await load();
    } catch (e) {
      alert(`Refresh failed: ${(e as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <>
      <FailureBreakdown />
      <div style={{ marginTop: 24, marginBottom: 24 }}>
        <NicheSpeed />
      </div>
      <div style={{ marginBottom: 24 }}>
        <ClickFunnel />
      </div>
      <div style={{ marginBottom: 24 }}>
        <VariantPerformance />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, marginTop: 24 }}>
        <h2>Niche performance</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={load} disabled={loading}>Reload</button>
          <button className="btn btn-primary" onClick={recompute} disabled={refreshing}>
            {refreshing ? "Recomputing…" : "Recompute from outcomes"}
          </button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {!loading && rows.length === 0 && (
        <div className="empty">
          No niche stats yet. Each niche needs at least 5 outcomed proposals (won + rejected + no_response + interviewed) before it shows up here.
          <br />Click "Recompute from outcomes" once you've recorded enough outcomes.
        </div>
      )}

      {rows.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Niche</th>
                <th>Win rate</th>
                <th>Response rate</th>
                <th>Sample</th>
                <th>W</th>
                <th>L</th>
                <th>NR</th>
                <th>Int</th>
                <th>Avg win bid</th>
                <th>Avg loss bid</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.niche}>
                  <td><strong>{r.niche}</strong></td>
                  <td>{pct(r.win_rate)}</td>
                  <td>{pct(r.response_rate)}</td>
                  <td>{r.sample_count}</td>
                  <td>{r.won_count}</td>
                  <td>{r.lost_count}</td>
                  <td>{r.no_response_count}</td>
                  <td>{r.interviewed_count}</td>
                  <td>{r.avg_win_bid != null ? `$${r.avg_win_bid}` : "—"}</td>
                  <td>{r.avg_loss_bid != null ? `$${r.avg_loss_bid}` : "—"}</td>
                  <td style={{ color: "var(--text-dim)", fontSize: 12 }}>{r.updated_at ? new Date(r.updated_at).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.some(r => r.winning_patterns) && (
        <div style={{ marginTop: 24 }}>
          <h3>Winning patterns by niche</h3>
          {rows.filter(r => r.winning_patterns).map(r => (
            <div key={r.niche} className="card">
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{r.niche}</div>
              <div style={{ color: "var(--text-dim)", fontSize: 13 }}>{r.winning_patterns}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
