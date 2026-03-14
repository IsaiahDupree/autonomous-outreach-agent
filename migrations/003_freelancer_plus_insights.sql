-- Freelancer Plus competitive insights columns
ALTER TABLE upwork_proposals ADD COLUMN IF NOT EXISTS client_hire_rate integer;
ALTER TABLE upwork_proposals ADD COLUMN IF NOT EXISTS client_hires integer;
ALTER TABLE upwork_proposals ADD COLUMN IF NOT EXISTS competitive_bid_low numeric;
ALTER TABLE upwork_proposals ADD COLUMN IF NOT EXISTS competitive_bid_avg numeric;
ALTER TABLE upwork_proposals ADD COLUMN IF NOT EXISTS competitive_bid_high numeric;
ALTER TABLE upwork_proposals ADD COLUMN IF NOT EXISTS interviewing integer;
ALTER TABLE upwork_proposals ADD COLUMN IF NOT EXISTS invites_sent integer;
ALTER TABLE upwork_proposals ADD COLUMN IF NOT EXISTS unanswered_invites integer;
