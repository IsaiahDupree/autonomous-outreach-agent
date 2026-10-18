/**
 * A/B variant performance leaderboard. Each row is a (niche, variant_name) pair pulled from
 * upwork_proposals.variant_niche/variant_name. Rows tagged "(default)" are the baseline —
 * proposals that ran with no variant fragment for that niche. Use side-by-side win/response
 * rates to decide whether a variant is actually beating the default before promoting it.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

type VariantRow = {
  niche: string;
  variant: string;
  submissions: number;
  won: number;
  rejected: number;
  no_response: number;
  interviewed: number;
  win_rate: number | null;
  response_rate: number | null;
  is_default: boolean;
};

function fmtPct(p: number | null): string {
  if (p === null) return "—";
  return `${Math.round(p * 100)}%`;
}

export function VariantPerformance() {
  const [rows, setRows] = useState<VariantRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.variantPerformance();
      setRows(r.variants);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, VariantRow[]>();
    for (const r of rows) {
      const arr = map.get(r.niche) || [];
      arr.push(r);
      map.set(r.niche, arr);
    }
    // Sort niches by total submissions desc.
    return Array.from(map.entries())
      .sort((a, b) => {
        const totalA = a[1].reduce((s, x) => s + x.submissions, 0);
        const totalB = b[1].reduce((s, x) => s + x.submissions, 0);
        return totalB - totalA;
      });
  }, [rows]);

  if (error) return <div className="error">Variant performance error: {error}</div>;
  if (rows.length === 0 && !loading) {
    return (
      <div className="card">
        <strong>Variant performance leaderboard</strong>
        <div className="empty">No submitted proposals yet — define A/B variants on the Templates page and submit a few proposals to see results.</div>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 0 }}>
      <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>Variant performance leaderboard</strong>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>auto-refresh 60s</span>
      </div>
      {grouped.map(([niche, variants]) => {
        const defaultRow = variants.find(v => v.is_default);
        const defaultWin = defaultRow?.win_rate ?? null;
        return (
          <div key={niche} style={{ padding: "10px 18px 14px", borderBottom: "1px solid var(--border, #e3e0d4)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{niche}</div>
            <table style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th>Variant</th>
                  <th>Subs</th>
                  <th>Win rate</th>
                  <th>Response rate</th>
                  <th>Δ vs default</th>
                  <th>Outcomes</th>
                </tr>
              </thead>
              <tbody>
                {variants.map(v => {
                  const delta = (v.win_rate != null && defaultWin != null && !v.is_default)
                    ? Math.round((v.win_rate - defaultWin) * 100)
                    : null;
                  return (
                    <tr key={v.variant}>
                      <td>
                        {v.is_default
                          ? <span style={{ color: "var(--text-dim)", fontStyle: "italic" }}>{v.variant}</span>
                          : <strong>{v.variant}</strong>}
                      </td>
                      <td>{v.submissions}</td>
                      <td>{fmtPct(v.win_rate)}</td>
                      <td>{fmtPct(v.response_rate)}</td>
                      <td style={{
                        color: delta == null ? "var(--text-dim)" : delta > 0 ? "var(--ok, #2e7d32)" : delta < 0 ? "var(--err, #c62828)" : "var(--text-dim)",
                      }}>
                        {delta == null ? "—" : `${delta > 0 ? "+" : ""}${delta} pts`}
                      </td>
                      <td style={{ fontSize: 12, color: "var(--text-dim)" }}>
                        {v.won}W · {v.interviewed}I · {v.rejected}R · {v.no_response}NR
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
