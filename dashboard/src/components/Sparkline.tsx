type Props = {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
  strokeWidth?: number;
  dot?: boolean;
};

export function Sparkline({
  values,
  width = 96,
  height = 24,
  stroke = "currentColor",
  fill,
  strokeWidth = 1.25,
  dot = false,
}: Props) {
  if (!values || values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = width / (values.length - 1);
  const pts = values.map((v, i) => [i * stepX, height - ((v - min) / span) * (height - 2) - 1]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const fillD = fill ? `${d} L ${width},${height} L 0,${height} Z` : null;
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} style={{ display: "block", overflow: "visible" }}>
      {fillD && <path d={fillD} fill={fill} opacity={0.18} />}
      <path d={d} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      {dot && <circle cx={last[0]} cy={last[1]} r={2.2} fill={stroke} />}
    </svg>
  );
}
