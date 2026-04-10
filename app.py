from __future__ import annotations

import datetime as dt
import json
import os
import re
import sqlite3
import sys
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any

import requests
from flask import Flask, jsonify, render_template, request

APP_DIR = Path(__file__).resolve().parent
IS_FROZEN = bool(getattr(sys, "frozen", False))
if IS_FROZEN:
    BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    RUNTIME_DIR = Path(sys.executable).resolve().parent
else:
    BUNDLE_DIR = APP_DIR
    RUNTIME_DIR = APP_DIR

DB_PATH = RUNTIME_DIR / "fund_strategy.db"
QUOTE_API_TEMPLATE = "https://fundgz.1234567.com.cn/js/{code}.js"
CACHE_TTL_SECONDS = 45

QUOTE_CACHE: dict[str, dict[str, Any]] = {}
QUOTE_CACHE_LOCK = threading.Lock()

app = Flask(
    __name__,
    template_folder=str(BUNDLE_DIR / "templates"),
    static_folder=str(BUNDLE_DIR / "static"),
)


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def init_db() -> None:
    with get_db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS funds (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                mode TEXT NOT NULL CHECK(mode IN ('watch', 'holding')),
                last_trade_price REAL NOT NULL,
                holding_shares REAL NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fund_id INTEGER NOT NULL,
                trade_date TEXT NOT NULL,
                side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
                shares REAL NOT NULL,
                price REAL NOT NULL,
                note TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (fund_id) REFERENCES funds(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_trades_fund_id_date
                ON trades(fund_id, trade_date DESC, id DESC);
            """
        )


def now_iso() -> str:
    return dt.datetime.now().isoformat(timespec="seconds")


def to_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_quote_jsonp(raw_text: str) -> dict[str, Any] | None:
    match = re.search(r"jsonpgz\((.+?)\);?$", raw_text.strip(), flags=re.S)
    if not match:
        return None
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError:
        return None


def fetch_quote(code: str, force_refresh: bool = False) -> dict[str, Any] | None:
    now = time.time()
    if not force_refresh:
        with QUOTE_CACHE_LOCK:
            cached = QUOTE_CACHE.get(code)
            if cached and (now - cached["ts"] <= CACHE_TTL_SECONDS):
                return cached["quote"]

    quote: dict[str, Any] | None = None
    try:
        response = requests.get(
            QUOTE_API_TEMPLATE.format(code=code),
            timeout=6,
            headers={
                "User-Agent": "Mozilla/5.0",
                "Referer": "https://fund.eastmoney.com/",
            },
        )
        response.raise_for_status()
        parsed = parse_quote_jsonp(response.text)
        if parsed:
            current_price = to_float(parsed.get("gsz"))
            latest_nav = to_float(parsed.get("dwjz"))
            quote = {
                "fund_code": parsed.get("fundcode", code),
                "name": parsed.get("name") or "",
                "current_price": current_price if current_price is not None else latest_nav,
                "latest_nav": latest_nav,
                "daily_change_pct": to_float(parsed.get("gszzl")),
                "quote_time": parsed.get("gztime") or parsed.get("jzrq"),
            }
    except requests.RequestException:
        quote = None

    with QUOTE_CACHE_LOCK:
        QUOTE_CACHE[code] = {"ts": now, "quote": quote}
    return quote


def get_payload() -> dict[str, Any]:
    if request.is_json:
        payload = request.get_json(silent=True)
        return payload if isinstance(payload, dict) else {}
    return request.form.to_dict()


def validate_fund_code(code: str) -> bool:
    return bool(re.fullmatch(r"\d{6}", code))


def normalize_mode(mode: str | None) -> str:
    if mode == "holding":
        return "holding"
    return "watch"


def compute_signal(current_price: float | None, base_price: float | None) -> tuple[str, float | None, float | None]:
    if current_price is None or base_price is None or base_price <= 0:
        return "no-data", None, None
    buy_line = base_price * 0.95
    sell_line = base_price * 1.05
    if current_price <= buy_line:
        return "buy", buy_line, sell_line
    if current_price >= sell_line:
        return "sell", buy_line, sell_line
    return "hold", buy_line, sell_line


def load_trade_summaries(conn: sqlite3.Connection) -> dict[int, dict[str, float]]:
    rows = conn.execute(
        """
        SELECT
            fund_id,
            SUM(CASE WHEN side = 'buy' THEN shares * price ELSE 0 END) AS buy_total,
            SUM(CASE WHEN side = 'sell' THEN shares * price ELSE 0 END) AS sell_total
        FROM trades
        GROUP BY fund_id
        """
    ).fetchall()
    summary: dict[int, dict[str, float]] = {}
    for row in rows:
        summary[row["fund_id"]] = {
            "buy_total": float(row["buy_total"] or 0),
            "sell_total": float(row["sell_total"] or 0),
        }
    return summary


@app.route("/")
def index() -> str:
    return render_template("index.html")


@app.get("/api/funds")
def list_funds():
    force_refresh = request.args.get("force") == "1"
    with get_db() as conn:
        funds = conn.execute("SELECT * FROM funds ORDER BY id DESC").fetchall()
        trade_summaries = load_trade_summaries(conn)

    data: list[dict[str, Any]] = []
    summary_market_value = 0.0
    summary_pnl = 0.0
    alert_count = 0

    for fund in funds:
        fund_id = int(fund["id"])
        code = fund["code"]
        quote = fetch_quote(code, force_refresh=force_refresh)

        current_price = quote["current_price"] if quote else None
        latest_nav = quote["latest_nav"] if quote else None
        daily_change_pct = quote["daily_change_pct"] if quote else None
        quote_time = quote["quote_time"] if quote else None
        display_name = (quote["name"] if quote and quote.get("name") else fund["name"]) or code

        base_price = to_float(fund["last_trade_price"])
        shares = float(fund["holding_shares"] or 0)
        signal, buy_line, sell_line = compute_signal(current_price, base_price)

        trade_info = trade_summaries.get(fund_id, {"buy_total": 0.0, "sell_total": 0.0})
        valuation_price = current_price if current_price is not None else base_price
        market_value = shares * valuation_price if valuation_price else 0.0
        cumulative_pnl = market_value + trade_info["sell_total"] - trade_info["buy_total"]

        if signal in {"buy", "sell"}:
            alert_count += 1

        summary_market_value += market_value
        summary_pnl += cumulative_pnl

        data.append(
            {
                "id": fund_id,
                "code": code,
                "name": display_name,
                "mode": fund["mode"],
                "last_trade_price": base_price,
                "holding_shares": shares,
                "current_price": current_price,
                "latest_nav": latest_nav,
                "daily_change_pct": daily_change_pct,
                "quote_time": quote_time,
                "buy_line": buy_line,
                "sell_line": sell_line,
                "signal": signal,
                "market_value": market_value,
                "buy_total": trade_info["buy_total"],
                "sell_total": trade_info["sell_total"],
                "cumulative_pnl": cumulative_pnl,
                "updated_at": fund["updated_at"],
                "quote_available": quote is not None,
            }
        )

    return jsonify(
        {
            "funds": data,
            "summary": {
                "count": len(data),
                "alerts": alert_count,
                "total_market_value": summary_market_value,
                "total_cumulative_pnl": summary_pnl,
            },
            "generated_at": now_iso(),
        }
    )


@app.post("/api/funds")
def create_fund():
    payload = get_payload()
    code = str(payload.get("code", "")).strip()
    if not validate_fund_code(code):
        return jsonify({"error": "基金代码必须是 6 位数字。"}), 400

    mode = normalize_mode(str(payload.get("mode", "watch")).strip())
    shares = to_float(payload.get("holding_shares"))
    shares = 0.0 if shares is None else shares
    if shares < 0:
        return jsonify({"error": "持仓份额不能小于 0。"}), 400

    quote = fetch_quote(code, force_refresh=True)
    name = str(payload.get("name", "")).strip() or (quote.get("name") if quote else "") or code

    last_trade_price = to_float(payload.get("last_trade_price"))
    if last_trade_price is None or last_trade_price <= 0:
        if quote and quote.get("current_price"):
            last_trade_price = float(quote["current_price"])
        else:
            return jsonify({"error": "请填写最近一次成交价，或稍后重试行情拉取。"}), 400

    if shares > 0 and mode == "watch":
        mode = "holding"

    created_at = now_iso()
    try:
        with get_db() as conn:
            cursor = conn.execute(
                """
                INSERT INTO funds(code, name, mode, last_trade_price, holding_shares, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (code, name, mode, last_trade_price, shares, created_at, created_at),
            )
            fund_id = int(cursor.lastrowid)
            if shares > 0:
                conn.execute(
                    """
                    INSERT INTO trades(fund_id, trade_date, side, shares, price, note, created_at)
                    VALUES (?, ?, 'buy', ?, ?, ?, ?)
                    """,
                    (fund_id, dt.date.today().isoformat(), shares, last_trade_price, "初始化持仓", created_at),
                )
    except sqlite3.IntegrityError:
        return jsonify({"error": "该基金代码已存在。"}), 409

    return jsonify({"ok": True, "message": "基金已添加。"})


@app.patch("/api/funds/<int:fund_id>")
def update_fund(fund_id: int):
    payload = get_payload()
    updates: list[str] = []
    params: list[Any] = []

    if "name" in payload:
        name = str(payload.get("name", "")).strip()
        if not name:
            return jsonify({"error": "基金名称不能为空。"}), 400
        updates.append("name = ?")
        params.append(name)

    if "mode" in payload:
        mode = normalize_mode(str(payload.get("mode", "")).strip())
        updates.append("mode = ?")
        params.append(mode)

    if "holding_shares" in payload:
        shares = to_float(payload.get("holding_shares"))
        if shares is None or shares < 0:
            return jsonify({"error": "持仓份额必须是大于等于 0 的数字。"}), 400
        updates.append("holding_shares = ?")
        params.append(shares)

    if "last_trade_price" in payload:
        last_trade_price = to_float(payload.get("last_trade_price"))
        if last_trade_price is None or last_trade_price <= 0:
            return jsonify({"error": "最近成交价必须大于 0。"}), 400
        updates.append("last_trade_price = ?")
        params.append(last_trade_price)

    if not updates:
        return jsonify({"error": "没有可更新的字段。"}), 400

    updates.append("updated_at = ?")
    params.append(now_iso())
    params.append(fund_id)

    with get_db() as conn:
        cursor = conn.execute(f"UPDATE funds SET {', '.join(updates)} WHERE id = ?", params)
        if cursor.rowcount == 0:
            return jsonify({"error": "基金不存在。"}), 404

    return jsonify({"ok": True, "message": "基金信息已更新。"})


@app.delete("/api/funds/<int:fund_id>")
def delete_fund(fund_id: int):
    with get_db() as conn:
        cursor = conn.execute("DELETE FROM funds WHERE id = ?", (fund_id,))
        if cursor.rowcount == 0:
            return jsonify({"error": "基金不存在。"}), 404
    return jsonify({"ok": True, "message": "基金已删除。"})


@app.get("/api/funds/<int:fund_id>/trades")
def list_trades(fund_id: int):
    with get_db() as conn:
        fund = conn.execute("SELECT id FROM funds WHERE id = ?", (fund_id,)).fetchone()
        if not fund:
            return jsonify({"error": "基金不存在。"}), 404

        rows = conn.execute(
            """
            SELECT id, trade_date, side, shares, price, note, created_at
            FROM trades
            WHERE fund_id = ?
            ORDER BY trade_date DESC, id DESC
            LIMIT 300
            """,
            (fund_id,),
        ).fetchall()

    return jsonify(
        {
            "trades": [
                {
                    "id": int(row["id"]),
                    "trade_date": row["trade_date"],
                    "side": row["side"],
                    "shares": float(row["shares"]),
                    "price": float(row["price"]),
                    "amount": float(row["shares"]) * float(row["price"]),
                    "note": row["note"] or "",
                    "created_at": row["created_at"],
                }
                for row in rows
            ]
        }
    )


@app.post("/api/funds/<int:fund_id>/trades")
def create_trade(fund_id: int):
    payload = get_payload()

    trade_date = str(payload.get("trade_date", dt.date.today().isoformat())).strip()
    try:
        dt.date.fromisoformat(trade_date)
    except ValueError:
        return jsonify({"error": "交易日期格式必须为 YYYY-MM-DD。"}), 400

    side = str(payload.get("side", "buy")).strip().lower()
    if side not in {"buy", "sell"}:
        return jsonify({"error": "交易方向必须是 buy 或 sell。"}), 400

    shares = to_float(payload.get("shares"))
    price = to_float(payload.get("price"))
    if shares is None or shares <= 0:
        return jsonify({"error": "成交份额必须大于 0。"}), 400
    if price is None or price <= 0:
        return jsonify({"error": "成交单价必须大于 0。"}), 400

    note = str(payload.get("note", "")).strip()
    created_at = now_iso()

    with get_db() as conn:
        fund = conn.execute("SELECT * FROM funds WHERE id = ?", (fund_id,)).fetchone()
        if not fund:
            return jsonify({"error": "基金不存在。"}), 404

        current_shares = float(fund["holding_shares"] or 0)
        if side == "sell" and shares > current_shares:
            return jsonify({"error": "卖出份额不能大于当前持仓份额。"}), 400

        new_shares = current_shares + shares if side == "buy" else current_shares - shares
        if abs(new_shares) < 1e-9:
            new_shares = 0.0

        conn.execute(
            """
            INSERT INTO trades(fund_id, trade_date, side, shares, price, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (fund_id, trade_date, side, shares, price, note, created_at),
        )
        conn.execute(
            """
            UPDATE funds
            SET holding_shares = ?, last_trade_price = ?, updated_at = ?
            WHERE id = ?
            """,
            (new_shares, price, created_at, fund_id),
        )

    return jsonify({"ok": True, "message": "交易已录入并更新基准价。"})


@app.get("/api/health")
def health():
    return jsonify({"ok": True, "time": now_iso()})


init_db()


def resolve_server_config() -> tuple[str, int, bool, bool]:
    host = os.getenv("FUND_HOST", "127.0.0.1").strip() or "127.0.0.1"
    port_text = os.getenv("FUND_PORT", "5000").strip()
    try:
        port = int(port_text)
    except ValueError:
        port = 5000
    if port < 1 or port > 65535:
        port = 5000

    debug = os.getenv("FUND_DEBUG", "0").strip().lower() in {"1", "true", "yes", "on"}
    if "FUND_OPEN_BROWSER" in os.environ:
        open_browser = os.getenv("FUND_OPEN_BROWSER", "0").strip().lower() in {"1", "true", "yes", "on"}
    else:
        open_browser = IS_FROZEN
    return host, port, debug, open_browser


def browser_url(host: str, port: int) -> str:
    if host in {"0.0.0.0", "::"}:
        return f"http://127.0.0.1:{port}"
    return f"http://{host}:{port}"


def run_server() -> None:
    host, port, debug, open_browser = resolve_server_config()
    if open_browser:
        threading.Timer(1.2, lambda: webbrowser.open(browser_url(host, port))).start()

    if not debug:
        try:
            from waitress import serve
        except Exception:
            serve = None
        if serve is not None:
            serve(app, host=host, port=port, threads=8)
            return

    app.run(host=host, port=port, debug=debug, use_reloader=debug)


if __name__ == "__main__":
    run_server()
