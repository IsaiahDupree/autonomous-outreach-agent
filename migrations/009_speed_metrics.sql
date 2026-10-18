-- migrations/009_speed_metrics.sql
-- "Are we actually first?" metrics. proposals_when_submitted is read off the apply form by
-- submitProposal at the moment we click Send, capturing how saturated the job already was.
-- time_to_submit_seconds is computed at read-time from posted ↔ submitted_at; no column needed.

ALTER TABLE upwork_proposals
  ADD COLUMN IF NOT EXISTS proposals_when_submitted integer;

CREATE INDEX IF NOT EXISTS idx_upwork_proposals_proposals_when_submitted
  ON upwork_proposals (proposals_when_submitted)
  WHERE proposals_when_submitted IS NOT NULL;
