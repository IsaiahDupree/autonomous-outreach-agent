/**
 * dashboard/src/pages/Templates.tsx
 *
 * Transparency view + edit surface for proposal generation. Shows users exactly what
 * the agent feeds into Claude/OpenAI when building a proposal:
 *
 *   - Persona + ICP        — who the agent says it is, who it targets
 *   - Slot prompt          — the structural beats Claude is told to emit (problem/solution/...)
 *   - Portfolio niches     — keyword → niche mapping + per-niche portfolio anchor URL
 *   - Portfolio templates  — per-niche line that gets dropped into the cover letter
 *   - Showcase projects    — past projects matched against job tags
 *   - GitHub repos         — proof links per topic
 *   - YouTube videos       — proof videos per topic
 *   - Custom context       — EDITABLE per-niche free-text injected at gen time
 *
 * Read-only for everything except custom context (the only thing users will tune in flight).
 * The character.json file itself is edited via filesystem; this page is the runtime view.
 */
import { useEffect, useMemo, useState } from "react";
import { api, type CharacterConfig } from "../lib/api";

type TabKey = "preview" | "persona" | "slot_prompt" | "portfolio" | "showcase" | "github" | "youtube" | "custom_context" | "variants" | "audit";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "preview",        label: "Prompt preview" },
  { key: "persona",        label: "Persona & ICP" },
  { key: "slot_prompt",    label: "Slot prompt" },
  { key: "portfolio",      label: "Portfolio niches" },
  { key: "showcase",       label: "Showcase projects" },
  { key: "github",         label: "GitHub repos" },
  { key: "youtube",        label: "YouTube videos" },
  { key: "custom_context", label: "Custom context" },
  { key: "variants",       label: "A/B variants" },
  { key: "audit",          label: "Edit history" },
];

