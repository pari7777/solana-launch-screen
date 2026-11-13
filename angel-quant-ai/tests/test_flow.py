"""Big-player flow and manipulation guard."""
from types import SimpleNamespace

from app.market.flow import FlowBrain, imbalance, parse_deals


def _e():
    return SimpleNamespace(s=SimpleNamespace(flow_block_score=0.45, flow_big_print_rupees=1_000_000, stocks=["AAA"]), event=lambda *a: None)


def _t(ltp, vol, buy=0, sell=0, bid=0, ask=0, uc=0, lc=0):
    return SimpleNamespace(ltp=ltp, volume=vol, total_buy_qty=buy, total_sell_qty=sell, bid=bid, ask=ask, upper_circuit=uc, lower_circuit=lc)


def test_imbalance_and_pressure():
    assert imbalance(300, 100) == 0.5 and imbalance(0, 0) == 0.0
    b = FlowBrain(_e())
    for i in range(60):
        b.on_tick("AAA", _t(100, 1000 + i * 10, buy=100, sell=900, bid=99.9, ask=100))
    assert b.by["AAA"].pressure < -0.5
    assert b.gate("AAA", "LONG").startswith("big players selling")
    assert b.gate("AAA", "SHORT") is None


def test_big_prints_counted_on_aggressor_side():
    b = FlowBrain(_e())
    vol = 1000
    for _ in range(40):
        vol += 10
        b.on_tick("AAA", _t(100, vol, bid=99.9, ask=100))       # ₹1,000 a tick: normal
    vol += 20000
    b.on_tick("AAA", _t(100, vol, bid=99.9, ask=100))           # ₹20 lakh at the ask: big buy
    assert b.by["AAA"].big_buy == 1


def test_manipulation_guard():
    b = FlowBrain(_e())
    b.on_tick("AAA", _t(119, 10, uc=120))
    assert "circuit" in b.gate("AAA", "LONG")
    b2 = FlowBrain(_e())
    assert "pump" in b2.gate("BBB", "LONG", session_move_pct=12, vol_ratio=9, news_score=0.0)
    assert b2.gate("BBB", "LONG", session_move_pct=12, vol_ratio=9, news_score=0.8) is None
    b2.surveillance = {"CCC"}
    assert "surveillance" in b2.gate("CCC", "SHORT")


def test_bulk_deals_parse():
    csv_text = ("Date,Symbol,Security Name,Client Name,Buy/Sell,Quantity Traded,Trade Price / Wght. Avg. Price,Remarks\n"
                "13-NOV-2026,AAA,AAA LTD,BIG FUND,BUY,\"5,00,000\",120.50,-\n")
    d = parse_deals(csv_text)
    assert d["AAA"][0]["side"] == "BUY" and d["AAA"][0]["value_cr"] == round(500000 * 120.5 / 1e7, 2)
