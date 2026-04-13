// == Utils ==
function $(selector) {
    return document.querySelector(selector);
}

function $$(selector) {
    return document.querySelectorAll(selector);
}

function formatDate(ds) {
    if (!ds) return "--";
    return ds.replace("T", " ");
}

function formatMoney(val) {
    if (typeof val !== "number") return "--";
    return "¥" + val.toFixed(2);
}

function formatPercent(val) {
    if (typeof val !== "number") return "--";
    return val.toFixed(2) + "%";
}

function formatNumber(val, decimals = 4) {
    if (typeof val !== "number") return "--";
    return val.toFixed(decimals);
}

async function requestJSON(url, options = {}) {
    options.headers = options.headers || {};
    if (!options.headers["Content-Type"] && !options.body) {
        options.headers["Accept"] = "application/json";
    }
    const resp = await fetch(url, options);
    if (!resp.ok) {
        let msg = "请求失败";
        try {
            const err = await resp.json();
            if (err.error) msg = err.error;
        } catch (e) {}
        throw new Error(msg);
    }
    return resp.json();
}

// == State ==
let allFunds = [];
let currentGroup = "全部";

// Columns Definition
const COLS = [
    { field: "code", label: "代码" },
    { field: "name", label: "名称" },
    { field: "mode", label: "状态" },
    { field: "last_trade_price", label: "上次成交" },
    { field: "current_price", label: "当前估值" },
    { field: "daily_change_pct", label: "今日涨跌" },
    { field: "buy_line", label: "买入线" },
    { field: "sell_line", label: "卖出线" },
    { field: "signal", label: "信号" },
    { field: "holding_shares", label: "持仓份额" },
    { field: "market_value", label: "市值" },
    { field: "cumulative_pnl", label: "累计盈亏" },
    { field: "actions", label: "操作" }
];

let columnOrder = localStorage.getItem("columnOrder");
if (columnOrder) {
    columnOrder = JSON.parse(columnOrder);
    // ensure all fields exist
    const currentFields = COLS.map(c => c.field);
    if (columnOrder.length !== currentFields.length || columnOrder.some(f => !currentFields.includes(f))) {
        columnOrder = currentFields;
    }
} else {
    columnOrder = COLS.map(c => c.field);
}


// == Initialization ==
document.addEventListener("DOMContentLoaded", () => {
    // Fill current date
    const today = new Date().toISOString().split("T")[0];
    $("#addTradeDate").value = today;
    $("#tradeDate").value = today;

    // Events
    $("#refreshBtn").addEventListener("click", () => loadData(true));
    $("#addFundForm").addEventListener("submit", handleAddFund);
    $("#editFundForm").addEventListener("submit", handleEditFund);
    $("#tradeForm").addEventListener("submit", handleTrade);

    // Auto fetch prices
    $("#addTradeDate").addEventListener("blur", autoFetchAddPrice);
    $("#addCode").addEventListener("blur", autoFetchAddPrice);
    $("#fetchAddPriceBtn").addEventListener("click", autoFetchAddPrice);

    $("#tradeDate").addEventListener("blur", autoFetchTradePrice);
    $("#fetchTradePriceBtn").addEventListener("click", autoFetchTradePrice);

    initDnDHeaders();
    loadData();
});

// Drag and drop column logic
function initDnDHeaders() {
    renderHeaders();
}

function renderHeaders() {
    const tr = $("#tableHeader");
    tr.innerHTML = "";
    columnOrder.forEach(field => {
        const colInfo = COLS.find(c => c.field === field);
        const th = document.createElement("th");
        th.dataset.field = field;
        th.textContent = colInfo.label;
        if (field !== "actions") {
            th.draggable = true;
            th.addEventListener("dragstart", handleDragStart);
            th.addEventListener("dragover", handleDragOver);
            th.addEventListener("drop", handleDrop);
        }
        tr.appendChild(th);
    });
}

let draggedField = null;
function handleDragStart(e) {
    draggedField = e.target.dataset.field;
    e.dataTransfer.effectAllowed = "move";
}
function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
}
function handleDrop(e) {
    e.preventDefault();
    const targetField = e.target.dataset.field;
    if (targetField && draggedField && targetField !== draggedField && targetField !== "actions") {
        const oldIdx = columnOrder.indexOf(draggedField);
        const newIdx = columnOrder.indexOf(targetField);
        columnOrder.splice(oldIdx, 1);
        columnOrder.splice(newIdx, 0, draggedField);
        localStorage.setItem("columnOrder", JSON.stringify(columnOrder));
        renderHeaders();
        renderTable();
    }
}


// Auto Fetch Logic
async function fetchHistory(code, dateStr) {
    if(!code || !dateStr || code.length !== 6) return null;
    try {
        const res = await requestJSON(`/api/get_history_price?code=${code}&date=${dateStr}`);
        return res.price;
    } catch(e) { return null; }
}

