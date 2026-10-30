-- Additions for the running bot (lookups, learned flags, positions)
CREATE INDEX launches_mint_idx ON launches (mint);
CREATE INDEX launches_creator_idx ON launches (creator, received_at);
CREATE INDEX launches_received_idx ON launches (received_at);
CREATE INDEX wallet_edges_dest_idx ON wallet_edges (destination_wallet, edge_type);
CREATE INDEX wallet_edges_source_idx ON wallet_edges (source_wallet, edge_type);
CREATE INDEX decision_history_mint_idx ON decision_history (mint, created_at);
CREATE INDEX decision_history_created_idx ON decision_history (created_at);

ALTER TABLE launches ADD COLUMN name TEXT;
ALTER TABLE launches ADD COLUMN symbol TEXT;
ALTER TABLE decision_history ADD COLUMN output JSON;      -- JSON (not JSONB) keeps the exact key order of the decision format

-- Wallets the engine has learned to distrust (RUGGER, RUG_FUNDER)
CREATE TABLE wallet_flags (
    chain TEXT NOT NULL,
    wallet TEXT NOT NULL,
    flag TEXT NOT NULL,
    evidence JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (chain, wallet, flag)
);

-- Position lifecycle: PENDING -> OPEN -> EXIT_PENDING -> CLOSED
CREATE TABLE positions (
    chain TEXT NOT NULL,
    mint TEXT NOT NULL,
    mode TEXT NOT NULL,
    wallet TEXT,
    symbol TEXT,
    status TEXT NOT NULL,
    venue TEXT NOT NULL,
    tokens NUMERIC NOT NULL,
    cost_sol NUMERIC NOT NULL,
    net_liquidation_value NUMERIC,
    high_water_value NUMERIC,
    proceeds_sol NUMERIC,
    pnl_sol NUMERIC,
    exit_reason TEXT,
    buy_signature TEXT,
    sell_signature TEXT,
    score NUMERIC,
    meta JSONB NOT NULL DEFAULT '{}',
    opened_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    closed_at TIMESTAMPTZ,
    PRIMARY KEY (chain, mint, opened_at)
);
CREATE INDEX positions_status_idx ON positions (status);

CREATE TABLE kv (k TEXT PRIMARY KEY, v JSONB NOT NULL);
