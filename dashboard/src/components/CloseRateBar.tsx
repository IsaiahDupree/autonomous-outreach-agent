import { useEffect, useState } from "react";
import { api } from "../lib/api";

type Window = { submitted: number; won: number; closeRate: number };

export function CloseRateBar() {
  const [windows, setWindows] = useState<{ "7d": Window; "30d": Window; "90d": Window } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.metrics()
      .then(m => { if (!cancelled) setWindows(m.windows); })
      .catch(e => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <div className="close-rate-bar error">close rate: {error}</div>;
  if (!windows) return <div className="close-rate-bar">close rate: …</div>;

  return (
    <div className="close-rate-bar" style={{ display: "flex", gap: 16, padding: "8px 12px", fontSize: 13 }}>
      {(["7d", "30d", "90d"] as const).map(k => (
        <div key={k}>
          <strong>{k}:</strong> {windows[k].closeRate}% ({windows[k].won}/{windows[k].submitted})
        </div>
      ))}
    </div>
  );
}