async function autoFetchAddPrice() {
    const code = $("#addCode").value;
    const dateStr = $("#addTradeDate").value;
    const price = await fetchHistory(code, dateStr);
    if(price) $("#addPrice").value = price;
}

async function autoFetchTradePrice() {
    const code = $("#tradeCode").value;
    const dateStr = $("#tradeDate").value;
    const price = await fetchHistory(code, dateStr);
    if(price) $("#tradePrice").value = price;
}

function updateGroupTabs() {
    const groups = new Set();
    allFunds.forEach(f => groups.add(f.group_name));
    
    // update datalist
    const dl = $("#groupList");
    const dle = $("#groupListEdit");
    dl.innerHTML = ""; dle.innerHTML = "";
    groups.forEach(g => {
        dl.innerHTML += `<option value="${g}">`;
        dle.innerHTML += `<option value="${g}">`;
    });

    const wrap = $("#groupTabs");
    let html = `<button class="tab-btn ${currentGroup === '全部' ? 'active' : ''}" data-group="全部">全部</button>`;
    groups.forEach(g => {
        html += `<button class="tab-btn ${currentGroup === g ? 'active' : ''}" data-group="${g}">${g}</button>`;
    });
    wrap.innerHTML = html;

    $$(".tab-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            currentGroup = e.target.dataset.group;
            updateGroupTabs();
            renderTable();
        });
    });
}

// == Data Loading ==
async function loadData(force = false) {
    try {
        const data = await requestJSON(`/api/funds?force=${force ? 1 : 0}`);
        $("#lastUpdated").textContent = "上次刷新: " + formatDate(data.generated_at);
        allFunds = data.funds;
        updateSummary(data.summary);
        updateGroupTabs();
        renderTable();
    } catch (err) {
        alert(err.message);
    }
}

function updateSummary(summary) {
    $("#summaryCount").textContent = summary.count;
    $("#summaryAlerts").textContent = summary.alerts;
    $("#summaryMarketValue").textContent = formatMoney(summary.total_market_value);
    
    const pnlEl = $("#summaryPnL");
    pnlEl.textContent = formatMoney(summary.total_cumulative_pnl);
    pnlEl.className = summary.total_cumulative_pnl > 0 ? "color-up" : (summary.total_cumulative_pnl < 0 ? "color-down" : "");
}

function renderTable() {
    const tbody = $("#fundTableBody");
    tbody.innerHTML = "";

    const list = allFunds.filter(f => currentGroup === "全部" || f.group_name === currentGroup);

    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="13" class="empty">该分组暂无基金。</td></tr>`;
        return;
    }

    list.forEach(fund => {
        const tr = document.createElement("tr");

        columnOrder.forEach(field => {
            const td = document.createElement("td");
            td.innerHTML = getCellHtml(fund, field);
            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    });
}

function getCellHtml(fund, field) {
    switch(field) {
        case "code": return fund.code;
        case "name": return `<div class="ellips align-left" style="max-width:140px;" title="${fund.name}">${fund.name}</div>`;
        case "mode": return fund.mode === "holding" ? '<span class="badge">持有</span>' : '<span class="badge badge-outline">观察</span>';
        case "last_trade_price": return formatNumber(fund.last_trade_price);
        case "current_price": 
            const cp = formatNumber(fund.current_price);
            if (!fund.quote_available) return `<span class="muted" title="无实时行情">${cp}</span>`;
            return cp;
        case "daily_change_pct": 
            const dcp = fund.daily_change_pct;
            const dcpText = formatPercent(dcp);
            const dcpClass = dcp > 0 ? "color-up" : (dcp < 0 ? "color-down" : "");
            return `<span class="${dcpClass}">${dcp > 0 ? '+' : ''}${dcpText}</span>`;
        case "buy_line": return formatNumber(fund.buy_line);
        case "sell_line": return formatNumber(fund.sell_line);
        case "signal": 
            if (fund.signal === "buy") return '<strong class="color-down">准备买入</strong>';
            if (fund.signal === "sell") return '<strong class="color-up">准备卖出</strong>';
            return '<span class="muted">持仓观望</span>';
        case "holding_shares": return formatNumber(fund.holding_shares, 2);
        case "market_value": return formatMoney(fund.market_value);
        case "cumulative_pnl": 
            const pnl = fund.cumulative_pnl;
            const pnlClass = pnl > 0 ? "color-up" : (pnl < 0 ? "color-down" : "");
            return `<span class="${pnlClass}">${pnl > 0 ? '+' : ''}${formatMoney(pnl)}</span>`;
        case "actions": 
            return `
                <div class="action-links">
                    <a href="javascript:void(0)" onclick="openTradeDialog(${fund.id}, '${fund.code}')">交易</a>
                    <a href="javascript:void(0)" onclick="openEditDialog(${fund.id})">配置</a>
                </div>
            `;
    }
    return "";
}

// == Actions ==
async function handleAddFund(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    
    // Calculate amount / shares conversion
    const aos = parseFloat(payload.amount_or_shares || 0);
    const mode = payload.mode;
    const price = parseFloat(payload.last_trade_price || 0);

    if (mode === "holding" && aos > 0) {
        if (price > 0) {
            // treat as amount to translate into shares
            payload.holding_shares = aos / price;
            payload.amount = aos; // sending to backend
        } else {
            // treat exactly as holding shares
            payload.holding_shares = aos;
        }
    } else {
        payload.holding_shares = 0;
    }
    
    try {
        await requestJSON("/api/funds", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        e.target.reset();
        loadData();
    } catch (err) {
        alert(err.message);
    }
}

// Edit
function openEditDialog(fundId) {
    const fund = allFunds.find(f => f.id === fundId);
    if (!fund) return;
    const form = $("#editFundForm");
    form.fund_id.value = fund.id;
    form.name.value = fund.name;
    form.mode.value = fund.mode;
    form.group_name.value = fund.group_name;
    form.alert_percent.value = fund.alert_percent;
    form.holding_shares.value = fund.holding_shares;
    form.last_trade_price.value = fund.last_trade_price;
    $("#editDialog").showModal();
}

async function handleEditFund(e) {
    e.preventDefault();
    const form = e.target;
    const fundId = form.fund_id.value;
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.holding_shares = parseFloat(payload.holding_shares);
    payload.last_trade_price = parseFloat(payload.last_trade_price);
    payload.alert_percent = parseFloat(payload.alert_percent);

    try {
        await requestJSON(`/api/funds/${fundId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        $("#editDialog").close();
        loadData();
    } catch(err) {
        alert(err.message);
    }
}