export function Templates() {
  const [tab, setTab] = useState<TabKey>("persona");
  const [data, setData] = useState<{ character: CharacterConfig; slot_prompt: string; custom_context: Record<string, string> } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try { setData(await api.character()); }
    catch (e) { setError((e as Error).message); }
  }

  useEffect(() => { load(); }, []);

  if (error) return <div className="error">Templates load error: {error}</div>;
  if (!data) return <div className="empty">Loading character config…</div>;
  const { character, slot_prompt, custom_context } = data;

  return (
    <>
      <h2 style={{ marginBottom: 8 }}>Generation templates</h2>
      <p style={{ color: "var(--text-dim)", marginTop: 0, fontSize: 13 }}>
        Edit what gets baked into every proposal. Each section saves independently with a timestamped backup.
        Use the <strong>Custom context</strong> tab for per-niche free-text snippets ("always mention X"),
        and the <strong>A/B variants</strong> tab to test alternative framings.
      </p>

      <div style={{ display: "flex", gap: 4, marginBottom: 16, flexWrap: "wrap", borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
        {TABS.map(t => (
          <button
            key={t.key}
            className={`btn ${tab === t.key ? "btn-primary" : ""}`}
            onClick={() => setTab(t.key)}
          >{t.label}</button>
        ))}
      </div>

      {tab === "preview"        && <PromptPreviewTab />}
      {tab === "persona"        && <PersonaTab character={character} onSaved={load} />}
      {tab === "slot_prompt"    && <SlotPromptTab text={slot_prompt} />}
      {tab === "portfolio"      && <PortfolioTab character={character} onSaved={load} />}
      {tab === "showcase"       && <ShowcaseTab character={character} onSaved={load} />}
      {tab === "github"         && <GithubTab character={character} onSaved={load} />}
      {tab === "youtube"        && <YouTubeTab character={character} onSaved={load} />}
      {tab === "custom_context" && <CustomContextTab initial={custom_context} onSaved={load} />}
      {tab === "variants"       && <VariantsTab />}
      {tab === "audit"          && <AuditTab />}
    </>
  );
}

// ── Edit history ──────────────────────────────────────────────────────────
function AuditTab() {
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof api.characterAudit>>["entries"]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const r = await api.characterAudit(100);
      setEntries(r.entries);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  if (error) return <div className="error">Audit load error: {error}</div>;
  if (loading && entries.length === 0) return <div className="empty">Loading…</div>;
  if (entries.length === 0) {
    return <div className="empty">No edits recorded yet. Save a section, variant, or custom-context entry and it will appear here.</div>;
  }

  return (
    <div>
      <p style={{ color: "var(--text-dim)", fontSize: 13, marginTop: 0 }}>
        Append-only log of edits to character.json, prompt variants, and custom-context. Last 500 entries retained.
      </p>
      <button className="btn" onClick={load} disabled={loading} style={{ marginBottom: 12 }}>
        {loading ? "Reloading…" : "Reload"}
      </button>
      <div className="card" style={{ padding: 0 }}>
        <table style={{ width: "100%", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: 8 }}>When</th>
              <th style={{ textAlign: "left", padding: 8 }}>Kind</th>
              <th style={{ textAlign: "left", padding: 8 }}>Section</th>
              <th style={{ textAlign: "left", padding: 8 }}>Source</th>
              <th style={{ textAlign: "left", padding: 8 }}>Summary</th>
              <th style={{ textAlign: "left", padding: 8 }}>Backup</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={`${e.ts}-${i}`}>
                <td style={{ padding: 8, color: "var(--text-dim)", whiteSpace: "nowrap" }}>{new Date(e.ts).toLocaleString()}</td>
                <td style={{ padding: 8 }}>{e.kind}</td>
                <td style={{ padding: 8 }}>{e.section ?? "—"}</td>
                <td style={{ padding: 8 }}>{e.source}</td>
                <td style={{ padding: 8 }}>{e.summary}</td>
                <td style={{ padding: 8, fontFamily: "monospace", fontSize: 11, color: "var(--text-dim)" }}>{e.backup ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Prompt preview ────────────────────────────────────────────────────────
function PromptPreviewTab() {
  const [title, setTitle] = useState("AI automation specialist for n8n + Claude API workflows");
  const [description, setDescription] = useState("We need an experienced n8n + AI automation engineer to build a Claude-API-powered workflow that ingests Stripe webhooks and pushes structured deal records into HubSpot.");
  const [budget, setBudget] = useState("$1,500");
  const [tagsStr, setTagsStr] = useState("ai automation, n8n, claude api");
  const [prompt, setPrompt] = useState<string>("");
  const [tokens, setTokens] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true); setError(null);
    try {
      const tags = tagsStr.split(",").map(s => s.trim()).filter(Boolean);
      const r = await api.previewPrompt({ title, description, budget, tags });
      setPrompt(r.prompt);
      setTokens(r.approximate_tokens);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }

  return (
    <div className="card">
      <p style={{ marginTop: 0, color: "var(--text-dim)", fontSize: 13 }}>
        Renders the EXACT prompt that gets sent to Claude when this job hits the auto-send pipeline.
        Includes everything: persona, GitHub/YouTube/portfolio matches, slot instructions, niche
        custom context, A/B variant (if any), and reinforcement hints. No LLM call is made.
      </p>
      <Field label="Job title">
        <input type="text" value={title} onChange={e => setTitle(e.target.value)} style={{ width: "100%" }} />
      </Field>
      <Field label="Job description">
        <textarea value={description} onChange={e => setDescription(e.target.value)} rows={4}
          style={{ width: "100%", padding: 10, background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 13, fontFamily: "ui-monospace, monospace", resize: "vertical" }} />
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
        <Field label="Budget"><input type="text" value={budget} onChange={e => setBudget(e.target.value)} style={{ width: "100%" }} /></Field>
        <Field label="Tags (comma-separated — drives niche matching)"><input type="text" value={tagsStr} onChange={e => setTagsStr(e.target.value)} style={{ width: "100%" }} /></Field>
      </div>
      <button className="btn btn-primary" onClick={run} disabled={loading} style={{ marginTop: 12 }}>
        {loading ? "Building…" : "Build prompt"}
      </button>
      {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}
      {prompt && (
        <>
          <div style={{ marginTop: 16, fontSize: 12, color: "var(--text-dim)" }}>
            {prompt.length.toLocaleString()} chars · ~{tokens?.toLocaleString()} tokens
          </div>
          <div className="cover-letter" style={{ maxHeight: 600, marginTop: 4 }}>{prompt}</div>
        </>
      )}
    </div>
  );
}

// ── Variants ──────────────────────────────────────────────────────────────
type Variant = { name: string; fragment: string; weight?: number };
function VariantsTab() {
  const [data, setData] = useState<Record<string, Variant[]> | null>(null);
  const [draft, setDraft] = useState<Record<string, Variant[]>>({});
  const [newNiche, setNewNiche] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function load() {
    setError(null);
    try { const r = await api.promptVariants(); setData(r.variants); setDraft(r.variants); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { load(); }, []);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(data), [draft, data]);

  function addNiche() {
    const k = newNiche.trim().toLowerCase();
    if (!k || draft[k]) return;
    setDraft({ ...draft, [k]: [{ name: "default", fragment: "", weight: 1 }] });
    setNewNiche("");
  }
  function removeNiche(niche: string) {
    const next = { ...draft }; delete next[niche]; setDraft(next);
  }
  function addVariant(niche: string) {
    setDraft({ ...draft, [niche]: [...(draft[niche] || []), { name: `variant-${(draft[niche] || []).length + 1}`, fragment: "", weight: 1 }] });
  }
  function removeVariant(niche: string, idx: number) {
    setDraft({ ...draft, [niche]: (draft[niche] || []).filter((_, i) => i !== idx) });
  }
  function updateVariant(niche: string, idx: number, patch: Partial<Variant>) {
    const list = (draft[niche] || []).slice();
    list[idx] = { ...list[idx], ...patch };
    setDraft({ ...draft, [niche]: list });
  }

  async function save() {
    setSaving(true); setError(null);
    try { await api.savePromptVariants(draft); setSavedAt(Date.now()); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  if (!data && !error) return <div className="empty">Loading variants…</div>;

  return (
    <div className="card">
      <p style={{ marginTop: 0, color: "var(--text-dim)", fontSize: 13 }}>
        Per-niche A/B prompt fragments. The agent picks one variant per submission via weighted
        random and appends it to the main prompt. Use this to test alternative framings (e.g.
        "lead-with-portfolio" vs "lead-with-github") and let the reinforcement loop tell you
        which one converts better. Weight defaults to 1 (equal probability across variants).
      </p>

      {Object.keys(draft).length === 0 && (
        <div className="empty">No variants defined — add a niche below.</div>
      )}

      {Object.entries(draft).map(([niche, list]) => (
        <div key={niche} className="card" style={{ background: "var(--panel-2)", marginTop: 12 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
            <strong style={{ fontFamily: "ui-monospace, monospace" }}>{niche}</strong>
            <span style={{ flex: 1 }} />
            <button className="btn" style={{ fontSize: 11, padding: "2px 8px", marginRight: 6 }} onClick={() => addVariant(niche)}>+ variant</button>
            <button className="btn btn-bad" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => removeNiche(niche)}>Remove niche</button>
          </div>
          {list.map((v, i) => (
            <div key={i} style={{ borderTop: "1px solid var(--border)", paddingTop: 10, marginTop: 10 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                <input type="text" placeholder="variant name" value={v.name} onChange={e => updateVariant(niche, i, { name: e.target.value })} style={{ flex: 1 }} />
                <input type="number" min={0} step={0.1} placeholder="weight" value={v.weight ?? 1} onChange={e => updateVariant(niche, i, { weight: Number(e.target.value) })} style={{ width: 80 }} />
                <button className="btn btn-bad" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => removeVariant(niche, i)}>×</button>
              </div>
              <textarea value={v.fragment} onChange={e => updateVariant(niche, i, { fragment: e.target.value })} rows={3} placeholder="Free-text appended to the proposal prompt when this variant is picked."
                style={{ width: "100%", padding: 10, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 13, fontFamily: "ui-monospace, monospace", resize: "vertical" }} />
            </div>
          ))}
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
        <input type="text" placeholder="add niche key (e.g. n8n, voice ai)" value={newNiche} onChange={e => setNewNiche(e.target.value)} style={{ flex: 1 }} />
        <button className="btn" onClick={addNiche} disabled={!newNiche.trim()}>Add niche</button>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 16 }}>
        <button className="btn btn-primary" disabled={!dirty || saving} onClick={save}>
          {saving ? "Saving…" : "Save changes"}
        </button>
        {savedAt && !dirty && <span style={{ fontSize: 12, color: "var(--good)" }}>Saved at {new Date(savedAt).toLocaleTimeString()}</span>}
        {error && <span style={{ fontSize: 12, color: "var(--bad)" }}>{error}</span>}
      </div>
    </div>
  );
}

// ── Reusable form helpers ────────────────────────────────────────────────
function ChipList({ items, onChange, placeholder }: { items: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState("");
  function commit() {
    const v = draft.trim();
    if (!v) return;
    if (items.includes(v)) { setDraft(""); return; }
    onChange([...items, v]);
    setDraft("");
  }
  function remove(idx: number) {
    onChange(items.filter((_, i) => i !== idx));
  }
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
        {items.map((t, i) => (
          <span key={`${t}-${i}`} style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "3px 8px",
            background: "var(--accent-soft, #ece9d8)",
            borderRadius: 12, fontSize: 12,
          }}>
            {t}
            <button
              onClick={() => remove(i)}
              style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--text-dim)", fontSize: 14, lineHeight: 1, padding: 0 }}
              aria-label={`remove ${t}`}
            >×</button>
          </span>
        ))}
        {items.length === 0 && <span style={{ fontSize: 12, color: "var(--text-dim)", fontStyle: "italic" }}>none yet</span>}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            else if (e.key === "," ) { e.preventDefault(); commit(); }
          }}
          placeholder={placeholder || "type and press Enter"}
          style={{ flex: 1 }}
        />
        <button className="btn" onClick={commit} disabled={!draft.trim()}>+ Add</button>
      </div>
    </div>
  );
}

function SaveBar({ dirty, saving, savedAt, error, onSave, onReset }: {
  dirty: boolean; saving: boolean; savedAt: number | null; error: string | null;
  onSave: () => void; onReset: () => void;
}) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
      <button className="btn btn-primary" disabled={!dirty || saving} onClick={onSave}>
        {saving ? "Saving…" : "Save changes"}
      </button>
      {dirty && <button className="btn" onClick={onReset} disabled={saving}>Discard</button>}
      {savedAt && !dirty && <span style={{ fontSize: 12, color: "var(--good)" }}>Saved at {new Date(savedAt).toLocaleTimeString()}</span>}
      {dirty && <span style={{ fontSize: 12, color: "var(--warn)" }}>unsaved changes</span>}
      {error && <span style={{ fontSize: 12, color: "var(--bad)" }}>{error}</span>}
    </div>
  );
}

function AdvancedJsonToggle({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      style={{ marginTop: 16, padding: 8, background: "var(--panel-2)", border: "1px dashed var(--border)", borderRadius: 6 }}>
      <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--text-dim)" }}>
        ⚙ Advanced — edit as JSON
      </summary>
      <div style={{ marginTop: 8 }}>{children}</div>
    </details>
  );
}

