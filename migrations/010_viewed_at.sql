-- migrations/010_viewed_at.sql
-- Soft-signal timestamp: when the client first viewed our proposal. Captured by the
-- notification → outcome auto-sync (proposal_viewed events) without changing the binary
-- status (won/rejected/interviewed/no_response). Used for "time-to-first-view" analytics
-- and to distinguish ignored proposals from those that landed but didn't convert.

ALTER TABLE upwork_proposals
  ADD COLUMN IF NOT EXISTS viewed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_upwork_proposals_viewed_at
  ON upwork_proposals (viewed_at)
  WHERE viewed_at IS NOT NULL;
