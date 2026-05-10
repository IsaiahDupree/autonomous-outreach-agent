-- migrations/011_posted_at.sql
-- Absolute timestamp of when the job was posted on Upwork. Parsed from the relative
-- "X minutes/hours/days ago" string Upwork shows on search tiles, snapshotted at the moment
-- we scraped the job. Lets us compute time_from_post_to_submit, the most direct measure of
-- "did we actually beat other freelancers to the punch".

ALTER TABLE upwork_proposals
  ADD COLUMN IF NOT EXISTS posted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_upwork_proposals_posted_at
  ON upwork_proposals (posted_at DESC)
  WHERE posted_at IS NOT NULL;