// ── Editable JSON wrapper for non-trivial sections ───────────────────────
function JsonSectionEditor({ section, value, onSaved }: { section: string; value: unknown; onSaved: () => void }) {
  const [draft, setDraft] = useState(JSON.stringify(value, null, 2));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const original = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const dirty = draft !== original;

  async function save() {
    setSaving(true); setError(null);
    try {
      const parsed = JSON.parse(draft);
      const r = await api.saveCharacterSection(section, parsed);
      setSavedAt(Date.now());
      if (r.ok) onSaved();
    } catch (e) {
      setError(e instanceof SyntaxError ? `JSON parse error: ${e.message}` : (e as Error).message);
    } finally { setSaving(false); }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={Math.min(30, draft.split("\n").length + 2)}
        style={{ width: "100%", padding: 10, background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 12, fontFamily: "ui-monospace, monospace", resize: "vertical" }} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
        <button className="btn btn-primary" disabled={!dirty || saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
        {savedAt && !dirty && <span style={{ fontSize: 12, color: "var(--good)" }}>Saved (backup made) at {new Date(savedAt).toLocaleTimeString()}</span>}
        {error && <span style={{ fontSize: 12, color: "var(--bad)" }}>{error}</span>}
        {dirty && <span style={{ fontSize: 12, color: "var(--warn)" }}>unsaved changes</span>}
      </div>
    </div>
  );
}

// ── Persona & ICP ──────────────────────────────────────────────────────────
function PersonaTab({ character, onSaved }: { character: CharacterConfig; onSaved: () => void }) {
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>{character.name}</h3>

      <Field label="Sign-off (string)">
        <SimpleStringEditor section="name_signoff" value={character.name_signoff || ""} onSaved={onSaved} />
      </Field>
      <Field label="Tone (string)">
        <SimpleStringEditor section="tone" value={character.tone || ""} onSaved={onSaved} />
      </Field>
      <Field label="Persona (multiline string)">
        <SimpleStringEditor section="persona" value={character.persona} onSaved={onSaved} multiline />
      </Field>
      <Field label="ICP — Ideal Customer Profile">
        <IcpEditor value={character.icp || {}} onSaved={onSaved} />
      </Field>
    </div>
  );
}

