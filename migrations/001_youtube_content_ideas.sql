-- YouTube Content Ideas table — auto-generated from Upwork job trend analysis
-- Run this in Supabase SQL editor

CREATE TABLE IF NOT EXISTS youtube_content_ideas (
  id BIGSERIAL PRIMARY KEY,

  -- Content idea
  title TEXT NOT NULL,                    -- "Build an n8n + Claude AI Automation Pipeline"
  slug TEXT UNIQUE,                       -- "n8n-claude-ai-pipeline"
  description TEXT,                       -- Full tutorial description
  hook TEXT,                              -- Opening hook / thumbnail text

  -- Market signal (from Upwork data)
  category TEXT NOT NULL,                 -- "n8n_automation", "ai_agent", "web_scraping", etc.
  job_count INTEGER DEFAULT 0,           -- How many Upwork jobs match this niche
  avg_budget NUMERIC(10,2),              -- Average budget of matching jobs
  max_budget NUMERIC(10,2),              -- Highest budget seen
  budget_range TEXT,                      -- "$500 - $5,000"
  demand_trend TEXT,                      -- "rising", "stable", "declining"
  competition_level TEXT,                 -- "low", "medium", "high"

  -- Example jobs (proof of demand)
  example_jobs JSONB DEFAULT '[]',       -- [{jobId, title, budget, score, url}]

  -- Tutorial structure
  tech_stack TEXT[],                      -- ["n8n", "claude-api", "google-sheets", "webhook"]
  difficulty TEXT DEFAULT 'intermediate', -- "beginner", "intermediate", "advanced"
  estimated_duration TEXT,                -- "45 min", "2 hours"
  tutorial_outline JSONB,                -- [{step, title, description, duration}]

  -- Performance tracking
  status TEXT DEFAULT 'idea',            -- "idea", "scripted", "filmed", "published"
  priority INTEGER DEFAULT 0,            -- Higher = more urgent (based on demand)
  youtube_url TEXT,                       -- Once published
  views INTEGER,                          -- Track performance

  -- Scoring (auto-calculated)
  demand_score NUMERIC(3,1),             -- 0-10 based on job_count + avg_budget
  uniqueness_score NUMERIC(3,1),         -- 0-10 how different from existing YT content
  feasibility_score NUMERIC(3,1),        -- 0-10 how fast can we build the demo
  overall_score NUMERIC(3,1),            -- Weighted average

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  analyzed_at TIMESTAMPTZ,               -- Last time market data was refreshed
  published_at TIMESTAMPTZ
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_youtube_ideas_category ON youtube_content_ideas(category);
CREATE INDEX IF NOT EXISTS idx_youtube_ideas_status ON youtube_content_ideas(status);
CREATE INDEX IF NOT EXISTS idx_youtube_ideas_score ON youtube_content_ideas(overall_score DESC);

-- RLS (if needed)
ALTER TABLE youtube_content_ideas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON youtube_content_ideas FOR ALL USING (true);
