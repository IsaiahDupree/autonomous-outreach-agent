-- Analytics snapshots table: stores periodic analytics data for external apps (podcast, YouTube, dashboards)
CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  snapshot_type text NOT NULL,           -- 'full', 'weekly', 'niche', 'content_brief'
  created_at timestamptz DEFAULT now(),

  -- Overview metrics
  total_jobs integer,
  total_budget numeric,
  avg_budget numeric,
  avg_score numeric,
  status_breakdown jsonb,                -- {"queued":5,"submitted":3,"won":1,...}
  score_distribution jsonb,              -- {"9-10":5,"7-8":12,...}

  -- Close rate
  submitted integer,
  won integer,
  rejected integer,
  win_rate numeric,
  avg_time_to_outcome numeric,

  -- Pricing intelligence
  budget_tiers jsonb,                    -- [{tier:"$500-$1K",count:20,winRate:25}]
  optimal_bid_range jsonb,               -- {min:500,max:1500,sweetSpot:800}
  hourly_vs_fixed jsonb,                 -- {hourly:30,fixed:70}

  -- Niche performance
  niches jsonb,                          -- [{niche:"AI/Automation",count:50,avgBudget:1200,winRate:30}]
  top_niches jsonb,                      -- top 5 niches by job count

  -- Text mining / trends
  top_tech_combos jsonb,                 -- [{combo:"n8n + openai",count:15}]
  client_pain_points jsonb,              -- [{phrase:"need automation",count:20}]
  red_flags jsonb,                       -- [{pattern:"urgent",avgScore:3}]
  top_skills jsonb,                      -- [{tag:"python",count:30,winRate:25}]

  -- Timing
  best_days jsonb,                       -- [{day:"Monday",avgScore:7.2}]
  volume_trend text,                     -- 'increasing', 'decreasing', 'stable'
  jobs_per_week jsonb,                   -- [{week:"2026-W10",count:45}]

  -- Pipeline health
  error_rate numeric,
  source_comparison jsonb,               -- {search:{count:100,avgScore:6},bestMatches:{count:50,avgScore:7}}

  -- AI-generated content (ready for podcast/video)
  recommendations jsonb,                 -- ["Focus on AI agent jobs","Raise bid to $1200",...]
  narrative_report text,                 -- Full narrated script for YouTube/podcast
  content_ideas jsonb,                   -- YouTube video ideas from niche data

  -- Metadata
  date_range jsonb,                      -- {first:"2026-01-01",last:"2026-03-14"}
  proposal_count integer                 -- total proposals analyzed
);

-- Index for fast lookups by type and date
CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_type_date
  ON analytics_snapshots(snapshot_type, created_at DESC);

-- Content briefs table: pre-packaged content for external apps
CREATE TABLE IF NOT EXISTS content_briefs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  brief_type text NOT NULL,              -- 'podcast_episode', 'youtube_script', 'market_report', 'weekly_digest'
  title text NOT NULL,
  summary text,                          -- 2-3 sentence summary
  full_content text,                     -- Full script/brief
  data_sources jsonb,                    -- {analytics_snapshot_id:"...",proposal_count:1353}
  tags text[],                           -- ['ai-automation','market-trends','weekly']
  status text DEFAULT 'draft',           -- 'draft', 'published', 'archived'
  metadata jsonb                         -- any extra data (duration, word count, etc.)
);

CREATE INDEX IF NOT EXISTS idx_content_briefs_type_date
  ON content_briefs(brief_type, created_at DESC);