type IcpShape = { roles?: string[]; companyStage?: string; revenueRange?: string; painPoints?: string[] };
function IcpEditor({ value, onSaved }: { value: IcpShape; onSaved: () => void }) {
  const initial: IcpShape = {
    roles: value.roles || [],
    companyStage: value.companyStage || "",
    revenueRange: value.revenueRange || "",
    painPoints: value.painPoints || [],
  };
  const [draft, setDraft] = useState<IcpShape>(initial);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);

  async function save() {
    setSaving(true); setError(null);
    try {
      await api.saveCharacterSection("icp", draft);
      setSavedAt(Date.now());
      onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  return (
    <div>
      <p style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 0 }}>
        Who you're targeting. The agent uses these signals when scoring jobs and framing pitches.
      </p>
      <Field label="Target roles (who is the buyer?)">
        <ChipList
          items={draft.roles || []}
          onChange={(roles) => setDraft({ ...draft, roles })}
          placeholder="e.g. founder, CTO, head of ops"
        />
      </Field>
      <Field label="Company stage">
        <input
          type="text"
          value={draft.companyStage || ""}
          onChange={e => setDraft({ ...draft, companyStage: e.target.value })}
          placeholder="e.g. post-traction, seed, Series A"
          style={{ width: "100%" }}
        />
      </Field>
      <Field label="Revenue range">
        <input
          type="text"
          value={draft.revenueRange || ""}
          onChange={e => setDraft({ ...draft, revenueRange: e.target.value })}
          placeholder="e.g. $500K-$5M ARR"
          style={{ width: "100%" }}
        />
      </Field>
      <Field label="Pain points (what hurts them?)">
        <ChipList
          items={draft.painPoints || []}
          onChange={(painPoints) => setDraft({ ...draft, painPoints })}
          placeholder="e.g. manual execution work"
        />
      </Field>
      <SaveBar dirty={dirty} saving={saving} savedAt={savedAt} error={error}
        onSave={save} onReset={() => setDraft(initial)} />
      <AdvancedJsonToggle>
        <JsonSectionEditor section="icp" value={value} onSaved={onSaved} />
      </AdvancedJsonToggle>
    </div>
  );
}

