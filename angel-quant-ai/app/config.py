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
    paper_capital: float = 100_000.0

    # ── API limits (SmartAPI: 10 order requests/s; we stay below) ──
    order_rate_per_sec: float = 8.0
    quote_rate_per_sec: float = 9.0
    candle_rate_per_sec: float = 2.5
    other_rate_per_sec: float = 2.0
    max_ws_tokens: int = 900                    # SmartAPI allows up to 1000 tokens per connection

    # ── universe ──
    stock_universe: str = ("RELIANCE,HDFCBANK,ICICIBANK,INFY,TCS,SBIN,AXISBANK,KOTAKBANK,LT,BHARTIARTL,ITC,HINDUNILVR,"
                           "BAJFINANCE,MARUTI,TATAMOTORS,SUNPHARMA,M&M,TITAN,ULTRACEMCO,NTPC")
    option_underlyings: str = "NIFTY,BANKNIFTY,FINNIFTY"

    # ── strategy switches ──
    enable_stock_intraday: bool = True
    enable_options_scalping: bool = True
    enable_options_directional: bool = True
    enable_swing: bool = False                  # needs daily candles + owner review; off by default

    # ── risk (₹) ──
    max_capital_per_trade_pct: float = 10.0
    max_risk_per_trade_pct: float = 0.5         # loss at stop as % of capital
    max_open_positions: int = 4
    max_daily_loss_pct: float = 2.0
    max_weekly_loss_pct: float = 5.0
    max_drawdown_pct: float = 10.0
    max_consecutive_losses: int = 4
    max_option_premium_pct: float = 15.0        # total premium paid across open option buys
    max_per_underlying_pct: float = 20.0
    max_order_qty_lots: int = 4
    min_net_reward_rupees: float = 150.0        # expected net profit after ALL costs, per trade
    min_reward_risk: float = 1.5
    stale_data_seconds: float = 5.0
    no_new_entries_after: time = time(14, 45)
    square_off_intraday_at: time = time(15, 12)

    # ── trailing / profit booking ──
    trail_start_r: float = 1.0                  # start trailing once profit ≥ 1 × initial risk
    trail_gap_r: float = 0.8
    partial_book_r: float = 1.5                 # book part of the position at 1.5 R
    partial_book_fraction: float = 0.5

    # ── Claude decision support ──
    anthropic_api_key: SecretStr = SecretStr("")
    claude_model: str = "claude-sonnet-5-5"
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
