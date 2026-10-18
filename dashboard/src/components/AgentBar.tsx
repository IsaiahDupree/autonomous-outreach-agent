import { useEffect, useState } from "react";
import { api, type AgentState } from "../lib/api";

export function AgentBar() {
  const [state, setState] = useState<AgentState | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setState(await api.agentState());
    } catch {
      setState(null);
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  async function toggle() {
    if (!state) return;
    setBusy(true);
    try {
      if (state.state === "running") await api.pause("dashboard");
      else await api.resume();
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const status = state?.state || "stopped";
  const label =
    status === "running" ? "Running"
    : status === "paused" ? "Paused"
    : status === "stopping" ? "Stopping"
    : "Stopped";

  return (
    <div className={`agent-status ${status}`}>
      <span className="dot" />
      <span>{label}</span>
      {state && (
        <button className="btn" onClick={toggle} disabled={busy || status === "stopped" || status === "stopping"}>
          {status === "running" ? "Pause" : "Resume"}
        </button>
      )}
    </div>
  );
}
