-- Click tracking: short-link redirect + per-click event log.
-- Links are created when a proposal is generated; each /r/:slug hit appends to link_clicks.

CREATE TABLE IF NOT EXISTS tracked_links (
  slug         text PRIMARY KEY,
  target_url   text NOT NULL,
  link_type    text NOT NULL,                 -- 'portfolio' | 'proof' | 'showcase' | 'github' | 'youtube'
  job_id       text,
  niche        text,
  label        text,                          -- optional human label, e.g. project name
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tracked_links_job_id    ON tracked_links(job_id);
CREATE INDEX IF NOT EXISTS idx_tracked_links_niche     ON tracked_links(niche);
CREATE INDEX IF NOT EXISTS idx_tracked_links_link_type ON tracked_links(link_type);

CREATE TABLE IF NOT EXISTS link_clicks (
  id          bigserial PRIMARY KEY,
  slug        text NOT NULL REFERENCES tracked_links(slug) ON DELETE CASCADE,
  ip          text,
  user_agent  text,
  referer     text,
  clicked_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_link_clicks_slug       ON link_clicks(slug);
CREATE INDEX IF NOT EXISTS idx_link_clicks_clicked_at ON link_clicks(clicked_at DESC);

-- Convenience view: clicks per link with last-click timestamp.
CREATE OR REPLACE VIEW tracked_links_with_clicks AS
SELECT
  t.slug,
  t.target_url,
  t.link_type,
  t.job_id,
  t.niche,
  t.label,
  t.created_at,
  COALESCE(c.click_count, 0) AS click_count,
  c.last_clicked_at
FROM tracked_links t
LEFT JOIN (
  SELECT slug, COUNT(*) AS click_count, MAX(clicked_at) AS last_clicked_at
  FROM link_clicks
  GROUP BY slug
) c ON c.slug = t.slug;
