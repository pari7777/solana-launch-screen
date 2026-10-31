"""The trading engine: wires market data → regime → strategies → cost check → risk → Claude review → orders,
and runs the position manager, health checks, daily re-login and instrument refresh."""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta

from app.ai.claude import ClaudeReviewer
from app.broker.instruments import InstrumentMaster
from app.broker.ratelimit import RateLimiter
from app.broker.rest import AngelError, AngelRest
from app.broker.ws import EXCHANGE_TYPE, SNAP, MarketStream, Tick
from app.clock import IST, market_open, minutes_since_open, now_ist
from app.config import Settings
from app.costs.charges import ChargeModel, estimate_payload, parse_estimate
from app.execution.live import LiveBroker
from app.execution.oms import OMS
from app.execution.paper import PaperBroker
from app.market.feed import MarketData
from app.market.regime import Regime, allowed, detect
from app.risk.allocation import FAMILY, Stats, budgets
from app.risk.manager import RiskManager
from app.storage.cache import Cache
from app.storage.db import Store
from app.strategies.base import evaluate
from app.strategies.options import DebitSpread, IronCondor, OptionMomentum
from app.strategies.stock_intraday import OpeningRangeBreakout, VwapReversion, VwapTrendPullback

log = logging.getLogger("engine")
DIRECTION = {"BUY": "LONG", "SELL": "SHORT"}


