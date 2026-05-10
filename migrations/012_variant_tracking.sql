-- migrations/012_variant_tracking.sql
-- Records which A/B prompt variant was used for each proposal so the variant-performance
-- leaderboard can show "variant X has 18% win rate, variant Y has 31% win rate" per niche.
-- Captured at generation time from getLastVariantPicked() in src/Agent/index.ts; null when
-- no variant was defined for the job's niche (default prompt path).

ALTER TABLE upwork_proposals
  ADD COLUMN IF NOT EXISTS variant_niche text,
  ADD COLUMN IF NOT EXISTS variant_name text;

CREATE INDEX IF NOT EXISTS idx_upwork_proposals_variant
  ON upwork_proposals (variant_niche, variant_name)
  WHERE variant_niche IS NOT NULL;
