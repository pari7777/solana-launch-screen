-- Angel Quant AI schema
CREATE TABLE IF NOT EXISTS positions (
  id BIGINT PRIMARY KEY,
  mode TEXT NOT NULL,
  strategy TEXT NOT NULL,
  underlying TEXT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  product TEXT NOT NULL,
  qty INT,
  entry_price DOUBLE PRECISION,
  exit_price DOUBLE PRECISION,
  initial_stop DOUBLE PRECISION,
  target DOUBLE PRECISION,
  status TEXT NOT NULL,
  reason TEXT,
  exit_reason TEXT,
  gross DOUBLE PRECISION,
  charges_est DOUBLE PRECISION,
  charges_actual DOUBLE PRECISION,
  charges_broker DOUBLE PRECISION,      -- from Angel One estimateCharges, when available
  slippage_est DOUBLE PRECISION,
  net DOUBLE PRECISION,
  capital DOUBLE PRECISION,
  plan JSONB,
  claude JSONB,
  legs JSONB,
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS positions_closed ON positions (closed_at);
CREATE INDEX IF NOT EXISTS positions_strategy ON positions (strategy, closed_at);

CREATE TABLE IF NOT EXISTS orders (
  client_ref TEXT PRIMARY KEY,
  broker_id TEXT,
  position_id BIGINT,
  mode TEXT,
  symbol TEXT,
  side TEXT,
  qty INT,
  price DOUBLE PRECISION,
  purpose TEXT,
  status TEXT,
  filled INT,
  avg_price DOUBLE PRECISION,
  charges DOUBLE PRECISION,
  ack_ms DOUBLE PRECISION,
  first_fill_ms DOUBLE PRECISION,
  reprices INT,
  reject_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signals (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ DEFAULT now(),
  strategy TEXT,
  symbol TEXT,
  decision TEXT,           -- TRADED | REJECTED | VETOED
  reason TEXT,
  plan JSONB
);
CREATE INDEX IF NOT EXISTS signals_at ON signals (at);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ DEFAULT now(),
  kind TEXT,
  message TEXT,
  data JSONB
);

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v JSONB, updated_at TIMESTAMPTZ DEFAULT now());
