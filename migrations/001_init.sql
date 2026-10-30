-- Schema as specified (unchanged)
CREATE TABLE launches (
    chain TEXT NOT NULL,
    signature TEXT NOT NULL,
    instruction_index INTEGER NOT NULL,
    mint TEXT NOT NULL,
    creator TEXT,
    slot BIGINT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,
    decision TEXT NOT NULL DEFAULT 'WAIT',
    score NUMERIC,
    data_completeness NUMERIC,
    PRIMARY KEY (chain, signature, instruction_index)
);

CREATE TABLE rule_results (
    chain TEXT NOT NULL,
    signature TEXT NOT NULL,
    instruction_index INTEGER NOT NULL,
    rule_id TEXT NOT NULL,
    status TEXT NOT NULL,
    severity TEXT NOT NULL,
    evidence JSONB NOT NULL DEFAULT '{}',
    evaluated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (
      chain, signature, instruction_index, rule_id
    )
);

CREATE TABLE wallet_edges (
    chain TEXT NOT NULL,
    source_wallet TEXT NOT NULL,
    destination_wallet TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    signature TEXT NOT NULL,
    slot BIGINT NOT NULL,
    amount_lamports NUMERIC,
    evidence JSONB NOT NULL DEFAULT '{}',
    PRIMARY KEY (chain, signature, source_wallet,
                  destination_wallet, edge_type)
);

CREATE TABLE decision_history (
    id BIGSERIAL PRIMARY KEY,
    chain TEXT NOT NULL,
    mint TEXT NOT NULL,
    decision TEXT NOT NULL,
    score NUMERIC,
    reasons JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE provider_health (
    provider TEXT PRIMARY KEY,
    last_success_at TIMESTAMPTZ,
    last_slot BIGINT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL
);
