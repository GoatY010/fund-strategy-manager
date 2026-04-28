from __future__ import annotations

import concurrent.futures
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
CACHE_TTL_SECONDS = 120  # 延长缓存时间到2分钟
GROUP_SEPARATOR = " | "
API_TIMEOUT_QUOTE = 1.5  # 缩短行情API超时到1.5秒
API_TIMEOUT_HISTORY = 1.2  # 缩短历史价格API超时到1.2秒

QUOTE_CACHE: dict[str, dict[str, Any]] = {}
QUOTE_CACHE_LOCK = threading.Lock()
HISTORY_PRICE_CACHE: dict[tuple[str, str], dict[str, Any]] = {}
HISTORY_PRICE_CACHE_LOCK = threading.Lock()

# 并行请求线程池
QUOTE_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=20)

app = Flask(
    __name__,
    template_folder=str(BUNDLE_DIR / "templates"),
    static_folder=str(BUNDLE_DIR / "static"),
)


@app.after_request
def disable_api_cache(response):
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


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
            
            CREATE TABLE IF NOT EXISTS fund_quotes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fund_id INTEGER NOT NULL,
                quote_date TEXT NOT NULL,
                current_price REAL,
                latest_nav REAL,
                daily_change_pct REAL,
                quote_time TEXT,
                created_at TEXT NOT NULL,
                UNIQUE(fund_id, quote_date),
                FOREIGN KEY (fund_id) REFERENCES funds(id) ON DELETE CASCADE
            );
            
            CREATE INDEX IF NOT EXISTS idx_fund_quotes_date
                ON fund_quotes(fund_id, quote_date DESC);
            
            CREATE TABLE IF NOT EXISTS fund_history_prices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fund_id INTEGER NOT NULL,
                quote_date TEXT NOT NULL,
                net_value REAL NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(fund_id, quote_date),
                FOREIGN KEY (fund_id) REFERENCES funds(id) ON DELETE CASCADE
            );
            
            CREATE INDEX IF NOT EXISTS idx_fund_history_prices_date
                ON fund_history_prices(fund_id, quote_date DESC);
            """
        )
        
        # 添加fund_quotes表到现有数据库
        try:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS fund_quotes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    fund_id INTEGER NOT NULL,
                    quote_date TEXT NOT NULL,
                    current_price REAL,
                    latest_nav REAL,
                    daily_change_pct REAL,
                    quote_time TEXT,
                    created_at TEXT NOT NULL,
                    UNIQUE(fund_id, quote_date),
                    FOREIGN KEY (fund_id) REFERENCES funds(id) ON DELETE CASCADE
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_fund_quotes_date
                    ON fund_quotes(fund_id, quote_date DESC)
            """)
        except sqlite3.OperationalError:
            pass
        
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


def get_cached_data(cache_dict: dict, cache_lock: threading.Lock, key: Any, force_refresh: bool = False) -> Any | None:
    """通用缓存获取函数"""
    if not force_refresh:
        with cache_lock:
            cached = cache_dict.get(key)
            if cached and (time.time() - cached["ts"] <= CACHE_TTL_SECONDS):
                return cached["value"]
    return None


def set_cached_data(cache_dict: dict, cache_lock: threading.Lock, key: Any, value: Any) -> None:
    """通用缓存设置函数"""
    with cache_lock:
        cache_dict[key] = {"ts": time.time(), "value": value}


