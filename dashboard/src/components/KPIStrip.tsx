import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { KPI } from "./KPI";

type Metrics = {
  submitted: number; won: number; rejected: number; noResponse: number;
  closeRate: number; avgScore: number;
  windows: {
    "7d":  { submitted: number; won: number; closeRate: number };
    "30d": { submitted: number; won: number; closeRate: number };
    "90d": { submitted: number; won: number; closeRate: number };
  };
};

export function KPIStrip() {
  const [m, setM] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.metrics()
      .then(d => { if (!cancelled) setM(d as Metrics); })
      .catch(e => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <div className="error">metrics: {error}</div>;
  if (!m) return null;

  const w7 = m.windows["7d"];
  const w30 = m.windows["30d"];
  const closeRateTrend = w30.closeRate > 0 ? w7.closeRate - w30.closeRate : null;

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
      gap: 12,
      marginBottom: 16,
    }}>
      <KPI
        label="SUBMITTED · 7D"
        value={w7.submitted}
        sub={`${w30.submitted} over 30d`}
        accent="var(--accent)"
      />
      <KPI
        label="WON · 7D"
        value={w7.won}
        sub={`${w30.won} over 30d`}
        accent="var(--good)"
      />
      <KPI
        label="CLOSE RATE · 7D"
        value={`${w7.closeRate}%`}
        sub={`30d baseline ${w30.closeRate}%`}
        trend={closeRateTrend}
        accent="var(--good)"
      />
      <KPI
        label="AVG SCORE"
        value={m.avgScore.toFixed(1)}
        sub="of submitted (all-time)"
        accent="var(--accent)"
      />
      <KPI
        label="TOTAL SUBMITTED"
        value={m.submitted}
        sub={`${m.won} won · ${m.rejected} lost · ${m.noResponse} silent`}
        accent="var(--text-dim)"
      />
    </div>
  );
}