class Engine:
    def __init__(self, s: Settings):
        self.s = s
        self.mode = "live" if not s.live_blockers() else "paper"
        self.limiter = RateLimiter(s.order_rate_per_sec, s.quote_rate_per_sec, s.candle_rate_per_sec, s.other_rate_per_sec)
        self.rest = AngelRest(s, self.limiter)
        self.im = InstrumentMaster(s.scrip_master_url, s.data_dir)
        self.md = MarketData()
        self.charges = ChargeModel()
        self.store = Store(s.database_url)
        self.cache = Cache(s.redis_url)
        self.stats = Stats()
        self.claude = ClaudeReviewer(s)
        self.capital = s.paper_capital
        self.realized_total = 0.0
        self.risk = RiskManager(s, self.capital)
        self.regime = Regime()
        self.stream = MarketStream(s.angel_ws_url, self._ws_headers, self._on_tick, self._on_stream_state)
        if self.mode == "live":
            self.broker = LiveBroker(s, self.rest)
        else:
            self.broker = PaperBroker(self.md, self.key_for, self.charges)
        self.oms = OMS(s, self.broker, self.md, self.im, self.key_for, on_closed=self._on_closed, on_event=self._on_event)
        self.strategies = []
        if s.enable_stock_intraday:
            self.strategies += [OpeningRangeBreakout(self), VwapTrendPullback(self), VwapReversion(self)]
        if s.enable_options_scalping:
            self.strategies.append(OptionMomentum(self))
        if s.enable_options_directional:
            self.strategies += [DebitSpread(self), IronCondor(self)]
        self.running = True
        self.status = "starting"
        self.events: list[dict] = []
        self.greeks: dict[tuple[str, float, str], float] = {}
        self.greeks_at: dict[str, float] = {}
        self.last_bar_minute = None
        self.margin_available: float | None = None
        self.signal_latency_ms: list[float] = []
        self.claude_by_pos: dict[int, dict] = {}
        self.last_login_day = None
        self.subscribed: set[str] = set()
        self.acceptance_failed = ""

    # ── small helpers used by strategies ──
    def key_for(self, ins) -> str:
        return MarketData.key(EXCHANGE_TYPE.get(ins.exchange, 1), ins.token)

    def index_key(self, u: str) -> str:
        tok = self.im.index_token(u)
        return MarketData.key(1, tok) if tok else ""

    def today(self):
        return now_ist().date()

    def now(self):
        return now_ist()

    def minutes_since_open(self):
        return minutes_since_open()

    def equity(self) -> float:
        return self.capital + self.realized_total + sum(p.unrealized() for p in self.oms.positions.values())

    def event(self, kind: str, msg: str, **data):
        self.events.insert(0, {"t": now_ist().strftime("%H:%M:%S"), "kind": kind, "msg": msg})
        del self.events[200:]
        self.store.audit(kind, msg, data)

    # ── option selection ──
    def _delta(self, ins) -> float | None:
        return self.greeks.get((ins.name, ins.strike, ins.right or ""))

    def _strikes(self, u, ex, right):
        chain = [i for i in self.im.chain(u, ex) if i.right == right]
        return sorted(chain, key=lambda i: i.strike)

    def pick_option(self, u, ex, spot, right, itm_steps=0):
        """Liquid ATM ± n option. itm_steps > 0 = in the money, < 0 = out of the money. Returns (ins, tick, delta)."""
        if not ex:
            return None
        ch = self._strikes(u, ex, right)
        if not ch:
            return None
        atm = min(range(len(ch)), key=lambda i: abs(ch[i].strike - spot))
        step = -itm_steps if right == "CE" else itm_steps          # CE: ITM = lower strikes; PE: ITM = higher
        idx = atm + step
        if not 0 <= idx < len(ch):
            return None
        ins = ch[idx]
        t = self.md.ticks.get(self.key_for(ins))
        if not self._liquid(ins, t):
            return None
        d = self._delta(ins)
        if d is None:
            d = 0.5 if itm_steps == 0 else 0.6 if itm_steps > 0 else 0.3
        return ins, t, abs(d)

    def pick_strike(self, u, ex, level, right, offset=0):
        ch = self._strikes(u, ex, right)
        if not ch:
            return None
        i = min(range(len(ch)), key=lambda j: abs(ch[j].strike - level)) + offset
        if not 0 <= i < len(ch):
            return None
        t = self.md.ticks.get(self.key_for(ch[i]))
        return (ch[i], t) if self._liquid(ch[i], t) else None

    def _liquid(self, ins, t: Tick | None) -> bool:
        if not t or not t.bid or not t.ask or self.md.age(self.key_for(ins)) > 3:
            return False
        sp = t.spread_pct
        if sp is None or sp > 1.5:
            return False
        return (t.bids[0][1] if t.bids else 0) >= 2 * ins.lot and (t.asks[0][1] if t.asks else 0) >= 2 * ins.lot

    # ── market data ──
    def _ws_headers(self) -> dict[str, str]:
        return {"Authorization": self.rest.session.jwt, "x-api-key": self.s.angel_api_key.get_secret_value(),
                "x-client-code": self.s.angel_client_code, "x-feed-token": self.rest.session.feed}

    def _on_tick(self, t: Tick):
        self.md.on_tick(t)
        self.broker.on_tick(MarketData.key(t.exchange_type, t.token))

    async def _on_stream_state(self, st: str):
        self.event("stream", f"market stream {st}")

    def _subscribe(self, exchange: str, tokens: list[str]):
        new = [t for t in tokens if f"{exchange}:{t}" not in self.subscribed]
        room = self.s.max_ws_tokens - len(self.subscribed)
        new = new[:max(0, room)]
        if new:
            self.subscribed.update(f"{exchange}:{t}" for t in new)
            self.stream.subscribe(SNAP, exchange, new)

    async def _seed_history(self):
        """Today's and yesterday's 1-minute candles for indices and stocks (REST, rate-limited)."""
        n = now_ist()
        frm = (n - timedelta(days=4)).strftime("%Y-%m-%d 09:15")
        to = n.strftime("%Y-%m-%d %H:%M")
        targets = [("NSE", self.im.index_token(u)) for u in self.s.underlyings]
        targets += [("NSE", self.im.equity[x].token) for x in self.s.stocks if x in self.im.equity]
        for ex, tok in targets:
            if not tok:
                continue
            try:
                rows = await self.rest.candles(ex, tok, "ONE_MINUTE", frm, to)
                self.md.seed(MarketData.key(1, tok), rows)
            except AngelError as e:
                log.warning("history %s: %s", tok, e)

    async def _refresh_chains(self):
        for u in self.s.underlyings:
            spot = self.md.ltp(self.index_key(u))
            ex_list = self.im.expiries(u)
            if not spot or not ex_list:
                continue
            for ex in ex_list[:2]:
                toks = [i.token for i in self.im.nearest_strikes(u, ex, spot, 6)]
                self._subscribe("NFO", toks)

    async def _refresh_greeks(self):
        for u in self.s.underlyings:
            ex = self.im.expiries(u)
            if not ex or time.time() - self.greeks_at.get(u, 0) < 120:
                continue
            self.greeks_at[u] = time.time()
            try:
                rows = await self.rest.option_greeks(u, ex[0].strftime("%d%b%Y").upper())
                for r in rows:
                    self.greeks[(u, float(r.get("strikePrice", 0)), str(r.get("optionType", "")))] = float(r.get("delta", 0))
            except AngelError as e:
                log.info("greeks %s unavailable: %s", u, e)

    # ── lifecycle ──
    async def start(self):
        await self.store.open()
        await self.cache.open()
        asyncio.create_task(self.store.writer())
        saved = await self.store.kv_get(f"{self.mode}:risk_flags", {}) or {}
        self.realized_total = float(await self.store.kv_get(f"{self.mode}:realized_total", 0.0) or 0.0)
        if self.mode == "live":
            why = await self._acceptance()
            if why:
                self.acceptance_failed = why
                self.mode = "paper"
                self.broker = PaperBroker(self.md, self.key_for, self.charges)
                self.oms = OMS(self.s, self.broker, self.md, self.im, self.key_for, on_closed=self._on_closed, on_event=self._on_event)
                self.realized_total = float(await self.store.kv_get("paper:realized_total", 0.0) or 0.0)
                self.event("acceptance", f"live trading NOT enabled: {why} — running in paper mode")
        self.stats.load(await self.store.strategy_outcomes(self.mode))
        self.risk = RiskManager(self.s, self.equity())
        # a drawdown kill switch survives restarts; daily/weekly ones reset with the calendar
        if str(saved.get("kill_switch", "")).startswith("max drawdown"):
            self.risk.st.kill_switch = saved["kill_switch"]
        self.risk.st.peak_equity = max(self.risk.st.peak_equity, float(saved.get("peak_equity") or 0))
        self.risk.st.disabled_strategies = set(saved.get("disabled") or [])
        asyncio.create_task(self._persist_loop())
        self.event("start", f"engine starting in {self.mode.upper()} mode; live blockers: {self.s.live_blockers() or 'none'}")
        if not self.s.has_angel_credentials:
            self.status = "waiting for Angel One credentials (set ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_MPIN, ANGEL_TOTP_SECRET)"
            self.event("config", self.status)
            return
        await self._connect()
        asyncio.create_task(self.stream.run())
        asyncio.create_task(self._loop())
        asyncio.create_task(self._manage_loop())
        if isinstance(self.broker, LiveBroker):
            asyncio.create_task(self.broker.run_sync())
            asyncio.create_task(self._reconcile_loop())

    async def _acceptance(self) -> str:
        """Paper track record gate for live trading (all strategies combined, last 90 days)."""
        outs = await self.store.strategy_outcomes("paper", 90)
        nets = [x for xs in outs.values() for x in xs]
        s = self.s
        if len(nets) < s.acceptance_min_paper_trades:
            return f"only {len(nets)} paper trades (need {s.acceptance_min_paper_trades})"
        wins, losses = sum(x for x in nets if x > 0), -sum(x for x in nets if x < 0)
        pf = wins / losses if losses else float("inf")
        if sum(nets) <= s.acceptance_min_net:
            return f"paper net P&L ₹{sum(nets):,.0f} is not positive"
        if pf < s.acceptance_min_profit_factor:
            return f"paper profit factor {pf:.2f} < {s.acceptance_min_profit_factor}"
        return ""

    async def _connect(self):
        try:
            await self.rest.login()
            self.last_login_day = now_ist().date()
            n = await self.im.load()
            self.event("instruments", f"instrument master: {n:,} contracts ({self.im.source})")
        except Exception as e:
            self.status = f"login/instrument error: {e}"
            self.event("error", self.status)
            return
        idx = [self.im.index_token(u) for u in self.s.underlyings] + [self.im.index_token("INDIAVIX")]
        self._subscribe("NSE", [t for t in idx if t])
        self._subscribe("NSE", [self.im.equity[x].token for x in self.s.stocks if x in self.im.equity])
        await self._seed_history()
        await self._refresh_margin()
        self.status = "connected"
        self.event("login", f"logged in as {self.rest.session.name or self.s.angel_client_code}")

    async def _refresh_margin(self):
        if self.mode != "live":
            self.margin_available = None
            return
        try:
            r = await self.rest.rms()
            self.margin_available = float(r.get("availablecash") or r.get("net") or 0)
        except AngelError as e:
            log.warning("RMS: %s", e)

    async def _loop(self):
        """Once per second: daily housekeeping; on every new minute: regime, strategies, new entries."""
        while True:
            try:
                n = now_ist()
                due = self.last_login_day != n.date() and (n.hour, n.minute) >= (8, 30)
                retry = not self.rest.logged_in and time.time() - getattr(self, "_last_try", 0) > 60
                if due or retry:
                    self._last_try = time.time()
                    await self._connect()                     # tokens expire at 00:00 IST; instrument master is daily
                minute = n.replace(second=0, microsecond=0)
                if market_open(n) and n.second >= 2 and minute != self.last_bar_minute:
                    self.last_bar_minute = minute
                    await self._refresh_chains()
                    await self._refresh_greeks()
                    self._update_regime()
                    if self.running:
                        await self._run_strategies()
                    asyncio.create_task(self.claude.market_note(self._context()))
            except Exception as e:
                log.exception("loop error: %s", e)
            await asyncio.sleep(1)

    def _update_regime(self):
        k = self.index_key("NIFTY")
        s = self.md.series.get(k)
        if not s:
            return
        arr = s.session() if minutes_since_open() > 60 else s.arrays()
        t = self.md.ticks.get(k)
        vix_t = self.md.ticks.get(self.index_key("INDIAVIX"))
        adv = dec = 0
        for x in self.s.stocks:
            ins = self.im.equity.get(x)
            tk = self.md.ticks.get(self.key_for(ins)) if ins else None
            if tk and tk.close:
                adv += tk.ltp > tk.close
                dec += tk.ltp < tk.close
        sess = s.session()
        orng = (float(sess[2][:15].max()), float(sess[3][:15].min())) if len(sess[2]) >= 15 else None
        self.regime = detect(arr, t.close if t else None, t.open if t else None, vix_t.ltp if vix_t else None,
                             vix_t.close if vix_t else None, adv, dec, orng)

    def _context(self) -> dict:
        return {"time_ist": now_ist().strftime("%H:%M"), "regime": self.regime.as_dict(), "minutes_since_open": round(minutes_since_open()),
                "open_positions": len([p for p in self.oms.positions.values() if p.is_open]),
                "today_net": round(self.risk.st.realized_today, 2)}

    async def _run_strategies(self):
        t0 = time.perf_counter()
        positions = list(self.oms.positions.values())
        budget = budgets(self.stats, self.equity())
        for strat in self.strategies:
            if not strat.enabled or strat.name in self.risk.st.disabled_strategies:
                continue
            try:
                plans = strat.on_bar()
            except Exception as e:
                log.exception("%s failed: %s", strat.name, e)
                continue
            for plan in plans:
                plan.regime = self.regime.label
                plan.meta["signal_ms"] = (time.perf_counter() - t0) * 1000
                t = self.md.ticks.get(self.key_for(plan.ins))
                spread = (t.ask - t.bid) if t and t.bid and t.ask else None
                evaluate(plan, self.charges, spread, self.s.min_net_reward_rupees, self.s.min_reward_risk)
                side = "NEUTRAL" if plan.strategy in ("opt_iron_condor", "stock_vwap_reversion") else (
                    "LONG" if (plan.side == "BUY") == (plan.ins.right != "PE") else "SHORT")
                if plan.strategy == "opt_debit_spread":
                    side = "LONG" if plan.ins.right == "CE" else "SHORT"
                why = None
                if not allowed(self.regime, plan.strategy, side):
                    why = f"regime {self.regime.label} does not allow {plan.strategy} {side.lower()}"
                if not why:
                    fam = FAMILY.get(plan.strategy, plan.strategy)
                    used = sum(p.capital for p in positions if p.is_open and FAMILY.get(p.strategy) == fam)
                    if used + plan.capital > budget.get(fam, 0):
                        why = f"{fam} budget ₹{budget.get(fam, 0):,.0f} would be exceeded"
                if not why:
                    age = self.md.age(self.key_for(plan.ins))
                    why = self.risk.check(plan, positions, self.equity(), age, self.margin_available)
                if why:
                    self.risk.reject(why)
                    self.store.signal(plan.strategy, plan.ins.symbol, "REJECTED", why, plan.summary())
                    continue
                review = await self.claude.review(plan.summary(), self._context())
                if review["verdict"] == "VETO":
                    self.store.signal(plan.strategy, plan.ins.symbol, "VETOED", review["reason"], plan.summary())
                    self.event("claude", f"Claude vetoed {plan.strategy} {plan.ins.symbol}: {review['reason']}")
                    continue
                pos = await self.oms.open(plan)
                if pos:
                    self.claude_by_pos[pos.id] = review
                    positions.append(pos)
                    self.signal_latency_ms.append((time.perf_counter() - t0) * 1000)
                    del self.signal_latency_ms[:-200]
                    self.store.signal(plan.strategy, plan.ins.symbol, "TRADED", plan.reason, plan.summary())
                    self.event("entry", f"{self.mode.upper()} {plan.side} {plan.qty} {plan.ins.symbol} @ {plan.entry} "
                                        f"(stop {plan.stop}, target {plan.target}, net ₹{plan.net_target:.0f} vs costs ₹{plan.charges_target:.0f})")

    async def _manage_loop(self):
        while True:
            try:
                await self.oms.reprice()
                await self.oms.manage()
                eq = self.equity()
                self.risk.roll(eq)
                unreal = sum(p.unrealized() for p in self.oms.positions.values())
                self.risk.update_limits(eq, unreal)
                self._health()
                if self.risk.st.kill_switch.startswith(("daily loss", "weekly", "max drawdown")):
                    if any(p.status == "OPEN" for p in self.oms.positions.values()):
                        await self.oms.square_off_all(f"kill switch: {self.risk.st.kill_switch}")
                for o in list(self.oms.orders.values()):
                    if getattr(o, "_saved_status", None) != (o.status, o.filled, o.reprices):
                        o._saved_status = (o.status, o.filled, o.reprices)
                        self.store.save_order(o, self.mode)
            except Exception as e:
                log.exception("manage error: %s", e)
            await asyncio.sleep(0.5)

    def _health(self):
        reasons = []
        if market_open() and minutes_since_open() > 2:
            age = time.time() - self.md.last_tick_at if self.md.last_tick_at else 1e9
            if age > self.s.stale_data_seconds * 3:
                reasons.append(f"no market data for {age:.0f}s")
            if self.stream.state != "connected":
                reasons.append(f"market stream {self.stream.state}")
        if isinstance(self.broker, LiveBroker) and self.broker.sync_errors >= 3:
            reasons.append("cannot read broker order book")
        if getattr(self, "_recon_issue", ""):
            reasons.append(self._recon_issue)
        self.risk.health_reasons = reasons

    async def _persist_loop(self):
        while True:
            st = self.risk.st
            self.store.kv_put(f"{self.mode}:risk_flags", {"kill_switch": st.kill_switch, "peak_equity": st.peak_equity,
                                                         "disabled": sorted(st.disabled_strategies)})
            await self.cache.put("risk", self.risk.snapshot(self.equity()))
            await self.cache.put("positions", [{"id": p.id, "symbol": p.legs[0].ins.symbol, "status": p.status, "qty": p.qty,
                                                "entry": p.entry_price, "stop": p.stop} for p in self.oms.positions.values() if p.is_open])
            await asyncio.sleep(5)

    async def _reconcile_loop(self):
        """Live: compare our net quantities with the broker's every 30 s. Any mismatch → no new entries."""
        while True:
            await asyncio.sleep(30)
            try:
                theirs = await self.broker.broker_positions()
                ours: dict[str, int] = {}
                for p in self.oms.positions.values():
                    for l in p.legs:
                        q = (l.qty - l.exit_qty) * (1 if l.side == "BUY" else -1)
                        if q:
                            ours[l.ins.token] = ours.get(l.ins.token, 0) + q
                bad = {k for k in set(ours) | {k for k, v in theirs.items() if v} if ours.get(k, 0) != theirs.get(k, 0)}
                self._recon_issue = f"position mismatch with broker on {len(bad)} instrument(s)" if bad else ""
                if bad:
                    self.event("reconcile", self._recon_issue, tokens=sorted(bad))
            except Exception as e:
                self._recon_issue = f"reconciliation failed: {e}"

    # ── callbacks ──
    def _on_event(self, kind: str, p, extra: str = ""):
        if kind in ("opened", "closed", "partial", "rejected", "cancelled"):
            msg = {"opened": f"opened #{p.id} {p.legs[0].ins.symbol} qty {p.qty} @ {p.entry_price:.2f}",
                   "partial": f"partial exit #{p.id}: {extra}", "rejected": f"order rejected #{p.id}: {extra}",
                   "cancelled": f"entry not filled, cancelled #{p.id} {p.legs[0].ins.symbol}",
                   "closed": f"closed #{p.id} {p.legs[0].ins.symbol}: gross ₹{p.gross:.2f}, charges ₹{p.charges_actual:.2f}, "
                             f"net ₹{p.net:.2f} — {p.exit_reason}"}[kind]
            self.event(kind, msg)
            self.store.save_position(p, self.mode, self.claude_by_pos.get(p.id))

    def _on_closed(self, p):
        self.realized_total += p.net
        self.store.kv_put(f"{self.mode}:realized_total", self.realized_total)
        self.stats.add(p.strategy, p.net)
        self.risk.on_closed_trade(p.net, p.charges_actual, self.equity())
        asyncio.get_running_loop().create_task(self._broker_charges(p))

    async def _broker_charges(self, p):
        """Ask Angel One's official estimator for the same orders and store it next to our own figure."""
        if not self.rest.logged_in:
            return
        orders = []
        for l in p.legs:
            if l.qty:
                orders.append(estimate_payload(l.ins, l.side, l.qty, l.entry_price, p.product))
            if l.exit_qty:
                orders.append(estimate_payload(l.ins, "SELL" if l.side == "BUY" else "BUY", l.exit_qty, l.exit_price, p.product))
        try:
            v = parse_estimate(await self.rest.estimate_charges(orders))
            if v is not None:
                self.store.save_position(p, self.mode, None, broker_charges=v)
                if p.charges_actual and abs(v - p.charges_actual) / max(1.0, v) > 0.1:
                    self.event("charges", f"#{p.id}: Angel One estimate ₹{v:.2f} vs model ₹{p.charges_actual:.2f} — check config/charges.json")
        except AngelError as e:
            log.info("estimateCharges unavailable: %s", e)

    # ── controls (dashboard buttons) ──
    def control(self, action: str, arg: str = "") -> str:
        st = self.risk.st
        if action == "start":
            self.running, st.paused = True, False
            return "bot started"
        if action == "pause":
            st.paused = True
            return "new entries paused (open positions still managed)"
        if action == "resume":
            st.paused, self.running = False, True
            if st.kill_switch and not st.kill_switch.startswith("max drawdown"):
                st.kill_switch = ""
            return "resumed"
        if action == "disable_all":
            st.disabled_strategies = {x.name for x in self.strategies}
            return "all strategies disabled"
        if action == "enable_all":
            st.disabled_strategies = set()
            return "all strategies enabled"
        if action == "reset_drawdown":
            st.kill_switch, st.peak_equity = "", self.equity()
            return "drawdown kill switch reset"
        return "unknown action"

    async def exit_position(self, pid: int) -> str:
        p = self.oms.positions.get(pid)
        if not p or not p.is_open:
            return "no such open position"
        await self.oms.exit(p, "manual exit from dashboard")
        return f"exiting #{pid}"

    async def emergency(self) -> str:
        self.risk.st.paused = True
        self.risk.st.kill_switch = "daily: emergency square-off by owner"
        await self.oms.square_off_all("EMERGENCY SQUARE-OFF")
        self.event("emergency", "emergency square-off requested")
        return "emergency square-off sent; new entries blocked"
