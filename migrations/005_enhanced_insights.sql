-- Enhanced insights: payment verification, screening questions, bid competitiveness, submission timing
ALTER TABLE upwork_proposals ADD COLUMN IF NOT EXISTS payment_verified boolean;
ALTER TABLE upwork_proposals ADD COLUMN IF NOT EXISTS screening_question_count integer;
ALTER TABLE upwork_proposals ADD COLUMN IF NOT EXISTS bid_competitiveness numeric;  -- our_bid / avg_competitive_bid (< 1 = undercut, > 1 = premium)
ALTER TABLE upwork_proposals ADD COLUMN IF NOT EXISTS submitted_at timestamptz;     -- actual submission time (vs created_at = first scraped)
ALTER TABLE upwork_proposals ADD COLUMN IF NOT EXISTS offer_type text;              -- fixed or hourly
