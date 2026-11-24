"""All settings come from environment variables (Railway → Variables, or a local .env).
Secrets (API key, MPIN, TOTP secret, Anthropic key) are never written to code, logs or the database."""
from __future__ import annotations

from datetime import time
from functools import lru_cache

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # ── Angel One SmartAPI (secrets) ──
    angel_api_key: SecretStr = SecretStr("")
    # SmartAPI serves candle history only to a "Historical Data" app key (a Trading key gets AG8004 Invalid API Key).
    # Optional: without it the bot builds candles from live ticks after 09:15.
    angel_historical_api_key: SecretStr = SecretStr("")
    angel_client_code: str = ""
    angel_mpin: SecretStr = SecretStr("")
    angel_totp_secret: SecretStr = SecretStr("")
    angel_root: str = "https://apiconnect.angelone.in"
    angel_ws_url: str = "wss://smartapisocket.angelone.in/smart-stream"
    scrip_master_url: str = "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json"
    client_local_ip: str = "127.0.0.1"
    client_public_ip: str = "127.0.0.1"
    client_mac: str = "00:00:00:00:00:00"

    # ── mode ──
    trading_mode: str = "paper"                 # paper | live
    live_trading_confirm: str = "NO"            # must be exactly "YES" together with trading_mode=live
    static_ip_registered: bool = False          # owner confirms the outbound IP is registered with Angel One
    order_tag: str = "AQAI"
    # paper track record required before live orders are allowed (checked from the database at start-up)
    acceptance_min_paper_trades: int = 100
    acceptance_min_profit_factor: float = 1.2
    acceptance_min_net: float = 0.0                     # ordertag sent with every live order (audit trail)
    paper_capital: float = 1_000_000.0           # owner 17 Nov 2026: paper capital ₹10 lakh

    # ── API limits (SmartAPI: 10 order requests/s; we stay below) ──
    order_rate_per_sec: float = 8.0
    quote_rate_per_sec: float = 9.0
    candle_rate_per_sec: float = 2.5
    other_rate_per_sec: float = 2.0
    max_ws_tokens: int = 900                    # SmartAPI allows up to 1000 tokens per connection

    # ── universe ──
    stock_universe: str = ("RELIANCE,HDFCBANK,ICICIBANK,INFY,TCS,SBIN,AXISBANK,KOTAKBANK,LT,BHARTIARTL,ITC,HINDUNILVR,"
                           "BAJFINANCE,MARUTI,TATAMOTORS,SUNPHARMA,M&M,TITAN,ULTRACEMCO,NTPC")
    # official NSE index lists downloaded each day (mid & small caps by default); empty = use STOCK_UNIVERSE only
    stock_universe_indexes: str = "NIFTY MIDCAP SELECT,NIFTY SMALLCAP 50"
    # ── AI brain: news & sentiment + daily learning loop ──
    news_enabled: bool = True
    news_every_min: int = 15
    news_block_score: float = 0.5               # skip a long when the stock's news score ≤ −0.5 (short when ≥ +0.5)
    flow_enabled: bool = True                   # big-player flow (book pressure, big prints, bulk/block deals) + manipulation guard
    flow_block_score: float = 0.45              # skip a long when big-player flow ≤ −0.45 (short when ≥ +0.45)
    flow_big_print_rupees: float = 1_000_000.0  # one tick worth ≥ ₹10 lakh counts as a big print
    learn_enabled: bool = True
    learn_lookback_days: int = 20               # trading days of closed trades the loop looks at
    learn_min_trades: int = 15                  # less evidence than this → no change
    learn_pause_days: int = 5
    # self-learning trade scorer (app/ai/scorer.py): learns from every signal's real outcome, retrained nightly
    brain_enabled: bool = True
    # World Market Brain (dashboard Deep Dive tab): world prices, news & sentiment, 24 h odds, self-grading. Display only.
    world_enabled: bool = True
    world_every_min: int = 60
    brain_min_samples: int = 300                # lessons needed before the first model
    brain_min_auc: float = 0.55                 # adopt a model only if it beats chance on unseen recent days
    brain_min_prob: float = 0.30                # skip signals whose win chance is below this (once a model is adopted)
    brain_pretrain_days: int = 365              # past days replayed once (Angel One history; Yahoo gives ~29 days)
    fast_scan_seconds: float = 5.0              # fast strategies (momentum burst) re-check the live price this often
    # ── research rules (owner 17 Nov 2026) ──
    rule_skip_open_min: int = 10                # no new entries in the first N minutes after 09:15 (noisy auction prices)
    rule_momentum: bool = True                  # no longs in the weakest, no shorts in the strongest 20-day performers
    momentum_block_pct: float = 0.30            # weakest/strongest 30 % of the universe
    vix_half_size: float = 20.0                 # India VIX above this → half size on new trades
    vix_no_entries: float = 25.0                # India VIX above this → no new trades
    paper_test_start: str = "2026-11-16"         # owner 13 Nov 2026: 30-day paper test of the stocks-only mid/small-cap plan
    paper_test_days: int = 30
    shortlist_size: int = 30                    # trade only the day's N most active stocks (turnover × move), refreshed every 15 min
    max_stock_spread_pct: float = 0.15          # skip a stock while its bid–ask gap is wider than this (thin small caps)
    universe_keep_static: bool = False          # true: trade STOCK_UNIVERSE (large caps) as well
    # used when the index lists cannot be downloaded: Nifty Midcap Select top 10 (factsheet 30 Oct 2026) + Smallcap 50 names
    midsmall_fallback: str = ("FEDERALBNK,MCX,INDHOTEL,PAYTM,HEROMOTOCO,PERSISTENT,BHEL,INDUSINDBK,AUBANK,GVT&D,"
                              "AEGISLOG,APOLLOTYRE,GESHIP,TATACHEM,HFCL")
    option_underlyings: str = "NIFTY,BANKNIFTY,FINNIFTY"

    # ── strategy switches ──
    enable_stock_intraday: bool = True
    enable_options_scalping: bool = False       # owner 13 Nov 2026: stocks only — no options or futures
    enable_options_directional: bool = False
    enable_swing: bool = False                  # needs daily candles + owner review; off by default

    # ── risk (₹) ──
    max_capital_per_trade_pct: float = 10.0
    max_risk_per_trade_pct: float = 0.5         # loss at stop as % of capital
    max_open_positions: int = 10                # owner 17 Nov 2026: more paper trades (aim 50+/day)
    max_daily_loss_pct: float = 2.0
    max_weekly_loss_pct: float = 5.0
    max_drawdown_pct: float = 10.0
    max_consecutive_losses: int = 10
    max_option_premium_pct: float = 15.0        # total premium paid across open option buys
    max_per_underlying_pct: float = 20.0
    max_order_qty_lots: int = 4
    min_net_reward_rupees: float = 50.0         # expected net profit after ALL costs, per trade
    min_reward_risk: float = 1.5
    # owner 17 Nov 2026: every stock trade's stop-loss sits this % from entry (0 = use each strategy's own stop)
    stock_stop_pct: float = 2.0
    # PAPER ONLY: collect more trades for the learning loop — every strategy may trade in every market regime and
    # the negative-expected-value filter is skipped. Never applies in live mode.
    paper_explore: bool = True
    stale_data_seconds: float = 5.0
    no_new_entries_after: time = time(14, 45)
    square_off_intraday_at: time = time(15, 12)

    # ── trailing / profit booking ──
    trail_start_r: float = 0.5                  # start trailing once profit ≥ 0.5 × initial risk (+1% with a 2% stop)
    trail_gap_r: float = 0.8
    partial_book_r: float = 1.0                 # book part of the position at 1 R
    partial_book_fraction: float = 0.5

    # ── Claude decision support ──
    anthropic_api_key: SecretStr = SecretStr("")
    claude_model: str = "claude-haiku-5-5"      # owner 17 Nov 2026: Haiku during the paper test (CLAUDE_MODEL to change)
    claude_review_trades: bool = True           # Claude may veto a trade; it can never create or size one
    claude_timeout_s: float = 6.0
    claude_max_calls_per_hour: int = 60
    claude_required: bool = False               # true: no trade when Claude cannot be reached

    # ── infra ──
    database_url: str = ""
    redis_url: str = ""
    data_dir: str = "./data"
    port: int = Field(default=8000, validation_alias="PORT")
    dashboard_password: SecretStr = SecretStr("")
    log_level: str = "INFO"

    @field_validator("trading_mode")
    @classmethod
    def _mode(cls, v: str) -> str:
        v = v.lower().strip()
        if v not in ("paper", "live"):
            raise ValueError("TRADING_MODE must be paper or live")
        return v

    @property
    def stocks(self) -> list[str]:
        return [s.strip().upper() for s in self.stock_universe.split(",") if s.strip()]

    @property
    def underlyings(self) -> list[str]:
        return [s.strip().upper() for s in self.option_underlyings.split(",") if s.strip()]

    @property
    def has_angel_credentials(self) -> bool:
        return all([self.angel_api_key.get_secret_value(), self.angel_client_code,
                    self.angel_mpin.get_secret_value(), self.angel_totp_secret.get_secret_value()])

    def live_blockers(self) -> list[str]:
        """Every reason live orders are not allowed right now. Empty list = allowed."""
        out = []
        if self.trading_mode != "live":
            out.append("TRADING_MODE is not 'live'")
        if self.live_trading_confirm != "YES":
            out.append("LIVE_TRADING_CONFIRM is not 'YES' (explicit owner approval)")
        if not self.static_ip_registered:
            out.append("STATIC_IP_REGISTERED is not true (SEBI/Angel One: orders only from a registered static IP)")
        if not self.has_angel_credentials:
            out.append("Angel One credentials missing")
        return out


@lru_cache
def get_settings() -> Settings:
    return Settings()
