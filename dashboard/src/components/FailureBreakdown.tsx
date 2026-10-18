/**
 * Failure-reason rollup. Shows how the queue is bleeding (expired vs already_applied vs
 * validation_error vs cloudflare_blocked vs real generic errors) so we can see at a glance
 * whether the agent is healthy or stuck on a specific failure mode.
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";

const SINCE_OPTIONS: Array<{ key: string; label: string }> = [
  { key: "1h",  label: "1h" },
  { key: "6h",  label: "6h" },
  { key: "24h", label: "24h" },
  { key: "7d",  label: "7d" },
];

type Tone = "good" | "neutral" | "warn" | "bad";

const KEY_TO_TONE: Record<string, Tone> = {
  submitted: "good",
  won: "good",
  interviewed: "good",
  pending: "neutral",
  queued: "neutral",
  auto_sending: "neutral",
  below_threshold: "neutral",
  excluded: "neutral",
  rejected: "warn",
  no_response: "warn",
  expired: "warn",
  already_applied: "warn",
  validation_error: "bad",
  cloudflare_blocked: "bad",
  error_no_cover_letter: "bad",
  error_low_connects: "bad",
  error_bid: "bad",
  error_puppeteer: "bad",
  error_generic: "bad",
};

const TONE_BG: Record<Tone, string> = {
  good: "var(--good-soft)",
  neutral: "var(--accent-soft)",
  warn: "var(--warn-soft)",
  bad: "var(--bad-soft)",
};
const TONE_FG: Record<Tone, string> = {
  good: "var(--good)",
  neutral: "var(--text)",
  warn: "var(--warn)",
  bad: "var(--bad)",
};

export function FailureBreakdown() {
  const [since, setSince] = useState("24h");
  const [data, setData] = useState<{ buckets: Record<string, number>; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.failureBreakdown(since);
      setData({ buckets: r.buckets, total: r.total });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [since]);
  useEffect(() => {
    const t = setInterval(load, 30_000); // auto-refresh every 30s
    return () => clearInterval(t);
    // eslint-disable-next-line
  }, [since]);

  if (error) return <div className="error">Failure breakdown error: {error}</div>;
  if (!data) return <div className="empty">Loading failure breakdown…</div>;

  const entries = Object.entries(data.buckets).filter(([, v]) => v > 0);
  if (entries.length === 0) {
    return (
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <strong>Failure breakdown</strong>
          <SinceSwitcher since={since} setSince={setSince} loading={loading} />
        </div>
        <div className="empty">No proposals in the last {since}.</div>
      </div>
    );
  }

  // Sort: bad first, then warn, then neutral, then good — operators want errors top
  const toneOrder: Tone[] = ["bad", "warn", "neutral", "good"];
  entries.sort((a, b) => {
    const ta = KEY_TO_TONE[a[0]] || "neutral";
    const tb = KEY_TO_TONE[b[0]] || "neutral";
    return toneOrder.indexOf(ta) - toneOrder.indexOf(tb) || b[1] - a[1];
  });

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <strong>Failure breakdown · last {since}</strong>
        <SinceSwitcher since={since} setSince={setSince} loading={loading} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8 }}>
        {entries.map(([k, v]) => {
          const tone = KEY_TO_TONE[k] || "neutral";
          const pct = data.total > 0 ? Math.round((v / data.total) * 100) : 0;
          return (
            <div key={k} style={{
              padding: "10px 12px",
              borderRadius: 6,
              background: TONE_BG[tone],
              color: TONE_FG[tone],
              border: "1px solid var(--border)",
            }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.85 }}>
                {k.replace(/_/g, " ")}
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>{v}</div>
              <div style={{ fontSize: 11, opacity: 0.75 }}>{pct}%</div>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-dim)" }}>
        {data.total} proposals total · auto-refresh 30s
      </div>
    </div>
  );
}

function SinceSwitcher({ since, setSince, loading }: { since: string; setSince: (s: string) => void; loading: boolean }) {
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      {SINCE_OPTIONS.map(opt => (
        <button
          key={opt.key}
          className={`btn ${since === opt.key ? "btn-primary" : ""}`}
          style={{ padding: "4px 10px", fontSize: 12 }}
          onClick={() => setSince(opt.key)}
          disabled={loading}
        >{opt.label}</button>
      ))}
    </div>
  );
}
