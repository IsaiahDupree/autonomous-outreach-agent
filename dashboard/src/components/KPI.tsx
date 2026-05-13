import { Sparkline } from "./Sparkline";

type Props = {
  label: string;
  value: string | number;
  sub?: string;
  trend?: number | null;
  accent?: string;
  sparkline?: number[];
};

export function KPI({ label, value, sub, trend, accent, sparkline }: Props) {
  const accentColor = accent || "var(--accent)";
  return (
    <div style={{
      padding: "14px 16px",
      background: "var(--panel)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius)",
      boxShadow: "var(--shadow)",
      display: "flex",
      flexDirection: "column",
      gap: 6,
      minWidth: 0,
    }}>
      <div style={{
        font: '600 10px/1 ui-monospace, "Cascadia Code", Consolas, monospace',
        letterSpacing: "0.12em",
        color: "var(--text-dim)",
      }}>
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <div style={{
          font: '500 26px/1 ui-serif, Georgia, Cambria, serif',
          color: "var(--text)",
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "-0.01em",
        }}>
          {value}
        </div>
        {trend != null && (
          <div style={{
            font: '600 11px/1 ui-monospace, "Cascadia Code", Consolas, monospace',
            color: trend >= 0 ? "var(--good)" : "var(--bad)",
          }}>
            {trend >= 0 ? "▲" : "▼"} {Math.abs(trend).toFixed(1)}%
          </div>
        )}
      </div>
      {sub && (
        <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.3 }}>
          {sub}
        </div>
      )}
      {sparkline && sparkline.length >= 2 && (
        <Sparkline values={sparkline} width={140} height={22} stroke={accentColor} fill={accentColor} dot />
      )}
    </div>
  );
}
