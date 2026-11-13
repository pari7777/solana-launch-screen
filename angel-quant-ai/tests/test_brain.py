"""AI brain: news parsing/scoring/gate and the daily learning decisions."""
from types import SimpleNamespace

from app.ai.learn import decide, tick_pauses
from app.ai.news import NewsBrain, lexicon_score, parse_rss

RSS = """<?xml version="1.0"?><rss><channel>
<item><title>Federal Bank shares jump after Q2 profit rises 20%</title><source>ET</source><pubDate>Fri, 13 Nov 2026</pubDate></item>
<item><title>Federal Bank board meeting today to consider fund raise</title><source>BS</source></item>
</channel></rss>"""


def test_rss_and_lexicon():
    hs = parse_rss(RSS)
    assert len(hs) == 2 and hs[0]["source"] == "ET"
    score, event = lexicon_score([h["title"] for h in hs])
    assert score > 0 and event is True
    assert lexicon_score(["SEBI probe into promoter; shares plunge"])[0] < 0


def test_news_gate():
    import time
    e = SimpleNamespace(s=SimpleNamespace(news_block_score=0.5))
    b = NewsBrain(e)
    b.by_stock["AAA"] = {"score": -0.8, "event": False, "headlines": [{"title": "fraud probe"}], "why": "", "at": time.time()}
    b.by_stock["BBB"] = {"score": 0.2, "event": True, "headlines": [], "why": "", "at": time.time()}
    assert b.gate("AAA", "LONG").startswith("news against long")
    assert b.gate("AAA", "SHORT") is None
    assert "event day" in b.gate("BBB", "LONG")
    assert b.gate("CCC", "LONG") is None


def test_learning_decisions():
    s = SimpleNamespace(learn_min_trades=15, learn_pause_days=5)
    good = [300] * 10 + [-100] * 6            # PF 5, net +2400
    bad = [100] * 4 + [-200] * 12             # PF 0.17
    meh = [-50] * 3 + [40] * 13               # net +370, PF 3.5
    few = [-500] * 5
    st, ch = decide({}, {"orb": good, "vwap": bad, "rev": meh, "x": few}, s)
    assert st["weights"]["orb"] == 1.1 and "vwap" in st["paused"] and "x" not in st["weights"]
    st["weights"]["orb"] = 1.5
    st2, _ = decide(st, {"orb": good}, s)
    assert st2["weights"]["orb"] == 1.5         # capped
    for _ in range(5):
        back = tick_pauses(st2)
    assert "vwap" not in st2["paused"] and back


def test_morning_brief_without_claude(monkeypatch):
    import asyncio, time
    from app.ai import news as N
    async def fake_fetch(self, c, q):
        return [{"title": "Federal Bank wins order, shares jump" if "FEDERAL" in q.upper() else "Sensex flat", "source": "x", "at": ""}]
    monkeypatch.setattr(N.NewsBrain, "_fetch", fake_fetch)
    async def nosleep(*a, **k): return None
    monkeypatch.setattr(N.asyncio, "sleep", nosleep)
    ev = []
    e = SimpleNamespace(s=SimpleNamespace(stocks=["FEDERALBNK", "HFCL"], news_block_score=0.5, news_every_min=15),
                        im=SimpleNamespace(equity={"FEDERALBNK": SimpleNamespace(name="FEDERAL BANK"), "HFCL": SimpleNamespace(name="HFCL")}),
                        claude=SimpleNamespace(enabled=False), event=lambda k, m: ev.append(m))
    b = N.NewsBrain(e)
    asyncio.run(b.morning())
    assert b.premarket["stocks"] == 2 and "FEDERALBNK" in b.premarket["positive"] and ev