// Trade
async function openTradeDialog(fundId, code) {
    const fund = allFunds.find(f => f.id === fundId);
    if (!fund) return;

    const form = $("#tradeForm");
    form.reset();
    form.fund_id.value = fund.id;
    $("#tradeCode").value = code;
    $("#tradeDialogTitle").textContent = `交易录入 - ${fund.name}`;
    
    const today = new Date().toISOString().split("T")[0];
    $("#tradeDate").value = today;
    
    $("#tradeDialog").showModal();
    loadTrades(fundId);
}

async function loadTrades(fundId) {
    const tbody = $("#tradeTableBody");
    tbody.innerHTML = `<tr><td colspan="7" class="empty">加载中...</td></tr>`;
    try {
        const res = await requestJSON(`/api/funds/${fundId}/trades`);
        if (res.trades.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" class="empty">暂无交易记录</td></tr>`;
            return;
        }
        tbody.innerHTML = res.trades.map(t => `
            <tr>
                <td>${t.trade_date}</td>
                <td><span class="${t.side === 'buy' ? 'color-down' : 'color-up'}">${t.side === 'buy' ? '买入' : '卖出'}</span></td>
                <td>${formatNumber(t.shares, 2)}</td>
                <td>${formatNumber(t.price)}</td>
                <td>${formatNumber(t.amount, 2)}</td>
                <td class="ellips" style="max-width:100px;" title="${t.note}">${t.note}</td>
                <td><a href="javascript:void(0)" onclick="deleteTrade(${fundId}, ${t.id})" class="color-down" style="font-size:0.8rem">撤销</a></td>
            </tr>
        `).join("");
    } catch(err) {
        tbody.innerHTML = `<tr><td colspan="7" class="empty">${err.message}</td></tr>`;
    }
}

async function deleteTrade(fundId, tradeId) {
    if(!confirm("确定要撤销这笔交易吗？资金和上次成交价也会相应回退！")) return;
    try {
        await requestJSON(`/api/funds/${fundId}/trades/${tradeId}`, { method: "DELETE" });
        await loadData();
        await loadTrades(fundId);
    } catch(err) {
        alert(err.message);
    }
}

async function handleTrade(e) {
    e.preventDefault();
    const form = e.target;
    const fundId = form.fund_id.value;
    const payload = Object.fromEntries(new FormData(form).entries());

    payload.price = parseFloat(payload.price || 0);
    if (payload.amount) payload.amount = parseFloat(payload.amount);
    if (payload.shares) payload.shares = parseFloat(payload.shares);

    try {
        await requestJSON(`/api/funds/${fundId}/trades`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        form.reset();
        await loadData();
        await loadTrades(fundId);
    } catch(err) {
        alert(err.message);
    }
}