function SimpleStringEditor({ section, value, onSaved, multiline }: { section: string; value: string; onSaved: () => void; multiline?: boolean }) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const dirty = draft !== value;

  async function save() {
    setSaving(true); setError(null);
    try { await api.saveCharacterSection(section, draft); setSavedAt(Date.now()); onSaved(); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  return (
    <>
      {multiline ? (
        <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={5}
          style={{ width: "100%", padding: 10, background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 13, resize: "vertical" }} />
      ) : (
        <input type="text" value={draft} onChange={e => setDraft(e.target.value)} style={{ width: "100%" }} />
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
        <button className="btn btn-primary" disabled={!dirty || saving} onClick={save} style={{ fontSize: 12, padding: "4px 10px" }}>{saving ? "Saving…" : "Save"}</button>
        {savedAt && !dirty && <span style={{ fontSize: 11, color: "var(--good)" }}>saved</span>}
        {error && <span style={{ fontSize: 11, color: "var(--bad)" }}>{error}</span>}
        {dirty && <span style={{ fontSize: 11, color: "var(--warn)" }}>unsaved</span>}
      </div>
    </>
  );
}

// ── Slot prompt ────────────────────────────────────────────────────────────
function SlotPromptTab({ text }: { text: string }) {
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Slot prompt instructions</h3>
      <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
        This is the structural-beats fragment appended to every proposal-generation prompt. Claude is
        told to wrap each beat (<code>problem / solution / proof / portfolio / prior_results / cta</code>)
        in XML tags so the agent can parse and quality-check each one independently.
      </p>
      <div className="cover-letter" style={{ maxHeight: 480 }}>{text}</div>
    </div>
  );
}

// ── Portfolio niches ──────────────────────────────────────────────────────
type PortfolioShape = {
  url?: string;
  label?: string;
  nicheAnchors?: Record<string, { anchor: string; keywords: string[] }>;
  templates?: Record<string, string>;
};

function PortfolioTab({ character, onSaved }: { character: CharacterConfig; onSaved: () => void }) {
  const value = (character.portfolio || {}) as PortfolioShape;
  const initial: PortfolioShape = {
    url: value.url || "",
    label: value.label || "",
    nicheAnchors: value.nicheAnchors || {},
    templates: value.templates || {},
  };
  const [draft, setDraft] = useState<PortfolioShape>(initial);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newNicheKey, setNewNicheKey] = useState("");
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);

  // Union of niche keys across both maps so editors stay aligned even if one side is empty.
  const niches = useMemo(() => {
    const keys = new Set<string>([
      ...Object.keys(draft.nicheAnchors || {}),
      ...Object.keys(draft.templates || {}),
    ]);
    keys.delete("default");
    return Array.from(keys).sort();
  }, [draft]);

  function addNiche() {
    const k = newNicheKey.trim().toLowerCase();
    if (!k) return;
    if ((draft.nicheAnchors || {})[k] || (draft.templates || {})[k]) { setNewNicheKey(""); return; }
    setDraft({
      ...draft,
      nicheAnchors: { ...(draft.nicheAnchors || {}), [k]: { anchor: `#niche-${k}`, keywords: [] } },
      templates: { ...(draft.templates || {}), [k]: `I've shipped projects relevant to your needs — see exactly what I've built: {url}` },
    });
    setNewNicheKey("");
  }

  function removeNiche(k: string) {
    const a = { ...(draft.nicheAnchors || {}) }; delete a[k];
    const t = { ...(draft.templates || {}) }; delete t[k];
    setDraft({ ...draft, nicheAnchors: a, templates: t });
  }

  function updateAnchor(k: string, anchor: string) {
    const a = draft.nicheAnchors || {};
    setDraft({ ...draft, nicheAnchors: { ...a, [k]: { anchor, keywords: a[k]?.keywords || [] } } });
  }
  function updateKeywords(k: string, keywords: string[]) {
    const a = draft.nicheAnchors || {};
    setDraft({ ...draft, nicheAnchors: { ...a, [k]: { anchor: a[k]?.anchor || `#niche-${k}`, keywords } } });
  }
  function updateTemplate(k: string, tpl: string) {
    setDraft({ ...draft, templates: { ...(draft.templates || {}), [k]: tpl } });
  }

  async function save() {
    setSaving(true); setError(null);
    try {
      await api.saveCharacterSection("portfolio", draft);
      setSavedAt(Date.now());
      onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  const defaultTemplate = (draft.templates || {})["default"] || "";

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Portfolio</h3>
      <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
        Per-niche line that lands in the proposal whenever a job matches that niche's keywords.
        Use <code>{`{url}`}</code> in templates and it gets replaced with the portfolio URL plus niche anchor.
      </p>

      <Field label="Portfolio URL">
        <input type="text" value={draft.url || ""} placeholder="https://your-portfolio.com"
          onChange={e => setDraft({ ...draft, url: e.target.value })} style={{ width: "100%" }} />
      </Field>
      <Field label="Link label (used for tracked /r/ slugs)">
        <input type="text" value={draft.label || ""} placeholder="See similar work I've delivered"
          onChange={e => setDraft({ ...draft, label: e.target.value })} style={{ width: "100%" }} />
      </Field>

      <Field label="Default template (used when no niche matches)">
        <textarea value={defaultTemplate} rows={2}
          placeholder="I put together a tailored portfolio page — take a look: {url}"
          onChange={e => updateTemplate("default", e.target.value)}
          style={{ width: "100%", padding: 10, background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 13, resize: "vertical" }} />
      </Field>

      <h4 style={{ marginTop: 24, marginBottom: 4 }}>Niches ({niches.length})</h4>
      <p style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 0 }}>
        Each niche has keywords (matched against job tags) and a template line written for that audience.
      </p>

      {niches.length === 0 && <div className="empty">No niches defined — add one below.</div>}

      {niches.map(k => {
        const anchor = (draft.nicheAnchors || {})[k]?.anchor || "";
        const keywords = (draft.nicheAnchors || {})[k]?.keywords || [];
        const tpl = (draft.templates || {})[k] || "";
        return (
          <div key={k} style={{ marginTop: 12, padding: 12, background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 6 }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 10, gap: 8 }}>
              <strong style={{ fontFamily: "ui-monospace, monospace" }}>{k}</strong>
              <span style={{ flex: 1 }} />
              <button className="btn btn-bad" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => removeNiche(k)}>Remove niche</button>
            </div>
            <Field label="Anchor (URL fragment, e.g. #niche-saas)">
              <input type="text" value={anchor} onChange={e => updateAnchor(k, e.target.value)} style={{ width: "100%" }} />
            </Field>
            <Field label="Match keywords (matched against job tags + title)">
              <ChipList items={keywords} onChange={(kw) => updateKeywords(k, kw)} placeholder="e.g. shopify, stripe" />
            </Field>
            <Field label="Template line (use {url} where the link goes)">
              <textarea value={tpl} rows={3}
                onChange={e => updateTemplate(k, e.target.value)}
                style={{ width: "100%", padding: 10, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 13, resize: "vertical" }} />
            </Field>
          </div>
        );
      })}

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
        <input
          type="text"
          value={newNicheKey}
          onChange={e => setNewNicheKey(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addNiche(); } }}
          placeholder="add niche key (e.g. ecommerce, iot)"
          style={{ flex: 1 }}
        />
        <button className="btn" onClick={addNiche} disabled={!newNicheKey.trim()}>+ Add niche</button>
      </div>

      <SaveBar dirty={dirty} saving={saving} savedAt={savedAt} error={error}
        onSave={save} onReset={() => setDraft(initial)} />

      <AdvancedJsonToggle>
        <JsonSectionEditor section="portfolio" value={character.portfolio || {}} onSaved={onSaved} />
      </AdvancedJsonToggle>
    </div>
  );
}

