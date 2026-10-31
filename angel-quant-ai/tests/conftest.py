import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("DATA_DIR", str(Path(__file__).resolve().parent / ".data"))

import pytest

from app.broker.instruments import InstrumentMaster
from app.config import Settings


@pytest.fixture
def settings():
    return Settings(_env_file=None, angel_api_key="k", angel_client_code="C123", angel_mpin="1234",
                    angel_totp_secret="JBSWY3DPEHPK3PXP", paper_capital=100000)


def rows():
    r = [
        {"token": "2885", "symbol": "RELIANCE-EQ", "name": "RELIANCE", "expiry": "", "strike": "-1.000000", "lotsize": "1",
         "instrumenttype": "", "exch_seg": "NSE", "tick_size": "10.000000"},
        {"token": "99926000", "symbol": "Nifty 50", "name": "Nifty 50", "expiry": "", "strike": "0", "lotsize": "1",
         "instrumenttype": "AMXIDX", "exch_seg": "NSE", "tick_size": "0"},
    ]
    tok = 50000
    for strike in range(24500, 25600, 100):
        for right in ("CE", "PE"):
            tok += 1
            r.append({"token": str(tok), "symbol": f"NIFTY30DEC99{strike}{right}", "name": "NIFTY", "expiry": "30DEC2099",
                      "strike": f"{strike * 100}.000000", "lotsize": "75", "instrumenttype": "OPTIDX", "exch_seg": "NFO",
                      "tick_size": "5.000000"})
    return r


@pytest.fixture
def im(tmp_path):
    m = InstrumentMaster("http://x", str(tmp_path))
    m.index(rows())
    return m
