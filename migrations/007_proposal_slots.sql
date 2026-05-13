-- Per-proposal structured slots (problem / solution / proof / portfolio / prior_results / cta).
-- Generated alongside the cover letter so the dashboard can show which beats each proposal hit
-- and so the outcome-feedback loop can correlate slot patterns with win rate.
ALTER TABLE upwork_proposals ADD COLUMN IF NOT EXISTS proposal_slots_json jsonb;
