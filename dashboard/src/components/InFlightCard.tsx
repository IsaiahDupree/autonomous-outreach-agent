/**
 * Live "submitting now" card. Polls /api/agent/in-flight every 2 seconds. Shows a slim card
 * with the current submission's job title, the step the agent is on (navigating / form_open /
 * filling / submitting / verifying / boosting), and elapsed time at both job and step level.
 *
 * When idle (no submission in flight), the component renders nothing so it doesn't add chrome
 * to the dashboard between submissions.
 */
import { useEffect, useState } from "react";
import { api, type InFlightState } from "../lib/api";

const STEP_LABEL: Record<InFlightState["step"], string> = {
  starting:   "Starting",
  navigating: "Navigating to job",
  cloudflare: "Solving Cloudflare",
  applying:   "Clicking Apply",
  form_open:  "Form opened",
  filling:    "Filling form",
  submitting: "Submitting",
  verifying:  "Verifying on proposals page",
  boosting:   "Boost modal",
};

export function InFlightCard() {
  const [state, setState] = useState<InFlightState | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const r = await api.inFlight();
        if (!cancelled) setState(r.in_flight);
      } catch { if (!cancelled) setState(null); }
    }
    tick();
    const t = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (!state) return null;

  const stepHot = state.step_elapsed_sec > 30; // single step taking >30s = warning

  return (
    <div className="card" style={{
      borderLeft: `3px solid var(--accent)`,
      background: "linear-gradient(180deg, var(--accent-soft), var(--panel))",
      marginBottom: 14,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--accent-hover)", fontWeight: 700 }}>
            🔴 Submitting now
          </div>
          <div style={{ fontWeight: 600, fontSize: 15, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {state.jobTitle}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>
            <a href={state.jobUrl} target="_blank" rel="noreferrer">↗ {state.jobUrl.slice(0, 80)}</a>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{
            fontSize: 12,
            padding: "4px 10px",
            background: stepHot ? "var(--warn-soft)" : "var(--panel)",
            color: stepHot ? "var(--warn)" : "var(--accent-hover)",
            borderRadius: 12,
            fontWeight: 600,
            border: "1px solid var(--border)",
            display: "inline-block",
          }}>
            {STEP_LABEL[state.step]} · {state.step_elapsed_sec}s
          </div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
            Total: {state.elapsed_sec}s
          </div>
        </div>
      </div>
    </div>
  );
}
