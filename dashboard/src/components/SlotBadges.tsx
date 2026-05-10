import { SLOT_ORDER } from "../lib/api";

export function SlotBadges({ slots }: { slots?: Record<string, string> }) {
  if (!slots) return null;
  return (
    <div className="slot-badges">
      {SLOT_ORDER.map(name => {
        const value = (slots[name] || "").trim();
        const present = value.length >= 20;
        return (
          <span key={name} className={`slot-badge ${present ? "present" : "missing"}`}>
            {name}
          </span>
        );
      })}
    </div>
  );
}
