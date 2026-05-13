-- Cached per-niche outcome stats — refreshed weekly by computeNichePerformance().
-- Read at proposal-generation time so we can:
--   1. Inject "what's been winning in this niche recently" into the prompt
--   2. Bias the scorer toward niches with high win/response rates
CREATE TABLE IF NOT EXISTS niche_performance (
  niche                text PRIMARY KEY,
  win_rate             numeric,         -- won / (won + lost)
  response_rate        numeric,         -- (won + interviewed) / total_with_outcome
  sample_count         integer NOT NULL,
  won_count            integer NOT NULL DEFAULT 0,
  lost_count           integer NOT NULL DEFAULT 0,
  no_response_count    integer NOT NULL DEFAULT 0,
  interviewed_count    integer NOT NULL DEFAULT 0,
  winning_patterns     text,            -- short narrative of what won (LLM-summarized or rule-extracted)
  winning_slot_freq    jsonb,           -- { problem: 0.95, solution: 1.0, proof: 0.7, ... } share of winners with each beat
  avg_win_bid          numeric,
  avg_loss_bid         numeric,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_niche_performance_win_rate ON niche_performance(win_rate DESC);