// ── Showcase projects ─────────────────────────────────────────────────────
type ShowcaseProject = { name: string; description: string; liveUrl?: string; keywords: string[]; featured?: boolean };

function ShowcaseTab({ character, onSaved }: { character: CharacterConfig; onSaved: () => void }) {
  const initial: ShowcaseProject[] = (character.showcaseProjects || []) as ShowcaseProject[];
  const [draft, setDraft] = useState<ShowcaseProject[]>(initial);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);

  function update(idx: number, patch: Partial<ShowcaseProject>) {
    setDraft(draft.map((p, i) => i === idx ? { ...p, ...patch } : p));
  }
  function remove(idx: number) { setDraft(draft.filter((_, i) => i !== idx)); }
  function add() {
    setDraft([...draft, { name: "", description: "", keywords: [], liveUrl: "", featured: false }]);
  }

  async function save() {
    setSaving(true); setError(null);
    try {
      await api.saveCharacterSection("showcaseProjects", draft);
      setSavedAt(Date.now());
      onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Showcase projects ({draft.length})</h3>
      <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
        Past projects the agent name-drops in proposals when keywords match. Top 2 by keyword score get included.
      </p>

      {draft.length === 0 && <div className="empty">No projects yet — add one below.</div>}

      {draft.map((p, i) => (
        <div key={i} style={{ marginTop: 12, padding: 12, background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 6 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 8, gap: 8 }}>
            <strong>Project {i + 1}</strong>
            <span style={{ flex: 1 }} />
            <label style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 }}>
              <input type="checkbox" checked={!!p.featured} onChange={e => update(i, { featured: e.target.checked })} />
              Featured
            </label>
            <button className="btn btn-bad" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => remove(i)}>Remove</button>
          </div>
          <Field label="Name">
            <input type="text" value={p.name} onChange={e => update(i, { name: e.target.value })} style={{ width: "100%" }} placeholder="e.g. AutoLeadCRM" />
          </Field>
          <Field label="Description">
            <textarea value={p.description} rows={3}
              onChange={e => update(i, { description: e.target.value })}
              placeholder="One paragraph describing what it does and what tech it uses."
              style={{ width: "100%", padding: 10, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 13, resize: "vertical" }} />
          </Field>
          <Field label="Live URL (optional)">
            <input type="text" value={p.liveUrl || ""} onChange={e => update(i, { liveUrl: e.target.value })} style={{ width: "100%" }} placeholder="https://..." />
          </Field>
          <Field label="Keywords (matched against job tags + title)">
            <ChipList items={p.keywords || []} onChange={(kw) => update(i, { keywords: kw })} placeholder="e.g. shopify, stripe, react" />
          </Field>
        </div>
      ))}

      <button className="btn" onClick={add} style={{ marginTop: 16 }}>+ Add project</button>

      <SaveBar dirty={dirty} saving={saving} savedAt={savedAt} error={error}
        onSave={save} onReset={() => setDraft(initial)} />

      <AdvancedJsonToggle>
        <JsonSectionEditor section="showcaseProjects" value={initial} onSaved={onSaved} />
      </AdvancedJsonToggle>
    </div>
  );
}

