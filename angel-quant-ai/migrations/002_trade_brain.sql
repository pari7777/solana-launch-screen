-- Self-learning trade scorer: one row per stock signal (traded or not) with its shadow outcome.
CREATE TABLE IF NOT EXISTS ml_samples (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ DEFAULT now(),
  signal_at TIMESTAMPTZ,
  strategy TEXT,
  symbol TEXT,
  side TEXT,
  traded BOOLEAN,
  label SMALLINT,          -- 1 = would have made money after charges, 0 = would have lost
  net DOUBLE PRECISION,
  outcome TEXT,            -- target | stop | square-off
  feats JSONB
);
CREATE INDEX IF NOT EXISTS ml_samples_at ON ml_samples (signal_at);
