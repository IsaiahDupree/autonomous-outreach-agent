-- Enhanced Plus insights: payment verification, screening questions, bid competitiveness, submission timing
ALTER TABLE upwork_proposals ADD COLUMN IF NOT EXISTS payment_verified boolean;
ALTER TABLE upwork_proposals ADD COLUMN IF NOT EXISTS screening_question_count integer;
ALTER TABLE upwork_proposals ADD COLUMN IF NOT EXISTS bid_competitiveness numeric;
ALTER TABLE upwork_proposals ADD COLUMN IF NOT EXISTS submitted_at timestamptz;
ALTER TABLE analytics_snapshots ADD COLUMN IF NOT EXISTS plus_insights jsonb;
