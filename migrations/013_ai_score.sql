-- migrations/013_ai_score.sql
-- Persists the raw Stage-2 Claude rating (1-10) and reasoning to upwork_proposals.
-- The existing `score` column holds the niche-bias-adjusted final score, and `reasoning`
-- includes the appended bias note. ai_score/ai_reasoning capture the unadjusted Claude
-- output so cover-letter quality and scorer prompt drift can be audited independently.

ALTER TABLE upwork_proposals
  ADD COLUMN IF NOT EXISTS ai_score numeric,
  ADD COLUMN IF NOT EXISTS ai_reasoning text;
