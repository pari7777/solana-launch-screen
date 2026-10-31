"""Reports as CSV or Excel: trades (trade-by-trade with gross → charges → net), strategy summary, charges summary."""
from __future__ import annotations

import io

import pandas as pd

COLS = ["id", "mode", "strategy", "underlying", "symbol", "side", "product", "qty", "entry_price", "exit_price", "gross",
        "charges_est", "charges_actual", "charges_broker", "slippage_est", "net", "reason", "exit_reason", "opened_at", "closed_at"]


def _frame(rows: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    if df.empty:
        return pd.DataFrame(columns=COLS)
    # in-memory rows use short keys
    df = df.rename(columns={"entry": "entry_price", "exit": "exit_price", "charges": "charges_actual"})
    for c in COLS:
        if c not in df:
            df[c] = None
    for c in ("opened_at", "closed_at"):
        if pd.api.types.is_numeric_dtype(df[c]):
            df[c] = pd.to_datetime(df[c], unit="s", utc=True)
        df[c] = pd.to_datetime(df[c], utc=True).dt.tz_convert("Asia/Kolkata").dt.tz_localize(None)
    return df[COLS]


def strategy_summary(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame(columns=["strategy", "trades", "win_rate_pct", "gross", "charges", "net", "profit_factor", "avg_net"])
    g = df.groupby("strategy")
    out = pd.DataFrame({
        "trades": g.size(), "win_rate_pct": g["net"].apply(lambda x: round((x > 0).mean() * 100, 1)),
        "gross": g["gross"].sum().round(2), "charges": g["charges_actual"].sum().round(2), "net": g["net"].sum().round(2),
        "profit_factor": g["net"].apply(lambda x: round(x[x > 0].sum() / -x[x < 0].sum(), 2) if (x < 0).any() else None),
        "avg_net": g["net"].mean().round(2)}).reset_index()
    return out


def build_report(kind: str, rows: list[dict], fmt: str) -> tuple[bytes, str, str]:
    df = _frame(rows)
    sheets = {"trades": df}
    if kind in ("strategy", "full", "monthly", "weekly"):
        sheets["by_strategy"] = strategy_summary(df)
    if kind in ("charges", "full", "monthly"):
        sheets["charges"] = pd.DataFrame([{"gross": df["gross"].sum(), "charges_model": df["charges_actual"].sum(),
                                           "charges_angel_estimate": df["charges_broker"].sum(min_count=1),
                                           "net": df["net"].sum(), "charges_pct_of_gross_profit":
                                           round(df["charges_actual"].sum() / df.loc[df["gross"] > 0, "gross"].sum() * 100, 1)
                                           if (df["gross"] > 0).any() else None}])
    if fmt == "xlsx":
        buf = io.BytesIO()
        with pd.ExcelWriter(buf, engine="openpyxl") as w:
            for name, d in sheets.items():
                d.to_excel(w, sheet_name=name, index=False)
        return buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", f"angel-quant-{kind}.xlsx"
    main = sheets.get("by_strategy") if kind == "strategy" else sheets.get("charges") if kind == "charges" else df
    return main.to_csv(index=False).encode(), "text/csv", f"angel-quant-{kind}.csv"
