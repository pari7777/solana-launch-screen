"""Charges and profitability engine.

Pre-trade decisions use a fast local model of every statutory and broker charge (rates in config/charges.json,
taken from Angel One's published tariff). When logged in, the model is cross-checked against Angel One's official
estimateCharges API; estimated and actual charges are stored separately per trade.
"""
from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass
from pathlib import Path

log = logging.getLogger("charges")
CFG_PATH = Path(__file__).resolve().parents[2] / "config" / "charges.json"


@dataclass
class Charges:
    brokerage: float = 0.0
    stt: float = 0.0
    exchange: float = 0.0
    sebi: float = 0.0
    stamp: float = 0.0
    ipft: float = 0.0
    gst: float = 0.0
    dp: float = 0.0

    @property
    def total(self) -> float:
        return round(self.brokerage + self.stt + self.exchange + self.sebi + self.stamp + self.ipft + self.gst + self.dp, 2)

    def __add__(self, o: "Charges") -> "Charges":
        return Charges(**{k: round(getattr(self, k) + getattr(o, k), 4) for k in asdict(self)})

    def as_dict(self) -> dict:
        d = {k: round(v, 2) for k, v in asdict(self).items()}
        d["total"] = self.total
        return d


def segment_of(itype: str, product: str) -> str:
    if itype in ("OPTIDX", "OPTSTK"):
        return "OPT"
    if itype in ("FUTIDX", "FUTSTK"):
        return "FUT"
    return "EQ_DELIVERY" if product == "DELIVERY" else "EQ_INTRADAY"


class ChargeModel:
    def __init__(self, path: Path = CFG_PATH):
        self.cfg = json.loads(path.read_text())

    def leg(self, segment: str, side: str, price: float, qty: int, exchange: str = "NSE") -> Charges:
        """Charges for ONE executed order (one side). For options, price is the premium."""
        seg = self.cfg["segments"][segment]
        turnover = price * qty
        b = seg["brokerage"]
        if b["type"] == "flat":
            brokerage = b["amount"] if qty > 0 else 0.0
        else:
            brokerage = max(b.get("min", 0), min(b["cap"], turnover * b["pct"] / 100)) if qty > 0 else 0.0
        stt = turnover * (seg["stt_sell_pct"] if side == "SELL" else seg["stt_buy_pct"]) / 100
        exch = turnover * seg["txn_pct"].get(exchange, seg["txn_pct"]["NSE"]) / 100
        sebi = turnover * self.cfg["sebi_per_crore"] / 1e7
        ipft = turnover * self.cfg["ipft_pct"] / 100 if exchange == "NSE" else 0.0
        stamp = turnover * seg["stamp_buy_pct"] / 100 if side == "BUY" else 0.0
        gst = (brokerage + exch + sebi + ipft) * self.cfg["gst_pct"] / 100
        dp = self.cfg["dp_charge_per_isin_sell"] * (1 + self.cfg["gst_pct"] / 100) if (segment == "EQ_DELIVERY" and side == "SELL") else 0.0
        # STT and stamp duty are rounded to the rupee by the exchange/depository
        return Charges(brokerage=brokerage, stt=round(stt), exchange=exch, sebi=sebi, stamp=round(stamp), ipft=ipft, gst=gst, dp=dp)

    def round_trip(self, segment: str, entry_side: str, entry: float, exit_: float, qty: int, exchange: str = "NSE") -> Charges:
        exit_side = "SELL" if entry_side == "BUY" else "BUY"
        return self.leg(segment, entry_side, entry, qty, exchange) + self.leg(segment, exit_side, exit_, qty, exchange)


def estimate_payload(ins, side: str, qty: int, price: float, product: str) -> dict:
    """One order in Angel One's estimateCharges request format (numbers, not strings)."""
    return {"product_type": product, "transaction_type": side, "quantity": int(qty), "price": float(price),
            "exchange": ins.exchange, "symbol_name": ins.symbol, "token": ins.token}


def parse_estimate(d: dict) -> float | None:
    """Total charges from an estimateCharges response (summary.total_charges)."""
    try:
        s = d.get("summary") or {}
        v = s.get("total_charges")
        return float(v) if v is not None else None
    except (TypeError, ValueError, AttributeError):
        return None
