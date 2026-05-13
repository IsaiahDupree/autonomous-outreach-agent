type Props = {
  score: number | null | undefined;
  scale?: 10 | 100;
  size?: "sm" | "md";
};

export function ScoreChip({ score, scale = 10, size = "sm" }: Props) {
  if (score == null) return null;
  const normalized = scale === 100 ? score / 10 : score;
  const tone =
    normalized >= 8.5 ? "good" :
    normalized >= 7 ? "accent" :
    normalized >= 5 ? "warn" : "bad";
  const palette = {
    good:   { bg: "var(--good-soft)",   fg: "var(--good)" },
    accent: { bg: "var(--accent-soft)", fg: "var(--accent-hover)" },
    warn:   { bg: "var(--warn-soft)",   fg: "var(--warn)" },
    bad:    { bg: "var(--bad-soft)",    fg: "var(--bad)" },
  }[tone];
  const fontSize = size === "md" ? 13 : 12;
  const padding = size === "md" ? "3px 10px" : "2px 9px";
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "baseline",
      gap: 3,
      padding,
      borderRadius: 12,
      background: palette.bg,
      color: palette.fg,
      fontSize,
      fontWeight: 700,
      letterSpacing: "0.2px",
      fontVariantNumeric: "tabular-nums",
    }}>
      {score}
      <span style={{ fontSize: fontSize - 2, fontWeight: 500, opacity: 0.6 }}>/{scale}</span>
    </span>
  );
}