def fetch_quote(code: str, force_refresh: bool = False) -> dict[str, Any] | None:
    # 检查缓存
    cached_quote = get_cached_data(QUOTE_CACHE, QUOTE_CACHE_LOCK, code, force_refresh)
    if cached_quote is not None:
        return cached_quote

    quote: dict[str, Any] | None = None
    try:
        response = requests.get(
            QUOTE_API_TEMPLATE.format(code=code),
            timeout=API_TIMEOUT_QUOTE,
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
            daily_change_pct = to_float(parsed.get("gszzl"))
            
            # 计算昨日涨跌：根据当日净值和昨日净值计算
            # 由于API不直接提供，这里使用当日涨幅作为近似或从其他字段推断
            yesterday_change_pct = None
            
            quote = {
                "fund_code": parsed.get("fundcode", code),
                "name": parsed.get("name") or "",
                "current_price": current_price if current_price is not None else latest_nav,
                "latest_nav": latest_nav,
                "daily_change_pct": daily_change_pct,
                "yesterday_change_pct": yesterday_change_pct,  # API不提供，暂设为null
                "quote_time": parsed.get("gztime") or parsed.get("jzrq"),
            }
    except requests.RequestException:
        quote = None

    # 保存到缓存
    set_cached_data(QUOTE_CACHE, QUOTE_CACHE_LOCK, code, quote)
    return quote


def fetch_history_price(code: str, date_str: str, force_refresh: bool = False) -> float | None:
    if not code or not date_str:
        return None

    cache_key = (code, date_str)
    
    # 1️⃣ 检查内存缓存
    cached_price = get_cached_data(HISTORY_PRICE_CACHE, HISTORY_PRICE_CACHE_LOCK, cache_key, force_refresh)
    if cached_price is not None:
        return cached_price
    
    # 2️⃣ 当 force_refresh=False（本地缓存查询）时，优先从本地DB查询
    if not force_refresh:
        try:
            with get_db() as conn:
                # 找 fund_id
                cursor = conn.execute("SELECT id FROM funds WHERE code = ?", (code,))
                fund_row = cursor.fetchone()
                if fund_row:
                    fund_id = fund_row[0]
                    # 从历史价格表查询
                    cursor = conn.execute(
                        "SELECT net_value FROM fund_history_prices WHERE fund_id = ? AND quote_date = ?",
                        (fund_id, date_str)
                    )
                    price_row = cursor.fetchone()
                    if price_row:
                        price = price_row[0]
                        # 保存到缓存
                        set_cached_data(HISTORY_PRICE_CACHE, HISTORY_PRICE_CACHE_LOCK, cache_key, price)
                        return price
        except Exception:
            pass

    # 3️⃣ 本地查询失败或 force_refresh=True，调用API
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
        resp = requests.get(url, headers=headers, timeout=API_TIMEOUT_HISTORY)
        data = resp.json()
        items = data.get("Data", {}).get("LSJZList", [])
        if items and len(items) > 0:
            dwjz = items[0].get("DWJZ")
            if dwjz is not None and dwjz != "":
                price = float(dwjz)
    except Exception:
        price = None

    # 4️⃣ API调用成功后，自动存储到本地DB
    if price is not None:
        try:
            with get_db() as conn:
                cursor = conn.execute("SELECT id FROM funds WHERE code = ?", (code,))
                fund_row = cursor.fetchone()
                if fund_row:
                    fund_id = fund_row[0]
                    conn.execute(
                        "INSERT OR REPLACE INTO fund_history_prices (fund_id, quote_date, net_value, created_at) "
                        "VALUES (?, ?, ?, ?)",
                        (fund_id, date_str, price, now_iso())
                    )
        except Exception:
            pass

    # 保存到缓存
    set_cached_data(HISTORY_PRICE_CACHE, HISTORY_PRICE_CACHE_LOCK, cache_key, price)
    return price


def get_yesterday_change_pct(code: str, today_nav: float | None) -> float | None:
    """
    计算昨日涨跌：优先从本地DB查询，避免不必要的API调用
    """
    try:
        with get_db() as conn:
            cursor = conn.execute("SELECT id FROM funds WHERE code = ?", (code,))
            fund_row = cursor.fetchone()
            if not fund_row:
                return None

            fund_id = fund_row[0]
            cursor = conn.execute(
                """
                SELECT net_value
                FROM fund_history_prices
                WHERE fund_id = ?
                ORDER BY quote_date DESC
                LIMIT 2
                """,
                (fund_id,)
            )
            rows = cursor.fetchall()

            if len(rows) >= 2:
                latest_nav = rows[0][0]
                previous_nav = rows[1][0]
                if latest_nav and previous_nav and previous_nav > 0:
                    # 直接使用历史表最新两条净值计算昨日涨跌
                    change = ((latest_nav - previous_nav) / previous_nav) * 100
                    return round(change, 2)

        # 本地历史不足时，回退到当前净值和昨日历史净值
        if today_nav and today_nav > 0:
            yesterday = (dt.datetime.now() - dt.timedelta(days=1)).date().isoformat()
            yesterday_nav = fetch_history_price(code, yesterday, False)
            if yesterday_nav and yesterday_nav > 0:
                change = ((today_nav - yesterday_nav) / yesterday_nav) * 100
                return round(change, 2)
    except Exception:
        pass
    
    return None


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


def normalize_amount_and_shares(side: str, amount: float | None, shares: float | None, price: float) -> tuple[float, float]:
    """
    标准化金额和份额。根据买卖方向和提供的参数，计算缺失的值。
    
    Args:
        side: "buy" 或 "sell"
        amount: 金额（可能为None或<=0）
        shares: 份额（可能为None或<=0）
        price: 单价
    
    Returns:
        (normalized_amount, normalized_shares)
    """
    amount = amount or 0
    shares = shares or 0
    
    # 买入：优先用金额算份额
    if side == "buy":
        if amount > 0 and shares <= 0:
            shares = amount / price if price > 0 else 0
        elif shares > 0 and amount <= 0:
            amount = shares * price
    
    # 卖出：优先用份额算金额
    elif side == "sell":
        if shares > 0 and amount <= 0:
            amount = shares * price
        elif amount > 0 and shares <= 0:
            shares = amount / price if price > 0 else 0
    
    return (amount, shares)


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
        WHERE is_settled = 1
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
    today = dt.date.today().isoformat()
    yesterday = (dt.date.today() - dt.timedelta(days=1)).isoformat()
    
    timer_total_start = time.time()
    timer_db_start = time.time()
    
    with get_db() as conn:
        funds = conn.execute("SELECT * FROM funds ORDER BY id DESC").fetchall()
        trade_summaries = load_trade_summaries(conn)
        
        # 统计每个基金的交易记录
        trade_counts = {}
        trade_rows = conn.execute("SELECT fund_id, COUNT(*) as cnt FROM trades GROUP BY fund_id").fetchall()
        for row in trade_rows:
            trade_counts[row["fund_id"]] = int(row["cnt"])

        trade_rows = conn.execute(
            """
            SELECT
                fund_id,
                MIN(trade_date) AS first_unsettled_trade_date,
                SUM(CASE WHEN DATE(created_at) = ? THEN 1 ELSE 0 END) AS subtitle_today_trade_count,
                SUM(CASE WHEN DATE(created_at) = ? THEN 1 ELSE 0 END) AS subtitle_yesterday_trade_count,
                SUM(CASE WHEN DATE(created_at) < ? THEN 1 ELSE 0 END) AS older_trade_count,
                SUM(CASE WHEN DATE(created_at) < ? AND trade_date < ? THEN 1 ELSE 0 END) AS settlement_review_trade_count,
                SUM(CASE WHEN DATE(created_at) = ? AND side = 'buy' THEN COALESCE(shares, 0) ELSE 0 END) AS subtitle_today_buy_shares,
                SUM(CASE WHEN DATE(created_at) = ? AND side = 'buy' THEN COALESCE(amount, 0) ELSE 0 END) AS subtitle_today_buy_amount,
                SUM(CASE WHEN DATE(created_at) = ? AND side = 'sell' THEN COALESCE(shares, 0) ELSE 0 END) AS subtitle_today_sell_shares,
                SUM(CASE WHEN DATE(created_at) = ? AND side = 'sell' THEN COALESCE(amount, 0) ELSE 0 END) AS subtitle_today_sell_amount,
                SUM(CASE WHEN DATE(created_at) = ? AND side = 'buy' THEN COALESCE(shares, 0) ELSE 0 END) AS subtitle_yesterday_buy_shares,
                SUM(CASE WHEN DATE(created_at) = ? AND side = 'buy' THEN COALESCE(amount, 0) ELSE 0 END) AS subtitle_yesterday_buy_amount,
                SUM(CASE WHEN DATE(created_at) = ? AND side = 'sell' THEN COALESCE(shares, 0) ELSE 0 END) AS subtitle_yesterday_sell_shares,
                SUM(CASE WHEN DATE(created_at) = ? AND side = 'sell' THEN COALESCE(amount, 0) ELSE 0 END) AS subtitle_yesterday_sell_amount,
                SUM(CASE WHEN DATE(created_at) < ? AND trade_date < ? AND side = 'buy' THEN COALESCE(shares, 0) ELSE 0 END) AS settlement_review_buy_shares,
                SUM(CASE WHEN DATE(created_at) < ? AND trade_date < ? AND side = 'buy' THEN COALESCE(amount, 0) ELSE 0 END) AS settlement_review_buy_amount,
                SUM(CASE WHEN DATE(created_at) < ? AND trade_date < ? AND side = 'sell' THEN COALESCE(shares, 0) ELSE 0 END) AS settlement_review_sell_shares,
                SUM(CASE WHEN DATE(created_at) < ? AND trade_date < ? AND side = 'sell' THEN COALESCE(amount, 0) ELSE 0 END) AS settlement_review_sell_amount
            FROM trades
            WHERE is_settled = 0
            GROUP BY fund_id
            """,
            (today, yesterday, yesterday, today, today, today, today, today, yesterday, yesterday, yesterday, yesterday, today, today, today, today, today, today, today, today, today),
        ).fetchall()

        # 🆕 从本地数据库查询今日行情中的价格信息；今日涨跌不落库，只走内存缓存/实时API
        local_quotes_rows = conn.execute(
            """
            SELECT fund_id, current_price, latest_nav, quote_time, name
            FROM fund_quotes
            LEFT JOIN funds ON fund_quotes.fund_id = funds.id
            WHERE fund_quotes.quote_date = ?
            """,
            (today,)
        ).fetchall()
        local_quotes = {}
        for row in local_quotes_rows:
            local_quotes[row["fund_id"]] = {
                "current_price": row["current_price"],
                "latest_nav": row["latest_nav"],
                "quote_time": row["quote_time"],
            }

    timer_db = time.time() - timer_db_start

    trade_buckets: dict[int, dict[str, Any]] = {}
    for row in trade_rows:
        first_unsettled_trade_date = str(row["first_unsettled_trade_date"] or "")
        trade_buckets[int(row["fund_id"])] = {
            "first_unsettled_trade_date": first_unsettled_trade_date,
            "subtitle_today_trade_count": int(row["subtitle_today_trade_count"] or 0),
            "subtitle_yesterday_trade_count": int(row["subtitle_yesterday_trade_count"] or 0),
            "older_trade_count": int(row["older_trade_count"] or 0),
            "settlement_review_trade_count": int(row["settlement_review_trade_count"] or 0),
            "subtitle_today_buy_shares": float(row["subtitle_today_buy_shares"] or 0),
            "subtitle_today_buy_amount": float(row["subtitle_today_buy_amount"] or 0),
            "subtitle_today_sell_shares": float(row["subtitle_today_sell_shares"] or 0),
            "subtitle_today_sell_amount": float(row["subtitle_today_sell_amount"] or 0),
            "subtitle_yesterday_buy_shares": float(row["subtitle_yesterday_buy_shares"] or 0),
            "subtitle_yesterday_buy_amount": float(row["subtitle_yesterday_buy_amount"] or 0),
            "subtitle_yesterday_sell_shares": float(row["subtitle_yesterday_sell_shares"] or 0),
            "subtitle_yesterday_sell_amount": float(row["subtitle_yesterday_sell_amount"] or 0),
            "settlement_review_buy_shares": float(row["settlement_review_buy_shares"] or 0),
            "settlement_review_buy_amount": float(row["settlement_review_buy_amount"] or 0),
            "settlement_review_sell_shares": float(row["settlement_review_sell_shares"] or 0),
            "settlement_review_sell_amount": float(row["settlement_review_sell_amount"] or 0),
        }

    data: list[dict[str, Any]] = []
    summary_market_value = 0.0
    summary_pnl = 0.0
    summary_daily_pnl = 0.0
    alert_count = 0

    # 🆕 今日涨跌只从内存缓存/实时API获取，不从数据库读取
    timer_api_start = time.time()
    quotes_dict = {}
    api_call_count = 0

    # 1️⃣  非手动刷新优先使用内存缓存；手动刷新才全量重拉实时行情
    missing_codes: list[str] = []
    for fund in funds:
        code = fund["code"]
        if not force_refresh:
            cached_quote = get_cached_data(QUOTE_CACHE, QUOTE_CACHE_LOCK, code, False)
            if cached_quote is not None:
                quotes_dict[code] = cached_quote
                continue

        missing_codes.append(code)

    
    if missing_codes:
        api_call_count = len(missing_codes)
        try:
            # 并行获取缺失的基金行情
            futures = {QUOTE_EXECUTOR.submit(fetch_quote, code, True): code for code in missing_codes}
            for future in concurrent.futures.as_completed(futures, timeout=30):
                code = futures[future]
                try:
                    quote = future.result(timeout=5)
                    if quote:
                        quotes_dict[code] = quote
                except Exception:
                    quotes_dict[code] = None
        except concurrent.futures.TimeoutError:
            pass
        
        # 💾 将获取到的API数据存储到本地数据库，同时异步获取昨日净值
        # 1️⃣ 先并行获取所有缺失基金的昨日净值
        yesterday_prices_dict: dict[str, float | None] = {}
        yesterday_str = (dt.datetime.now() - dt.timedelta(days=1)).date().isoformat()
        
        if missing_codes:
            try:
                yesterday_futures = {
                    QUOTE_EXECUTOR.submit(fetch_history_price, code, yesterday_str, True): code 
                    for code in missing_codes
                }
                for future in concurrent.futures.as_completed(yesterday_futures, timeout=30):
                    code = yesterday_futures[future]
                    try:
                        price = future.result(timeout=5)
                        yesterday_prices_dict[code] = price
                    except Exception:
                        yesterday_prices_dict[code] = None
            except concurrent.futures.TimeoutError:
                pass
        
        # 2️⃣ 存储行情数据和历史价格
        with get_db() as conn:
            for code, quote in quotes_dict.items():
                if quote and code in missing_codes:  # 只存储本次API调用的结果
                    # 找出对应的fund_id
                    fund_row = next((f for f in funds if f["code"] == code), None)
                    if fund_row:
                        fund_id = int(fund_row["id"])
                        
                        try:
                            # 存储今日价格信息，但不落库今日涨跌
                            conn.execute(
                                """
                                INSERT OR REPLACE INTO fund_quotes
                                (fund_id, quote_date, current_price, latest_nav, quote_time, created_at)
                                VALUES (?, ?, ?, ?, ?, ?)
                                """,
                                (
                                    fund_id,
                                    today,
                                    quote.get("current_price"),
                                    quote.get("latest_nav"),
                                    quote.get("quote_time"),
                                    now_iso(),
                                ),
                            )
                        except Exception:
                            pass
                        
                        # 3️⃣ 存储昨日历史价格（如果获取成功）
                        yesterday_price = yesterday_prices_dict.get(code)
                        if yesterday_price is not None:
                            try:
                                conn.execute(
                                    """
                                    INSERT OR REPLACE INTO fund_history_prices
                                    (fund_id, quote_date, net_value, created_at)
                                    VALUES (?, ?, ?, ?)
                                    """,
                                    (fund_id, yesterday_str, yesterday_price, now_iso()),
                                )
                                
                                # 计算昨日涨跌并更新quote对象
                                today_nav = quote.get("latest_nav")
                                if today_nav and today_nav > 0 and yesterday_price > 0:
                                    yesterday_change = round(((today_nav - yesterday_price) / yesterday_price) * 100, 2)
                                    quote["yesterday_change_pct"] = yesterday_change
                            except Exception:
                                pass
    
    timer_api = time.time() - timer_api_start
    
    for fund in funds:
        fund_id = int(fund["id"])
        code = fund["code"]
        group_name = join_groups(split_groups(fund["group_name"]))
        alert_percent = float(fund["alert_percent"])
        
        quote = quotes_dict.get(code)
        if quote is None:
            local_quote = local_quotes.get(fund_id)
            if local_quote is not None:
                quote = {
                    "current_price": local_quote["current_price"],
                    "latest_nav": local_quote["latest_nav"],
                    "daily_change_pct": None,
                    "yesterday_change_pct": None,
                    "quote_time": local_quote["quote_time"],
                    "name": fund["name"],
                }

        current_price = quote["current_price"] if quote else None
        latest_nav = quote["latest_nav"] if quote else None
        daily_change_pct = quote["daily_change_pct"] if quote else None
        quote_time = quote["quote_time"] if quote else None
        display_name = (quote["name"] if quote and quote.get("name") else fund["name"]) or code

        base_price = to_float(fund["last_trade_price"])
        shares = float(fund["holding_shares"] or 0)
        signal, buy_line, sell_line = compute_signal(current_price, base_price, alert_percent)

        trade_bucket = trade_buckets.get(fund_id, {
            "first_unsettled_trade_date": "",
            "subtitle_today_trade_count": 0,
            "subtitle_yesterday_trade_count": 0,
            "older_trade_count": 0,
            "settlement_review_trade_count": 0,
            "subtitle_today_buy_shares": 0.0,
            "subtitle_today_buy_amount": 0.0,
            "subtitle_today_sell_shares": 0.0,
            "subtitle_today_sell_amount": 0.0,
            "subtitle_yesterday_buy_shares": 0.0,
            "subtitle_yesterday_buy_amount": 0.0,
            "subtitle_yesterday_sell_shares": 0.0,
            "subtitle_yesterday_sell_amount": 0.0,
            "settlement_review_buy_shares": 0.0,
            "settlement_review_buy_amount": 0.0,
            "settlement_review_sell_shares": 0.0,
            "settlement_review_sell_amount": 0.0,
        })
        subtitle_trade_count = trade_bucket["subtitle_yesterday_trade_count"] + trade_bucket["subtitle_today_trade_count"]

        trade_info = trade_summaries.get(fund_id, {"buy_total": 0.0, "sell_total": 0.0})
        # 市值按当前估值计算，优先使用实时估值，其次回退到最新净值或成交价
        valuation_price = current_price if current_price is not None else (latest_nav if latest_nav is not None else base_price)
        effective_shares = shares + trade_bucket["settlement_review_buy_shares"]
        effective_buy_total = trade_info["buy_total"] + trade_bucket["settlement_review_buy_amount"]
        market_value = effective_shares * valuation_price if valuation_price else 0.0
        cumulative_pnl = market_value + trade_info["sell_total"] - effective_buy_total

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

        # 持仓份额四舍五入保留两位，仅用于展示
        rounded_shares = round(shares, 2)

        # 计算当日盈利 = 持仓市值 × (当日涨跌% / 100)
        daily_pnl = 0.0
        if market_value and daily_change_pct is not None:
            daily_pnl = float(market_value * (daily_change_pct / 100))
        summary_daily_pnl += daily_pnl
        
        # 获取昨日涨跌百分比（如果无数据则为0）
        yesterday_change_pct = get_yesterday_change_pct(code, latest_nav)
        if yesterday_change_pct is None:
            yesterday_change_pct = 0.0

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
                "yesterday_change_pct": yesterday_change_pct,
                "quote_time": quote_time,
                "buy_line": buy_line,
                "sell_line": sell_line,
                "signal": signal,
                "market_value": market_value,
                "buy_total": effective_buy_total,
                "sell_total": trade_info["sell_total"],
                "effective_holding_shares": round(effective_shares, 2),
                # subtitle_* 只给名称下方小字展示，不参与结算触发。
                "subtitle_trade_count": subtitle_trade_count,
                "subtitle_yesterday_trade_count": trade_bucket["subtitle_yesterday_trade_count"],
                "subtitle_today_trade_count": trade_bucket["subtitle_today_trade_count"],
                "subtitle_yesterday_buy_shares": trade_bucket["subtitle_yesterday_buy_shares"],
                "subtitle_yesterday_buy_amount": trade_bucket["subtitle_yesterday_buy_amount"],
                "subtitle_yesterday_sell_shares": trade_bucket["subtitle_yesterday_sell_shares"],
                "subtitle_yesterday_sell_amount": trade_bucket["subtitle_yesterday_sell_amount"],
                "subtitle_today_buy_shares": trade_bucket["subtitle_today_buy_shares"],
                "subtitle_today_buy_amount": trade_bucket["subtitle_today_buy_amount"],
                "subtitle_today_sell_shares": trade_bucket["subtitle_today_sell_shares"],
                "subtitle_today_sell_amount": trade_bucket["subtitle_today_sell_amount"],
                # settlement_review_* 只给第二日的二次检查和历史净值回写使用。
                "settlement_review_trade_count": trade_bucket["settlement_review_trade_count"],
                "settlement_review_buy_shares": trade_bucket["settlement_review_buy_shares"],
                "settlement_review_buy_amount": trade_bucket["settlement_review_buy_amount"],
                "settlement_review_sell_shares": trade_bucket["settlement_review_sell_shares"],
                "settlement_review_sell_amount": trade_bucket["settlement_review_sell_amount"],
                "cumulative_pnl": cumulative_pnl,
                "daily_pnl": daily_pnl,
                "updated_at": fund["updated_at"],
                "quote_available": quote is not None,
            }
        )

    timer_total = time.time() - timer_total_start
    
    # 🔍 性能日志输出
    print(f"\n📊 刷新性能统计:")
    print(f"   数据库查询: {timer_db*1000:.1f}ms (基金数: {len(funds)})")
    if api_call_count > 0:
        print(f"   API行情请求: {timer_api*1000:.1f}ms ({api_call_count}/{len(funds)} 个基金)")
    else:
        print(f"   API行情请求: 0ms (全部来自本地数据库 ✨)")
    print(f"   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"   总耗时: {timer_total*1000:.1f}ms")

    return jsonify(
        {
            "funds": data,
            "summary": {
                "count": len(data),
                "alerts": alert_count,
                "total_market_value": summary_market_value,
                "total_cumulative_pnl": summary_pnl,
                "total_daily_pnl": summary_daily_pnl,
            },
            "generated_at": now_iso(),
            "_perf": {
                "db_ms": int(timer_db * 1000),
                "api_ms": int(timer_api * 1000),
                "api_calls": api_call_count,
                "total_ms": int(timer_total * 1000),
            }
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

    # 标准化金额和份额
    amount, shares = normalize_amount_and_shares(side, amount, shares, price)
    
    if shares is None or shares <= 0:
        return jsonify({"error": "份额或金额必须大于 0。"}), 400

    note = str(payload.get("note", "")).strip()
    created_at = now_iso()
    
    # 交易日为今天或昨天时，先按待结算处理；更早的历史回填直接按已结算处理。
    yesterday = (dt.date.today() - dt.timedelta(days=1)).isoformat()
    is_settled = 1 if trade_date < yesterday else 0

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

    msg = "交易已录入并更新基准价。" if is_settled else "交易已提交为待结算状态，将在第二天或晚间价格更新后自动结算。"
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
    today_trade_count = 0
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
            
            # 交易日为今天或昨天时，先按待结算处理；更早的历史回填直接按已结算处理。
            is_settled = 1 if trade_date < (dt.date.today() - dt.timedelta(days=1)).isoformat() else 0
            
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
                today_trade_count += 1
            
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
    if today_trade_count > 0:
        msg += f" ({today_trade_count} 笔当日交易)"
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
@app.post("/api/funds/<int:fund_id>/review_settlement_trades")
def review_settlement_trades(fund_id: int):
    """第二日二次检查未结算交易，按历史净值回写后标记为已结算。"""
    now = dt.datetime.now()
    today = now.date().isoformat()

    if now.hour < 15:
        return jsonify({"ok": True, "settled_count": 0, "message": "尚未到结算时间。"})
    
    with get_db() as conn:
        fund = conn.execute("SELECT * FROM funds WHERE id = ?", (fund_id,)).fetchone()
        if not fund:
            return jsonify({"error": "基金不存在。"}), 404
        
        # 查询需要进入结算流程的未结算交易（今天以前）
        settlement_trades = conn.execute(
            """
            SELECT id, trade_date, side, amount, shares, price
            FROM trades
            WHERE fund_id = ? AND is_settled = 0 AND trade_date < ?
            ORDER BY trade_date ASC, id ASC
            """,
            (fund_id, today)
        ).fetchall()
        
        if not settlement_trades:
            return jsonify({"ok": True, "settled_count": 0, "message": "没有待结算的交易。"})
        
        settled_count = 0
        current_shares = float(fund["holding_shares"] or 0)
        last_price = float(fund["last_trade_price"] or 1.0)
        
        for trade in settlement_trades:
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
        
        return jsonify({"ok": True, "settled_count": settled_count, "message": f"成功结算 {settled_count} 笔待结算交易。"})


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
