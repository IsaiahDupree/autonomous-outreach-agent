-- migrations/000_outreach_bootstrap.sql
-- Composes the final state of migrations 001–008 (plus base tables that were originally created
-- in Studio rather than checked in). Idempotent: safe to re-run.
--
-- Apply once when bringing up a fresh Supabase project:
--   supabase db query --linked < migrations/000_outreach_bootstrap.sql
--
-- After this runs, the agent can read/write all schema it expects.

-- ==========================================================================
-- upwork_proposals — core proposal record
-- ==========================================================================
CREATE TABLE IF NOT EXISTS upwork_proposals (
  id                       bigserial PRIMARY KEY,
  job_id                   text NOT NULL UNIQUE,
  job_title                text,
  job_url                  text,
  job_description          text,
  budget                   text,
  score                    numeric,
  pre_score                numeric,
  proposal_text            text,
  proposal_slots_json      jsonb,
  status                   text NOT NULL DEFAULT 'queued',
  reasoning                text,
  tags                     text[],
  excluded                 text,
  submitted_bid_amount     numeric,
  submitted_connects_cost  numeric,
  milestones_json          jsonb,
  -- Freelancer Plus insights
  client_hire_rate         numeric,
  client_hires             integer,
  competitive_bid_low      numeric,
  competitive_bid_avg      numeric,
  competitive_bid_high     numeric,
  interviewing             integer,
  invites_sent             integer,
  unanswered_invites       integer,
  -- Enhanced insights
  payment_verified         boolean,
  screening_question_count integer,
  bid_competitiveness      numeric,
  submitted_at             timestamptz,
  offer_type               text,
  -- Proof artifact
  proof_artifact_url       text,
  proof_artifact_json      jsonb,
  -- Outcome
  outcome_at               timestamptz,
  -- Timestamps
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_upwork_proposals_status     ON upwork_proposals(status);
CREATE INDEX IF NOT EXISTS idx_upwork_proposals_score      ON upwork_proposals(score DESC);
CREATE INDEX IF NOT EXISTS idx_upwork_proposals_created_at ON upwork_proposals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_upwork_proposals_tags       ON upwork_proposals USING GIN(tags);

-- ==========================================================================
-- crm_contacts — prospects from Chrome / LinkedIn discovery
-- ==========================================================================
CREATE TABLE IF NOT EXISTS crm_contacts (
  id              bigserial PRIMARY KEY,
  platform        text NOT NULL,
  username        text NOT NULL,
  display_name    text,
  bio             text,
  follower_count  integer,
  icp_score       numeric,
  pipeline_stage  text DEFAULT 'new',
  source          text,
  profile_url     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, username)
);

CREATE INDEX IF NOT EXISTS idx_crm_contacts_platform ON crm_contacts(platform);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_pipeline ON crm_contacts(pipeline_stage);

-- ==========================================================================
-- actp_agent_audit_log — every agent action
-- ==========================================================================
CREATE TABLE IF NOT EXISTS actp_agent_audit_log (
  id          bigserial PRIMARY KEY,
  agent_id    text,
  action_type text,
  status      text,
  result      jsonb,
  started_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_started ON actp_agent_audit_log(started_at DESC);

-- ==========================================================================
-- youtube_content_ideas (migration 001)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS youtube_content_ideas (
  id                  bigserial PRIMARY KEY,
  title               text NOT NULL,
  slug                text UNIQUE,
  description         text,
  hook                text,
  category            text NOT NULL,
  job_count           integer DEFAULT 0,
  avg_budget          numeric(10,2),
  max_budget          numeric(10,2),
  budget_range        text,
  demand_trend        text,
  competition_level   text,
  example_jobs        jsonb DEFAULT '[]',
  tech_stack          text[],
  difficulty          text DEFAULT 'intermediate',
  estimated_duration  text,
  tutorial_outline    jsonb,
  status              text DEFAULT 'idea',
  priority            integer DEFAULT 0,
  youtube_url         text,
  views               integer,
  demand_score        numeric(3,1),
  uniqueness_score    numeric(3,1),
  feasibility_score   numeric(3,1),
  overall_score       numeric(3,1),
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now(),
  analyzed_at         timestamptz,
  published_at        timestamptz
);

CREATE INDEX IF NOT EXISTS idx_youtube_ideas_category ON youtube_content_ideas(category);
CREATE INDEX IF NOT EXISTS idx_youtube_ideas_status   ON youtube_content_ideas(status);
CREATE INDEX IF NOT EXISTS idx_youtube_ideas_score    ON youtube_content_ideas(overall_score DESC);

-- ==========================================================================
-- upwork_analytics_snapshots (migration 004 — renamed from analytics_snapshots
-- to avoid colliding with another app's analytics_snapshots in this project)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS upwork_analytics_snapshots (
  id                   uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  snapshot_type        text NOT NULL,
  created_at           timestamptz DEFAULT now(),
  total_jobs           integer,
  total_budget         numeric,
  avg_budget           numeric,
  avg_score            numeric,
  status_breakdown     jsonb,
  score_distribution   jsonb,
  submitted            integer,
  won                  integer,
  rejected             integer,
  win_rate             numeric,
  avg_time_to_outcome  numeric,
  budget_tiers         jsonb,
  optimal_bid_range    jsonb,
  hourly_vs_fixed      jsonb,
  niches               jsonb,
  top_niches           jsonb,
  top_tech_combos      jsonb,
  client_pain_points   jsonb,
  red_flags            jsonb,
  top_skills           jsonb,
  best_days            jsonb,
  volume_trend         text,
  jobs_per_week        jsonb,
  error_rate           numeric,
  source_comparison    jsonb,
  plus_insights        jsonb,
  recommendations      jsonb,
  narrative_report     text,
  content_ideas        jsonb,
  date_range           jsonb,
  proposal_count       integer
);

CREATE INDEX IF NOT EXISTS idx_uas_type_date ON upwork_analytics_snapshots(snapshot_type, created_at DESC);

-- ==========================================================================
-- content_briefs (migration 004)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS content_briefs (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at    timestamptz DEFAULT now(),
  brief_type    text NOT NULL,
  title         text NOT NULL,
  summary       text,
  full_content  text,
  data_sources  jsonb,
  tags          text[],
  status        text DEFAULT 'draft',
  metadata      jsonb
);

CREATE INDEX IF NOT EXISTS idx_content_briefs_type_date ON content_briefs(brief_type, created_at DESC);

-- ==========================================================================
-- tracked_links + link_clicks (migration 006) — short-link redirect logging
-- ==========================================================================
CREATE TABLE IF NOT EXISTS tracked_links (
  slug         text PRIMARY KEY,
  target_url   text NOT NULL,
  link_type    text NOT NULL,
  job_id       text,
  niche        text,
  label        text,
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

-- ==========================================================================
-- niche_performance (migration 008) — outcome → reinforcement loop cache
-- ==========================================================================
CREATE TABLE IF NOT EXISTS niche_performance (
  niche                text PRIMARY KEY,
  win_rate             numeric,
  response_rate        numeric,
  sample_count         integer NOT NULL,
  won_count            integer NOT NULL DEFAULT 0,
  lost_count           integer NOT NULL DEFAULT 0,
  no_response_count    integer NOT NULL DEFAULT 0,
  interviewed_count    integer NOT NULL DEFAULT 0,
  winning_patterns     text,
  winning_slot_freq    jsonb,
  avg_win_bid          numeric,
  avg_loss_bid         numeric,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_niche_performance_win_rate ON niche_performance(win_rate DESC);