// ── GitHub ────────────────────────────────────────────────────────────────
type GithubShape = { username?: string; repos?: Record<string, { url: string; description: string; keywords: string[] }> };

function GithubTab({ character, onSaved }: { character: CharacterConfig; onSaved: () => void }) {
  const initial: GithubShape = {
    username: character.github?.username || "",
    repos: character.github?.repos || {},
  };
  const [draft, setDraft] = useState<GithubShape>(initial);
  const [newKey, setNewKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);

  function add() {
    const k = newKey.trim().toLowerCase();
    if (!k || (draft.repos || {})[k]) { setNewKey(""); return; }
    setDraft({ ...draft, repos: { ...(draft.repos || {}), [k]: { url: "", description: "", keywords: [] } } });
    setNewKey("");
  }
  function remove(k: string) {
    const r = { ...(draft.repos || {}) }; delete r[k];
    setDraft({ ...draft, repos: r });
  }
  function update(k: string, patch: Partial<{ url: string; description: string; keywords: string[] }>) {
    const r = draft.repos || {};
    setDraft({ ...draft, repos: { ...r, [k]: { ...r[k], ...patch } } });
  }

  async function save() {
    setSaving(true); setError(null);
    try {
      await api.saveCharacterSection("github", draft);
      setSavedAt(Date.now());
      onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  const entries = Object.entries(draft.repos || {});

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>GitHub repos ({entries.length})</h3>
      <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
        Repo links the agent attaches as proof. A repo is included when ≥2 of its keywords match the job's tags or title.
      </p>

      <Field label="GitHub username">
        <input type="text" value={draft.username || ""} onChange={e => setDraft({ ...draft, username: e.target.value })} style={{ width: "100%" }} placeholder="e.g. isaiahdupree" />
      </Field>

      {entries.length === 0 && <div className="empty">No repos yet — add one below.</div>}

      {entries.map(([k, repo]) => (
        <div key={k} style={{ marginTop: 12, padding: 12, background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 6 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 8, gap: 8 }}>
            <strong style={{ fontFamily: "ui-monospace, monospace" }}>{k}</strong>
            <span style={{ flex: 1 }} />
            <button className="btn btn-bad" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => remove(k)}>Remove</button>
          </div>
          <Field label="Repo URL">
            <input type="text" value={repo.url} onChange={e => update(k, { url: e.target.value })} style={{ width: "100%" }} placeholder="https://github.com/..." />
          </Field>
          <Field label="One-line description">
            <input type="text" value={repo.description} onChange={e => update(k, { description: e.target.value })} style={{ width: "100%" }} />
          </Field>
          <Field label="Match keywords">
            <ChipList items={repo.keywords || []} onChange={(kw) => update(k, { keywords: kw })} placeholder="e.g. fastapi, claude, automation" />
          </Field>
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
        <input type="text" value={newKey} onChange={e => setNewKey(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder="add repo topic key (e.g. fastapi-claude-search)" style={{ flex: 1 }} />
        <button className="btn" onClick={add} disabled={!newKey.trim()}>+ Add repo</button>
      </div>

      <SaveBar dirty={dirty} saving={saving} savedAt={savedAt} error={error}
        onSave={save} onReset={() => setDraft(initial)} />

      <AdvancedJsonToggle>
        <JsonSectionEditor section="github" value={initial} onSaved={onSaved} />
      </AdvancedJsonToggle>
    </div>
  );
}

// ── YouTube ───────────────────────────────────────────────────────────────
type YouTubeShape = { channelUrl?: string; videos?: Record<string, { url: string; title: string; keywords: string[] }> };

function YouTubeTab({ character, onSaved }: { character: CharacterConfig; onSaved: () => void }) {
  const initial: YouTubeShape = {
    channelUrl: character.youtube?.channelUrl || "",
    videos: character.youtube?.videos || {},
  };
  const [draft, setDraft] = useState<YouTubeShape>(initial);
  const [newKey, setNewKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);

  function add() {
    const k = newKey.trim().toLowerCase();
    if (!k || (draft.videos || {})[k]) { setNewKey(""); return; }
    setDraft({ ...draft, videos: { ...(draft.videos || {}), [k]: { url: "", title: "", keywords: [] } } });
    setNewKey("");
  }
  function remove(k: string) {
    const v = { ...(draft.videos || {}) }; delete v[k];
    setDraft({ ...draft, videos: v });
  }
  function update(k: string, patch: Partial<{ url: string; title: string; keywords: string[] }>) {
    const v = draft.videos || {};
    setDraft({ ...draft, videos: { ...v, [k]: { ...v[k], ...patch } } });
  }

  async function save() {
    setSaving(true); setError(null);
    try {
      await api.saveCharacterSection("youtube", draft);
      setSavedAt(Date.now());
      onSaved();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  const entries = Object.entries(draft.videos || {});

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>YouTube videos ({entries.length})</h3>
      <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
        Proof videos the agent links to in proposals. All matching videos are included.
      </p>

      <Field label="Channel URL (optional)">
        <input type="text" value={draft.channelUrl || ""} onChange={e => setDraft({ ...draft, channelUrl: e.target.value })} style={{ width: "100%" }} placeholder="https://youtube.com/@..." />
      </Field>

      {entries.length === 0 && <div className="empty">No videos yet — add one below.</div>}

      {entries.map(([k, v]) => (
        <div key={k} style={{ marginTop: 12, padding: 12, background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 6 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 8, gap: 8 }}>
            <strong style={{ fontFamily: "ui-monospace, monospace" }}>{k}</strong>
            <span style={{ flex: 1 }} />
            <button className="btn btn-bad" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => remove(k)}>Remove</button>
          </div>
          <Field label="Video URL">
            <input type="text" value={v.url} onChange={e => update(k, { url: e.target.value })} style={{ width: "100%" }} placeholder="https://youtube.com/watch?v=..." />
          </Field>
          <Field label="Title (shown to client)">
            <input type="text" value={v.title} onChange={e => update(k, { title: e.target.value })} style={{ width: "100%" }} />
          </Field>
          <Field label="Match keywords">
            <ChipList items={v.keywords || []} onChange={(kw) => update(k, { keywords: kw })} placeholder="e.g. n8n, automation" />
          </Field>
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
        <input type="text" value={newKey} onChange={e => setNewKey(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder="add video topic key (e.g. claude-pipeline-demo)" style={{ flex: 1 }} />
        <button className="btn" onClick={add} disabled={!newKey.trim()}>+ Add video</button>
      </div>

      <SaveBar dirty={dirty} saving={saving} savedAt={savedAt} error={error}
        onSave={save} onReset={() => setDraft(initial)} />

      <AdvancedJsonToggle>
        <JsonSectionEditor section="youtube" value={initial} onSaved={onSaved} />
      </AdvancedJsonToggle>
    </div>
  );
}

// ── Custom context (editable) ─────────────────────────────────────────────
function CustomContextTab({ initial, onSaved }: { initial: Record<string, string>; onSaved: () => void }) {
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const [newKey, setNewKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);

  async function save() {
    setSaving(true); setError(null);
    try {
      await api.saveCustomContext(draft);
      setSavedAt(Date.now());
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function add() {
    const k = newKey.trim().toLowerCase();
    if (!k || draft[k] !== undefined) return;
    setDraft({ ...draft, [k]: "" });
    setNewKey("");
  }
  function remove(k: string) { const next = { ...draft }; delete next[k]; setDraft(next); }
  function update(k: string, v: string) { setDraft({ ...draft, [k]: v }); }

  return (
    <div className="card">
      <p style={{ marginTop: 0, color: "var(--text-dim)", fontSize: 13 }}>
        Each entry is a free-text block injected into the proposal-generation prompt when the
        job's tags match the niche key. The <code>global</code> entry is always included.
        Match is substring-based + case-insensitive. Max 4000 chars per entry.
      </p>

      {Object.keys(draft).length === 0 && (
        <div className="empty">No custom-context entries yet — add one below.</div>
      )}

      {Object.entries(draft).map(([k, v]) => (
        <div key={k} style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <strong style={{ fontFamily: "ui-monospace, monospace" }}>{k}</strong>
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {k === "global" ? "(always injected)" : "(matched against tags)"}
            </span>
            <span style={{ flex: 1 }} />
            {k !== "global" && (
              <button className="btn btn-bad" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => remove(k)}>Remove</button>
            )}
          </div>
          <textarea
            value={v}
            onChange={e => update(k, e.target.value)}
            rows={4}
            placeholder={`Free-text injected when a job's tags match "${k}". Drop in links, case studies, or "always mention X".`}
            style={{
              width: "100%",
              padding: 10,
              background: "var(--panel-2)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              color: "var(--text)",
              fontSize: 13,
              fontFamily: "ui-monospace, monospace",
              resize: "vertical",
            }}
          />
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>{v.length} / 4000 chars</div>
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
        <input
          type="text"
          placeholder="add niche key (e.g. n8n, voice ai, ecommerce)"
          value={newKey}
          onChange={e => setNewKey(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") add(); }}
          style={{ flex: 1 }}
        />
        <button className="btn" onClick={add} disabled={!newKey.trim()}>Add niche</button>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 16 }}>
        <button className="btn btn-primary" disabled={!dirty || saving} onClick={save}>
          {saving ? "Saving…" : "Save changes"}
        </button>
        {savedAt && !dirty && (
          <span style={{ fontSize: 12, color: "var(--good)" }}>Saved at {new Date(savedAt).toLocaleTimeString()}</span>
        )}
        {error && <span style={{ fontSize: 12, color: "var(--bad)" }}>{error}</span>}
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--text-dim)", marginBottom: 4 }}>
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}
