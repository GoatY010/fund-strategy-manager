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
GROUP_SEPARATOR = " | "

QUOTE_CACHE: dict[str, dict[str, Any]] = {}
QUOTE_CACHE_LOCK = threading.Lock()
HISTORY_PRICE_CACHE: dict[tuple[str, str], dict[str, Any]] = {}
HISTORY_PRICE_CACHE_LOCK = threading.Lock()

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
            CREATE TABLE IF NOT EXISTS fund_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                sort_order INTEGER DEFAULT 0
            );
            
            CREATE TABLE IF NOT EXISTS funds (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                mode TEXT NOT NULL CHECK(mode IN ('watch', 'holding')),
                last_trade_price REAL NOT NULL,
                holding_shares REAL NOT NULL DEFAULT 0,
                group_name TEXT NOT NULL DEFAULT '默认分组',
                alert_percent REAL NOT NULL DEFAULT 0.05,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fund_id INTEGER NOT NULL,
                trade_date TEXT NOT NULL,
                side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
                amount REAL,
                shares REAL,
                price REAL NOT NULL,
                note TEXT,
                is_settled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                FOREIGN KEY (fund_id) REFERENCES funds(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_trades_fund_id_date
                ON trades(fund_id, trade_date DESC, id DESC);
            """
        )
        
        # 兼容老数据库：尝试添加新列如果尚不存在
        try:
            conn.execute("ALTER TABLE funds ADD COLUMN group_name TEXT NOT NULL DEFAULT '默认分组';")
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("ALTER TABLE funds ADD COLUMN alert_percent REAL NOT NULL DEFAULT 0.05;")
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("ALTER TABLE trades ADD COLUMN amount REAL;")
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("ALTER TABLE trades ADD COLUMN shares REAL;")
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("ALTER TABLE trades ADD COLUMN is_settled INTEGER NOT NULL DEFAULT 1;")
        except sqlite3.OperationalError:
            pass

        # Sync existing groups to the new table
        conn.execute("INSERT OR IGNORE INTO fund_groups(name) VALUES ('默认分组');")
        conn.execute("INSERT OR IGNORE INTO fund_groups(name) SELECT DISTINCT group_name FROM funds WHERE group_name != '';")


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


def fetch_history_price(code: str, date_str: str, force_refresh: bool = False) -> float | None:
    if not code or not date_str:
        return None

    cache_key = (code, date_str)
    now = time.time()
    if not force_refresh:
        with HISTORY_PRICE_CACHE_LOCK:
            cached = HISTORY_PRICE_CACHE.get(cache_key)
            if cached and (now - cached["ts"] <= CACHE_TTL_SECONDS):
                return cached["price"]

    headers = {
        "Referer": f"http://fundf10.eastmoney.com/jjjz_{code}.html",
        "User-Agent": "Mozilla/5.0",
    }
    url = (
        f"https://api.fund.eastmoney.com/f10/lsjz?fundCode={code}&pageIndex=1&pageSize=1"
        f"&startDate={date_str}&endDate={date_str}"
    )

    price: float | None = None
    try:
        resp = requests.get(url, headers=headers, timeout=5)
        data = resp.json()
        items = data.get("Data", {}).get("LSJZList", [])
        if items and len(items) > 0:
            dwjz = items[0].get("DWJZ")
            if dwjz is not None and dwjz != "":
                price = float(dwjz)
    except Exception:
        price = None

    with HISTORY_PRICE_CACHE_LOCK:
        HISTORY_PRICE_CACHE[cache_key] = {"ts": now, "price": price}
    return price


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


def split_groups(group_value: str | None) -> list[str]:
    if not group_value:
        return []
    return [part.strip() for part in re.split(r"\s*\|\s*", group_value) if part.strip()]


def join_groups(groups: list[str]) -> str:
    seen: set[str] = set()
    merged: list[str] = []
    for group in groups:
        name = str(group).strip()
        if name and name not in seen:
            seen.add(name)
            merged.append(name)
    return GROUP_SEPARATOR.join(merged) if merged else "默认分组"


def apply_group_token_change(group_value: str | None, old_name: str | None = None, new_name: str | None = None, remove_name: str | None = None) -> str:
    groups = split_groups(group_value)
    updated: list[str] = []
    for group in groups:
        if remove_name and group == remove_name:
            continue
        if old_name and new_name and group == old_name:
            group = new_name
        updated.append(group)
    return join_groups(updated)


def compute_signal(current_price: float | None, base_price: float | None, alert_percent: float = 0.05) -> tuple[str, float | None, float | None]:
    if current_price is None or base_price is None or base_price <= 0:
        return "no-data", None, None
    buy_line = base_price * (1 - alert_percent)
    sell_line = base_price * (1 + alert_percent)
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


@app.get("/api/groups")
def list_groups():
    with get_db() as conn:
        table_rows = conn.execute("SELECT name FROM fund_groups ORDER BY sort_order ASC, id ASC").fetchall()
        fund_rows = conn.execute("SELECT group_name FROM funds").fetchall()

    groups: list[str] = []
    seen: set[str] = set()
    for row in table_rows:
        name = str(row["name"]).strip()
        if name and name not in seen:
            seen.add(name)
            groups.append(name)
    for row in fund_rows:
        for name in split_groups(row["group_name"]):
            if name not in seen:
                seen.add(name)
                groups.append(name)
    return jsonify({"groups": groups})


@app.post("/api/groups")
def create_group():
    payload = get_payload()
    name = str(payload.get("name", "")).strip()
    if not name:
        return jsonify({"error": "分组名称不能为空"}), 400
    try:
        with get_db() as conn:
            conn.execute("INSERT INTO fund_groups(name) VALUES (?)", (name,))
    except sqlite3.IntegrityError:
        return jsonify({"error": "该分组已存在"}), 409
    return jsonify({"ok": True, "message": "分组已创建"})


@app.put("/api/groups/<string:old_name>")
def rename_group(old_name: str):
    payload = get_payload()
    new_name = str(payload.get("new_name", "")).strip()
    if not new_name:
        return jsonify({"error": "新名称不能为空"}), 400
    try:
        with get_db() as conn:
            conn.execute("UPDATE fund_groups SET name = ? WHERE name = ?", (new_name, old_name))
            rows = conn.execute("SELECT id, group_name FROM funds").fetchall()
            for row in rows:
                updated = apply_group_token_change(row["group_name"], old_name=old_name, new_name=new_name)
                if updated != row["group_name"]:
                    conn.execute("UPDATE funds SET group_name = ? WHERE id = ?", (updated, row["id"]))
    except sqlite3.IntegrityError:
        return jsonify({"error": "目标分组已存在"}), 409
    return jsonify({"ok": True, "message": "分组已重命名"})


@app.delete("/api/groups/<string:name>")
def delete_group(name: str):
    if name == "默认分组":
        return jsonify({"error": "系统默认分组不可删除"}), 400
    with get_db() as conn:
        rows = conn.execute("SELECT id, group_name FROM funds").fetchall()
        for row in rows:
            updated = apply_group_token_change(row["group_name"], remove_name=name)
            if not split_groups(updated):
                updated = "默认分组"
            if updated != row["group_name"]:
                conn.execute("UPDATE funds SET group_name = ? WHERE id = ?", (updated, row["id"]))
        conn.execute("DELETE FROM fund_groups WHERE name = ?", (name,))
    return jsonify({"ok": True, "message": "分组已删除，关联基金已移至默认分组"})


@app.get("/api/funds")
def list_funds():
    force_refresh = request.args.get("force") == "1"
    with get_db() as conn:
        funds = conn.execute("SELECT * FROM funds ORDER BY id DESC").fetchall()
        trade_summaries = load_trade_summaries(conn)
        
        # 统计每个基金的交易记录
        trade_counts = {}
        trade_rows = conn.execute("SELECT fund_id, COUNT(*) as cnt FROM trades GROUP BY fund_id").fetchall()
        for row in trade_rows:
            trade_counts[row["fund_id"]] = int(row["cnt"])

        pending_rows = conn.execute(
            """
            SELECT
                fund_id,
                MIN(trade_date) AS earliest_pending_date,
                SUM(CASE WHEN side = 'buy' THEN COALESCE(shares, 0) ELSE 0 END) AS pending_buy_shares,
                SUM(CASE WHEN side = 'buy' THEN COALESCE(amount, 0) ELSE 0 END) AS pending_buy_amount,
                SUM(CASE WHEN side = 'sell' THEN COALESCE(shares, 0) ELSE 0 END) AS pending_sell_shares,
                SUM(CASE WHEN side = 'sell' THEN COALESCE(amount, 0) ELSE 0 END) AS pending_sell_amount,
                COUNT(*) AS pending_count
            FROM trades
            WHERE is_settled = 0
            GROUP BY fund_id
            """
        ).fetchall()

    pending_summaries: dict[int, dict[str, Any]] = {}
    for row in pending_rows:
        earliest_pending_date = str(row["earliest_pending_date"] or "")
        pending_summaries[int(row["fund_id"])] = {
            "earliest_pending_date": earliest_pending_date,
            "pending_buy_shares": float(row["pending_buy_shares"] or 0),
            "pending_buy_amount": float(row["pending_buy_amount"] or 0),
            "pending_sell_shares": float(row["pending_sell_shares"] or 0),
            "pending_sell_amount": float(row["pending_sell_amount"] or 0),
            "pending_count": int(row["pending_count"] or 0),
        }

    data: list[dict[str, Any]] = []
    summary_market_value = 0.0
    summary_pnl = 0.0
    alert_count = 0

    for fund in funds:
        fund_id = int(fund["id"])
        code = fund["code"]
        group_name = join_groups(split_groups(fund["group_name"]))
        alert_percent = float(fund["alert_percent"])
        
        quote = fetch_quote(code, force_refresh=force_refresh)

        current_price = quote["current_price"] if quote else None
        latest_nav = quote["latest_nav"] if quote else None
        daily_change_pct = quote["daily_change_pct"] if quote else None
        quote_time = quote["quote_time"] if quote else None
        display_name = (quote["name"] if quote and quote.get("name") else fund["name"]) or code

        base_price = to_float(fund["last_trade_price"])
        shares = float(fund["holding_shares"] or 0)
        signal, buy_line, sell_line = compute_signal(current_price, base_price, alert_percent)

        trade_info = trade_summaries.get(fund_id, {"buy_total": 0.0, "sell_total": 0.0})
        valuation_price = current_price if current_price is not None else base_price
        market_value = shares * valuation_price if valuation_price else 0.0
        cumulative_pnl = market_value + trade_info["sell_total"] - trade_info["buy_total"]

        if signal in {"buy", "sell"}:
            alert_count += 1

        summary_market_value += market_value
        summary_pnl += cumulative_pnl
        
        # 自动确定状态：有交易记录且市值>0则为holding，否则为watch
        auto_mode = fund["mode"]
        has_trades = trade_counts.get(fund_id, 0) > 0
        if has_trades and market_value > 1e-9:
            auto_mode = "holding"
        elif not has_trades or abs(market_value) < 1e-9:
            auto_mode = "watch"

        pending_summary = pending_summaries.get(fund_id, {
            "earliest_pending_date": "",
            "pending_buy_shares": 0.0,
            "pending_buy_amount": 0.0,
            "pending_sell_shares": 0.0,
            "pending_sell_amount": 0.0,
            "pending_count": 0,
        })

        # 文案切换逻辑：当交易日净值已可获取时，显示“买入中/赎回中”；否则显示“待买入/待卖出”。
        pending_display_mode = "pending"
        pending_price = None
        if pending_summary["pending_count"] > 0 and pending_summary["earliest_pending_date"]:
            pending_price = fetch_history_price(code, pending_summary["earliest_pending_date"], force_refresh=force_refresh)
            if pending_price is not None:
                pending_display_mode = "settling"
        
        # 持仓份额四舍五入保留两位
        rounded_shares = round(shares, 2)

        data.append(
            {
                "id": fund_id,
                "code": code,
                "name": display_name,
                "group_name": group_name,
                "alert_percent": alert_percent,
                "mode": auto_mode,
                "last_trade_price": base_price,
                "holding_shares": rounded_shares,
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
                "pending_buy_shares": pending_summary["pending_buy_shares"],
                "pending_buy_amount": pending_summary["pending_buy_amount"],
                "pending_sell_shares": pending_summary["pending_sell_shares"],
                "pending_sell_amount": pending_summary["pending_sell_amount"],
                "pending_count": pending_summary["pending_count"],
                "pending_display_mode": pending_display_mode,
                "pending_price": pending_price,
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


@app.get("/api/quote")
def quote_api():
    code = request.args.get("code", "")
    if not validate_fund_code(code):
        return jsonify({"error": "Invalid code"}), 400
    q = fetch_quote(code, force_refresh=True)
    if q:
        return jsonify({"name": q.get("name", ""), "price": q.get("current_price") or q.get("latest_nav")})
    return jsonify({"name": "", "price": None})

@app.post("/api/funds/batch")
def batch_create_funds():
    payload = get_payload()
    codes_str = str(payload.get("codes", ""))
    codes = set(re.findall(r"\d{6}", codes_str))
    if not codes:
        return jsonify({"error": "未发现有效的6位基金代码。"}), 400
    
    success_count = 0
    errors = []
    created_at = now_iso()
    with get_db() as conn:
        for code in codes:
            try:
                quote = fetch_quote(code, force_refresh=False)
                name = quote.get("name") if quote else code
                if quote and quote.get("current_price"):
                    last_trade_price = float(quote["current_price"])
                elif quote and quote.get("latest_nav"):
                    last_trade_price = float(quote["latest_nav"])
                else:
                    last_trade_price = 0.0
                
                conn.execute(
                    """
                    INSERT INTO funds(code, name, mode, last_trade_price, holding_shares, group_name, alert_percent, created_at, updated_at)
                    VALUES (?, ?, 'watch', ?, 0, '默认分组', 0.05, ?, ?)
                    """,
                    (code, name, last_trade_price, created_at, created_at),
                )
                success_count += 1
            except sqlite3.IntegrityError:
                errors.append(f"{code}(已存在)")
            except Exception as e:
                errors.append(f"{code}(错误)")
    
    msg = f"成功导入 {success_count} 只基金。"
    if errors:
        msg += f" 失败: {', '.join(errors)}"
    return jsonify({"ok": True, "message": msg})

@app.post("/api/funds")
def create_fund():
    payload = get_payload()
    code = str(payload.get("code", "")).strip()
    if not validate_fund_code(code):
        return jsonify({"error": "基金代码必须是 6 位数字。"}), 400

    mode = normalize_mode(str(payload.get("mode", "watch")).strip())
    group_name = str(payload.get("group_name", "默认分组")).strip()
    alert_percent = to_float(payload.get("alert_percent"))
    alert_percent = alert_percent if alert_percent is not None else 0.05
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
        elif quote and quote.get("latest_nav"):
            last_trade_price = float(quote["latest_nav"])
        else:
            last_trade_price = 0.0

    if shares > 0 and mode == "watch":
        mode = "holding"

    created_at = now_iso()
    try:
        with get_db() as conn:
            cursor = conn.execute(
                """
                INSERT INTO funds(code, name, mode, last_trade_price, holding_shares, group_name, alert_percent, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (code, name, mode, last_trade_price, shares, group_name, alert_percent, created_at, created_at),
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

    if "group_name" in payload:
        group_name = str(payload.get("group_name", "")).strip()
        updates.append("group_name = ?")
        params.append(group_name)

    if "alert_percent" in payload:
        alert_percent = to_float(payload.get("alert_percent"))
        if alert_percent is not None:
            updates.append("alert_percent = ?")
            params.append(alert_percent)

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
            SELECT id, trade_date, side, shares, price, note, is_settled, created_at
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
                    "is_settled": bool(row["is_settled"]),
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

    price = to_float(payload.get("price"))
    if price is None or price <= 0:
        return jsonify({"error": "成交单价必须大于 0。"}), 400

    shares = to_float(payload.get("shares"))
    amount = to_float(payload.get("amount"))

    # 按金额买入时自动计算份额
    if side == "buy":
        if amount is not None and amount > 0 and (shares is None or shares <= 0):
            shares = amount / price
        elif shares is not None and shares > 0 and (amount is None or amount <= 0):
            amount = shares * price
            
    # 按份额卖出时计算金额
    if side == "sell":
        if shares is not None and shares > 0 and (amount is None or amount <= 0):
            amount = shares * price
        elif amount is not None and amount > 0 and (shares is None or shares <= 0):
            shares = amount / price

    if shares is None or shares <= 0:
        return jsonify({"error": "份额或金额必须大于 0。"}), 400

    note = str(payload.get("note", "")).strip()
    created_at = now_iso()
    
    # 判断是否为当日交易（未结算）
    is_settled = 1 if trade_date != dt.date.today().isoformat() else 0

    with get_db() as conn:
        fund = conn.execute("SELECT * FROM funds WHERE id = ?", (fund_id,)).fetchone()
        if not fund:
            return jsonify({"error": "基金不存在。"}), 404

        current_shares = float(fund["holding_shares"] or 0)
        if side == "sell" and shares > current_shares and is_settled:
            return jsonify({"error": "卖出份额不能大于当前持仓份额。"}), 400

        # 当日交易：不更新持仓和基准价，等待第二天或价格更新
        if is_settled:
            new_shares = current_shares + shares if side == "buy" else current_shares - shares
            if abs(new_shares) < 1e-9:
                new_shares = 0.0
            update_price = price
        else:
            # 当日交易：暂不更新持仓和价格
            new_shares = current_shares
            update_price = float(fund["last_trade_price"] or 1.0)

        conn.execute(
            """
            INSERT INTO trades(fund_id, trade_date, side, amount, shares, price, note, is_settled, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (fund_id, trade_date, side, amount, shares, price, note, is_settled, created_at),
        )
        
        # 仅当is_settled=1时才更新基金的持仓和基准价
        if is_settled:
            conn.execute(
                """
                UPDATE funds
                SET holding_shares = ?, last_trade_price = ?, updated_at = ?
                WHERE id = ?
                """,
                (new_shares, update_price, created_at, fund_id),
            )

    msg = "交易已录入并更新基准价。" if is_settled else "交易已提交为待处理状态，将在第二天或晚间价格更新后自动结算。"
    return jsonify({"ok": True, "message": msg})


@app.post("/api/funds/<int:fund_id>/trades/batch")
def batch_create_trades(fund_id: int):
    payload = get_payload()
    trades = payload.get("trades", [])
    trades_data = str(payload.get("trades_data", "")).strip()
    
    # 支持两种格式：新格式(trades 数组)和老格式(trades_data 字符串)
    if trades_data and not trades:
        # 老格式：文本行处理
        lines = trades_data.split('\n')
    elif trades:
        # 新格式：trades 数组直接处理
        lines = trades
    else:
        return jsonify({"error": "数据为空"}), 400
    
    success_count = 0
    pending_count = 0
    created_at = now_iso()
    today = dt.date.today().isoformat()
    
    with get_db() as conn:
        fund = conn.execute("SELECT * FROM funds WHERE id = ?", (fund_id,)).fetchone()
        if not fund:
            return jsonify({"error": "基金不存在"}), 404
            
        current_shares = float(fund["holding_shares"] or 0)
        last_trade_price = float(fund["last_trade_price"] or 1.0)
        
        # 处理每条交易记录
        for trade_item in lines:
            # 兼容两种格式
            if isinstance(trade_item, str):
                # 老格式：文本行
                parts = trade_item.strip().split()
                if len(parts) < 4:
                    continue
                    
                trade_date = parts[0]
                try:
                    dt.date.fromisoformat(trade_date)
                except ValueError:
                    continue
                    
                side_str = parts[1]
                side = "buy" if "买" in side_str else "sell" if "卖" in side_str else None
                if not side: continue
                
                try:
                    price = float(parts[2])
                    shares = float(parts[3])
                    amount = price * shares
                except ValueError:
                    continue
                    
                note = " ".join(parts[4:]) if len(parts) > 4 else "批量导入"
            else:
                # 新格式：字典对象
                trade_date = trade_item.get("trade_date", "").strip()
                side = trade_item.get("side", "").strip()
                note = trade_item.get("note", "批量导入")
                
                try:
                    dt.date.fromisoformat(trade_date)
                except ValueError:
                    continue
                    
                if side not in ("buy", "sell"):
                    continue
                
                # 从trade_item中获取price, shares, amount
                price = trade_item.get("price")
                shares = trade_item.get("shares")
                amount = trade_item.get("amount")
                
                if not price or not shares:
                    # 如果没有提供，跳过
                    continue
                    
                try:
                    price = float(price)
                    shares = float(shares)
                    amount = float(amount) if amount else (price * shares)
                except (ValueError, TypeError):
                    continue
            
            # 判断是否为当日交易
            is_settled = 1 if trade_date != today else 0
            
            # 仅当is_settled=1时才更新current_shares
            if is_settled:
                new_shares = current_shares + shares if side == "buy" else current_shares - shares
                if new_shares < 0: new_shares = 0.0
                current_shares = new_shares
                last_trade_price = price
            
            conn.execute(
                """
                INSERT INTO trades(fund_id, trade_date, side, amount, shares, price, note, is_settled, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (fund_id, trade_date, side, amount, shares, price, note, is_settled, created_at),
            )
            success_count += 1
            if is_settled == 0:
                pending_count += 1
            
        if success_count > 0:
            conn.execute(
                """
                UPDATE funds
                SET holding_shares = ?, last_trade_price = ?, updated_at = ?
                WHERE id = ?
                """,
                (current_shares, last_trade_price, created_at, fund_id),
            )
            
    msg = f"成功导入 {success_count} 笔交易记录"
    if pending_count > 0:
        msg += f" ({pending_count} 笔待处理)"
    return jsonify({"ok": True, "message": msg})

@app.delete("/api/funds/<int:fund_id>/trades/<int:trade_id>")
def delete_trade(fund_id: int, trade_id: int):
    with get_db() as conn:
        trade = conn.execute("SELECT * FROM trades WHERE id = ? AND fund_id = ?", (trade_id, fund_id)).fetchone()
        if not trade:
            return jsonify({"error": "交易记录不存在。"}), 404

        fund = conn.execute("SELECT holding_shares, last_trade_price FROM funds WHERE id = ?", (fund_id,)).fetchone()
        if not fund:
            return jsonify({"error": "基金不存在。"}), 404

        side = trade["side"]
        shares = float(trade["shares"])
        current_shares = float(fund["holding_shares"] or 0)

        # 逆向计算回撤后的份额
        new_shares = current_shares - shares if side == "buy" else current_shares + shares
        if new_shares < 1e-9:
            new_shares = 0.0

        conn.execute("DELETE FROM trades WHERE id = ?", (trade_id,))

        # 查找删除该条记录后，该基金的最新一笔交易价格
        last_trade = conn.execute(
            """
            SELECT price FROM trades 
            WHERE fund_id = ? 
            ORDER BY trade_date DESC, id DESC 
            LIMIT 1
            """, 
            (fund_id,)
        ).fetchone()
        
        # 如果还有历史交易记录，则基准价回滚到上一笔；如果一条也没了，维持最后的状态或者重置（这里选择用回退后的上一笔价格）
        new_price = float(last_trade["price"]) if last_trade else float(fund["last_trade_price"])

        conn.execute(
            """
            UPDATE funds
            SET holding_shares = ?, last_trade_price = ?, updated_at = ?
            WHERE id = ?
            """,
            (new_shares, new_price, now_iso(), fund_id),
        )

    return jsonify({"ok": True, "message": "交易已撤销并重算持仓。"})


@app.post("/api/funds/<int:fund_id>/settle_pending_trades")
def settle_pending_trades(fund_id: int):
    """处理待处理的T+0交易，在T+1时将其标记为已结算"""
    now = dt.datetime.now()
    today = now.date().isoformat()

    if now.hour < 15:
        return jsonify({"ok": True, "settled_count": 0, "message": "尚未到结算时间。"})
    
    with get_db() as conn:
        fund = conn.execute("SELECT * FROM funds WHERE id = ?", (fund_id,)).fetchone()
        if not fund:
            return jsonify({"error": "基金不存在。"}), 404
        
        # 查询昨日未结算的交易
        pending_trades = conn.execute(
            """
            SELECT id, trade_date, side, amount, shares, price
            FROM trades
            WHERE fund_id = ? AND is_settled = 0 AND trade_date < ?
            ORDER BY trade_date ASC, id ASC
            """,
            (fund_id, today)
        ).fetchall()
        
        if not pending_trades:
            return jsonify({"ok": True, "settled_count": 0, "message": "没有待结算的交易。"})
        
        settled_count = 0
        current_shares = float(fund["holding_shares"] or 0)
        last_price = float(fund["last_trade_price"] or 1.0)
        
        for trade in pending_trades:
            trade_date = trade["trade_date"]
            side = trade["side"]
            raw_amount = float(trade["amount"] or 0)
            raw_shares = float(trade["shares"] or 0)

            # 结算时优先使用交易日净值；拿不到时回退到录入价格。
            settlement_price = fetch_history_price(str(fund["code"]), str(trade_date), force_refresh=True)
            if settlement_price is None:
                settlement_price = float(trade["price"])

            if side == "buy":
                amount = raw_amount if raw_amount > 0 else raw_shares * settlement_price
                shares = amount / settlement_price if settlement_price > 0 else raw_shares
            else:
                shares = raw_shares if raw_shares > 0 else (raw_amount / settlement_price if settlement_price > 0 else 0)
                amount = shares * settlement_price
            price = settlement_price
            
            # 更新持仓
            if side == "buy":
                current_shares += shares
            else:
                current_shares -= shares
                if current_shares < 1e-9:
                    current_shares = 0.0
            
            # 更新基准价
            last_price = price

            conn.execute(
                """
                UPDATE trades
                SET amount = ?, shares = ?, price = ?
                WHERE id = ?
                """,
                (amount, shares, price, trade["id"]),
            )
            
            # 标记为已结算
            conn.execute(
                "UPDATE trades SET is_settled = 1 WHERE id = ?",
                (trade["id"],)
            )
            settled_count += 1
        
        # 更新基金持仓和价格
        if settled_count > 0:
            conn.execute(
                """
                UPDATE funds
                SET holding_shares = ?, last_trade_price = ?, updated_at = ?
                WHERE id = ?
                """,
                (current_shares, last_price, now_iso(), fund_id),
            )
        
        return jsonify({"ok": True, "settled_count": settled_count, "message": f"成功结算 {settled_count} 笔待处理交易。"})


@app.get("/api/get_history_price")
def get_history_price():
    code = request.args.get("code", "").strip()
    date_str = request.args.get("date", "").strip()
    if not code or not date_str:
        return jsonify({"error": "缺少 code 或 date 参数"}), 400

    price = fetch_history_price(code, date_str, force_refresh=True)
    if price is None:
        return jsonify({"error": "当天未查询到净值，可能非交易日", "price": None})
    return jsonify({"price": price})


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
