from app.market import yahoo


def test_parse_and_ticker():
    j = {"chart": {"result": [{"timestamp": [1763005500, 1763005560, 1763005620],
                                "indicators": {"quote": [{"open": [10, None, 12], "high": [11, 1, 13], "low": [9, 1, 11],
                                                          "close": [10.5, 1, 12.5], "volume": [100, 1, None]}]}}]}}
    rows = yahoo.parse(j)
    assert len(rows) == 2 and rows[0][1:] == [10, 11, 9, 10.5, 100] and rows[1][5] == 0
    assert "+05:30" in rows[0][0]
    assert yahoo.ticker("M&M") == "M&M.NS" and yahoo.ticker("NIFTY", index=True) == "^NSEI"
    assert yahoo.parse({}) == [] and yahoo.parse({"chart": {"result": None}}) == []


def test_seed_accepts_yahoo_rows():
    from app.market.feed import MarketData
    md = MarketData()
    rows = yahoo.parse({"chart": {"result": [{"timestamp": [1763005500], "indicators": {"quote": [{"open": [1], "high": [2], "low": [0.5], "close": [1.5], "volume": [7]}]}}]}})
    md.seed("k", rows)
    assert len(md.series["k"].candles) == 1 and md.series["k"].candles[0].c == 1.5
