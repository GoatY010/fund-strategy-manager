// == Utils ==
function $(selector) {
    return document.querySelector(selector);
}

function $$(selector) {
    return document.querySelectorAll(selector);
}

function getColorClass(value) {
    /**
     * 根据数值返回颜色类名。
     * 正数: "color-up", 负数: "color-down", 零或其他: ""
     */
    return value > 0 ? "color-up" : (value < 0 ? "color-down" : "");
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

function escapeHtml(text) {
    return String(text)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function buildTradeSubtitleParts(fund) {
    // 这里只拼名称下方的展示文案，不参与结算状态判断。
    const parts = [];

    const yesterdayCount = Number(fund.subtitle_yesterday_trade_count || 0);
    if (yesterdayCount > 0) {
        const buyAmount = Number(fund.subtitle_yesterday_buy_amount || 0);
        const sellShares = Number(fund.subtitle_yesterday_sell_shares || 0);

        if (buyAmount > 0) {
            parts.push(`一笔买入中，合计${formatMoney(buyAmount)}`);
        }
        if (sellShares > 0) {
            parts.push(`一笔卖出中，合计${formatNumber(sellShares)}份`);
        }
    }

    const todayCount = Number(fund.subtitle_today_trade_count || 0);
    if (todayCount > 0) {
        const buyAmount = Number(fund.subtitle_today_buy_amount || 0);
        const sellShares = Number(fund.subtitle_today_sell_shares || 0);

        if (buyAmount > 0) {
            parts.push(`待买入，合计${formatMoney(buyAmount)}`);
        }
        if (sellShares > 0) {
            parts.push(`待卖出，合计${formatNumber(sellShares)}份`);
        }
    }

    return parts;
}

function splitGroups(groupValue) {
    return String(groupValue || "")
        .split(/\s*\|\s*/)
        .map(group => group.trim())
        .filter(Boolean);
}

function joinGroups(groups) {
    const seen = new Set();
    const merged = [];
    groups.forEach(group => {
        const trimmed = String(group || "").trim();
        if (trimmed && !seen.has(trimmed)) {
            seen.add(trimmed);
            merged.push(trimmed);
        }
    });
    return merged.length > 0 ? merged.join(" | ") : "默认分组";
}

function getUniqueGroupsFromFunds() {
    const groups = new Set();
    allFunds.forEach(fund => {
        splitGroups(fund.group_name).forEach(group => groups.add(group));
    });
    return [...groups];
}

async function requestJSON(url, options = {}) {
    options.headers = options.headers || {};
    if (!options.headers["Content-Type"] && !options.body) {
        options.headers["Accept"] = "application/json";
    }
    
    // 添加超时控制（10秒）
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    try {
        const resp = await fetch(url, { cache: "no-store", ...options, signal: controller.signal });
        if (!resp.ok) {
            let msg = "请求失败";
            try {
                const err = await resp.json();
                if (err.error) msg = err.error;
            } catch (e) {}
            throw new Error(msg);
        }
        return resp.json();
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error('请求超时，请检查网络');
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

// == State ==
let allFunds = [];
let allGroupNames = [];
let currentGroup = "全部";
let currentTradeDialogFundId = null;  // 当前交易对话框的基金ID（用于自动更新价格）
let nameActionDialogEl = null;
let nameActionTitleEl = null;
let nameActionBodyEl = null;
let nameActionState = {
    fundId: null,
    fundName: "",
    fundGroups: "",
    mode: "main",
};

// Columns Definition
const COLS = [
    { field: "code", label: "代码" },
    { field: "name", label: "名称" },
    { field: "mode", label: "状态" },
    { field: "last_trade_price", label: "上次成交" },
    { field: "current_price", label: "当前估值" },
    { field: "buy_line", label: "买入线" },
    { field: "sell_line", label: "卖出线" },
    { field: "signal", label: "信号" },
    { field: "holding_shares", label: "持仓份额" },
    { field: "yesterday_change_pct", label: "昨日涨跌" },
    { field: "daily_change_pct", label: "今日涨跌" },
    { field: "daily_pnl", label: "当日盈利" },
    { field: "market_value", label: "市值" },
    { field: "cumulative_pnl", label: "持有收益" },
    { field: "actions", label: "操作" }
];

// 通用localStorage加载函数
function loadStorage(key, defaultValue) {
    try {
        const item = localStorage.getItem(key);
        return item ? JSON.parse(item) : defaultValue;
    } catch (e) {
        return defaultValue;
    }
}

let columnOrder = loadStorage("columnOrder", null);
if (!columnOrder || !Array.isArray(columnOrder)) {
    columnOrder = COLS.map(c => c.field);
} else {
    // verify existing columns are valid
    const currentFields = COLS.map(c => c.field);
    if (columnOrder.length !== currentFields.length || columnOrder.some(f => !currentFields.includes(f))) {
        columnOrder = currentFields;
    }
}

// 列宽度管理
let columnWidths = loadStorage("columnWidths", {});
let resizingField = null;
let resizeStartX = 0;

// 行排序管理
let fundRowOrder = loadStorage("fundRowOrder", []);
let draggedFundId = null;


// == Initialization ==
document.addEventListener("DOMContentLoaded", () => {
    // Fill current date
    const today = new Date().toISOString().split("T")[0];
    if ($("#tradeDate")) {
        $("#tradeDate").value = today;
    }

    // Events
    const refreshBtn = $("#refreshBtn");
    if (refreshBtn) {
        refreshBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            const btn = $("#refreshBtn");
            const originalText = btn.textContent;
            btn.disabled = true;
            btn.textContent = "刷新中...";
            try {
                await loadData(true);
            } catch (err) {
                alert("刷新失败: " + err.message);
            } finally {
                btn.disabled = false;
                btn.textContent = originalText;
            }
        });
    }
    $("#addFundForm").addEventListener("submit", handleAddFund);
    $("#editFundForm").addEventListener("submit", handleEditFund);
    $("#tradeForm").addEventListener("submit", handleTrade);

    // Auto fetch prices
    $("#addCode").addEventListener("input", autoFetchAddName);

    if ($("#tradeDate")) {
        $("#tradeDate").addEventListener("change", autoFetchTradePrice);
    }
    if ($("#fetchTradePriceBtn")) $("#fetchTradePriceBtn").addEventListener("click", autoFetchTradePrice);

    // 监听交易对话框关闭事件，清除当前打开的对话框基金ID
    const tradeDialog = $("#tradeDialog");
    if (tradeDialog) {
        tradeDialog.addEventListener("close", () => {
            currentTradeDialogFundId = null;
        });
    }

    // Batch Add & Manage Groups
    if ($("#openBatchAddBtn")) {
        $("#openBatchAddBtn").addEventListener("click", () => {
            $("#batchAddFundForm").reset();
            $("#batchAddFundDialog").showModal();
        });
    }
    if ($("#batchAddFundForm")) {
        $("#batchAddFundForm").addEventListener("submit", handleBatchAdd);
    }
    if ($("#manageGroupsBtn")) {
        $("#manageGroupsBtn").addEventListener("click", openManageGroups);
    }
    if ($("#manageGroupsDialog")) {
        // Close dialog when close button is clicked
        const closeBtn = $("#manageGroupsDialog").querySelector('button[data-close-dialog]');
        if (closeBtn) {
            closeBtn.addEventListener("click", () => {
                $("#manageGroupsDialog").close();
            });
        }
        // Close by clicking on dialog backdrop
        $("#manageGroupsDialog").addEventListener("click", (e) => {
            if (e.target.id === "manageGroupsDialog") {
                $("#manageGroupsDialog").close();
            }
        });
    }
    if ($("#addGroupForm")) {
        $("#addGroupForm").addEventListener("submit", handleAddGroup);
    }
    if ($("#batchTradeDialog")) {
        // Close dialog when close button is clicked
        const closeBtn = $("#batchTradeDialog").querySelector('button[data-close-dialog]');
        if (closeBtn) {
            closeBtn.addEventListener("click", () => {
                $("#batchTradeDialog").close();
            });
        }
    }
    if ($("#openBatchTradeBtn")) {
        $("#openBatchTradeBtn").addEventListener("click", () => {
            const fundId = $("#tradeForm").fund_id.value;
            const fund = allFunds.find(f => f.id == fundId);
            if(fund) {
                // 清空表格回到初始状态
                initBatchTradeTable();
                $("#batchTradeDialog").showModal();
            }
        });
    }
    if ($("#fundTableBody")) {
        $("#fundTableBody").addEventListener("click", handleFundTableClick);
    }
    initNameActionDialog();

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
        
        // 应用保存的列宽
        const width = columnWidths[field];
        if (width) th.style.width = width + "px";
        
        if (field !== "actions") {
            th.draggable = true;
            th.addEventListener("dragstart", handleDragStart);
            th.addEventListener("dragover", handleDragOver);
            th.addEventListener("drop", handleDrop);
            
            // 添加列宽调整的拖拽柄
            const resizeHandle = document.createElement("div");
            resizeHandle.className = "resize-handle";
            resizeHandle.addEventListener("mousedown", (e) => handleColumnResize(e, field));
            th.appendChild(resizeHandle);
        }
        tr.appendChild(th);
    });
    applyColumnWidths();
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

function handleColumnResize(e, field) {
    e.preventDefault();
    resizingField = field;
    resizeStartX = e.clientX;
    
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
}

function handleMouseMove(e) {
    if (!resizingField) return;
    
    const deltaX = e.clientX - resizeStartX;
    const table = $("#sortableTable");
    if (!table) return;
    
    const currentWidth = columnWidths[resizingField] || 100; // 默认100px
    const newWidth = Math.max(50, currentWidth + deltaX); // 最小50px
    columnWidths[resizingField] = newWidth;
    
    // 应用列宽
    applyColumnWidths();
    
    resizeStartX = e.clientX;
}

function handleMouseUp() {
    if (resizingField) {
        localStorage.setItem("columnWidths", JSON.stringify(columnWidths));
        resizingField = null;
    }
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
}

// 行拖动处理
function handleFundRowDragStart(e) {
    draggedFundId = Number(e.target.closest("tr").dataset.fundId);
    e.dataTransfer.effectAllowed = "move";
    e.target.closest("tr").style.opacity = "0.5";
}

function handleFundRowDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
}

function handleFundRowDrop(e) {
    e.preventDefault();
    if (!draggedFundId) return;
    
    const targetTr = e.target.closest("tr");
    if (!targetTr) return;
    
    const targetFundId = Number(targetTr.dataset.fundId);
    if (draggedFundId === targetFundId) return;
    
    // 更新顺序
    const tbody = $("#fundTableBody");
    const rows = Array.from(tbody.querySelectorAll("tr[data-fund-id]"));
    
    const draggedIdx = rows.findIndex(r => Number(r.dataset.fundId) === draggedFundId);
    const targetIdx = rows.findIndex(r => Number(r.dataset.fundId) === targetFundId);
    
    if (draggedIdx !== -1 && targetIdx !== -1) {
        if (draggedIdx < targetIdx) {
            // 从上往下拖，插入到目标下方
            rows[targetIdx].parentNode.insertBefore(rows[draggedIdx], rows[targetIdx].nextSibling);
        } else {
            // 从下往上拖，插入到目标上方
            rows[targetIdx].parentNode.insertBefore(rows[draggedIdx], rows[targetIdx]);
        }
        
        // 保存新的顺序
        const newOrder = Array.from(tbody.querySelectorAll("tr[data-fund-id]")).map(r => Number(r.dataset.fundId));
        fundRowOrder = newOrder;
        localStorage.setItem("fundRowOrder", JSON.stringify(fundRowOrder));
    }
}

function handleFundRowDragEnd(e) {
    e.target.closest("tr").style.opacity = "1";
    draggedFundId = null;
}

function applyColumnWidths() {
    const table = $("#sortableTable");
    if (!table) return;
    
    const style = document.createElement("style");
    let css = "";
    
    columnOrder.forEach(field => {
        const width = columnWidths[field];
        if (width) {
            css += `#sortableTable th[data-field="${field}"], #sortableTable td[data-field="${field}"] { width: ${width}px; }\n`;
        }
    });
    
    // 移除旧的列宽样式
    const oldStyle = document.getElementById("columnWidthsStyle");
    if (oldStyle) oldStyle.remove();
    
    if (css) {
        style.id = "columnWidthsStyle";
        style.textContent = css;
        document.head.appendChild(style);
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

async function autoFetchAddName() {
    const code = $("#addCode").value;
    if (code && code.length === 6) {
        $("#addName").value = "查询中...";
        try {
            const res = await requestJSON(`/api/quote?code=${code}`);
            if (res.name) {
                $("#addName").value = res.name;
            } else {
                $("#addName").value = "未找到";
            }
        } catch(e) {
            $("#addName").value = "查询失败";
        }
    } else {
         $("#addName").value = "";
    }
}

async function autoFetchTradePrice() {
    const code = $("#tradeCode") ? $("#tradeCode").value : "";
    const dateStr = $("#tradeDate") ? $("#tradeDate").value : "";
    const today = new Date().toISOString().split("T")[0];
    
    // 如果是当日交易，使用当前估值
    if (dateStr === today && $("#tradeForm").fund_id.value) {
        const fundId = $("#tradeForm").fund_id.value;
        const fund = allFunds.find(f => f.id == fundId);
        if (fund && fund.current_price) {
            $("#tradePrice").value = fund.current_price;
            return;
        }
    }
    
    // 否则获取历史价格
    const price = await fetchHistory(code, dateStr);
    if(price) $("#tradePrice").value = price;
}

async function updateGroupTabs() {
    try {
        const res = await requestJSON("/api/groups");
        const groups = res.groups.length > 0 ? res.groups : getUniqueGroupsFromFunds();
        allGroupNames = groups;
        
        // update datalist
        const dl = $("#groupList");
        const dle = $("#groupListEdit");
        if (dl) dl.innerHTML = "";
        if (dle) dle.innerHTML = "";
        groups.forEach(g => {
            if (dl) dl.innerHTML += `<option value="${escapeHtml(g)}">`;
            if (dle) dle.innerHTML += `<option value="${escapeHtml(g)}">`;
        });

        const wrap = $("#groupTabs");
        if (wrap) {
            let html = `<button class="tab-btn ${currentGroup === '全部' ? 'active' : ''}" data-group="全部">全部</button>`;
            groups.forEach(g => {
                html += `<button class="tab-btn ${currentGroup === g ? 'active' : ''}" data-group="${escapeHtml(g)}">${escapeHtml(g)}</button>`;
            });
            wrap.innerHTML = html;

            $$(".tab-btn", wrap).forEach(btn => {
                btn.addEventListener("click", (e) => {
                    currentGroup = e.target.dataset.group;
                    // re-highlight
                    $$(".tab-btn", wrap).forEach(b => b.classList.remove('active'));
                    e.target.classList.add('active');
                    renderTable();
                });
            });
        }
    } catch(e) {
        console.error("Failed to load groups:", e);
    }
}

// == Data Loading ==
async function loadData(force = false) {
    try {
        let data = await requestJSON(`/api/funds?force=${force ? 1 : 0}`);

        // 仅在 15:00 之后尝试结算已进入待结算窗口的交易，避免每次刷新都逐基金发请求
        const now = new Date();
        const settlementCutoff = new Date(now);
        settlementCutoff.setHours(15, 0, 0, 0);

        let settledAny = false;
        if (now >= settlementCutoff) {
            const settlementTargets = data.funds.filter(fund => Number(fund.settlement_review_trade_count || 0) > 0);
            if (settlementTargets.length > 0) {
                const settleResults = await Promise.all(
                    settlementTargets.map(fund =>
                        requestJSON(`/api/funds/${fund.id}/review_settlement_trades`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" }
                        }).catch(() => null)
                    )
                );
                settledAny = settleResults.some(result => (result && (result.settled_count || 0) > 0));
            }
        }

        if (settledAny) {
            data = await requestJSON(`/api/funds?force=${force ? 1 : 0}`);
        }

        $("#lastUpdated").textContent = "上次刷新: " + formatDate(data.generated_at);
        allFunds = data.funds;
        updateSummary(data.summary);
        updateGroupTabs();
        renderTable();
        
        // 如果交易对话框打开，更新其中的价格
        updateTradePriceIfDialogOpen();
    } catch (err) {
        alert(err.message);
    }
}

function updateSummary(summary) {
    $("#summaryCount").textContent = summary.count;
    $("#summaryAlerts").textContent = summary.alerts;
    $("#summaryMarketValue").textContent = formatMoney(summary.total_market_value);
    
    // 当日盈利
    const dpnlEl = $("#summaryDailyPnL");
    if (dpnlEl && summary.total_daily_pnl !== undefined) {
        const dpnlClass = summary.total_daily_pnl > 0 ? "color-up" : (summary.total_daily_pnl < 0 ? "color-down" : "");
        dpnlEl.textContent = formatMoney(summary.total_daily_pnl);
        dpnlEl.className = dpnlClass;
    }
    
    // 当日收益率（当日盈利 / 总市值）
    const dReturnEl = document.querySelector("#summaryDailyReturn");
    if (dReturnEl && summary.total_daily_pnl !== undefined && summary.total_market_value > 0) {
        const dailyReturnRate = (summary.total_daily_pnl / summary.total_market_value) * 100;
        const drClass = dailyReturnRate > 0 ? "color-up" : (dailyReturnRate < 0 ? "color-down" : "");
        dReturnEl.textContent = formatPercent(dailyReturnRate);
        dReturnEl.className = drClass;
    }
    
    // 累计盈亏
    const pnlEl = $("#summaryPnL");
    pnlEl.textContent = formatMoney(summary.total_cumulative_pnl);
    pnlEl.className = summary.total_cumulative_pnl > 0 ? "color-up" : (summary.total_cumulative_pnl < 0 ? "color-down" : "");
}

function getGroupSummary(groupName) {
    const list = groupName === "全部" ? allFunds : allFunds.filter(f => splitGroups(f.group_name).includes(groupName));
    let totalMarketValue = 0;
    let totalPnL = 0;
    let totalDailyPnL = 0;
    let alertCount = 0;
    
    list.forEach(fund => {
        totalMarketValue += fund.market_value || 0;
        totalPnL += fund.cumulative_pnl || 0;
        totalDailyPnL += fund.daily_pnl || 0;
        if (fund.signal === "buy" || fund.signal === "sell") {
            alertCount += 1;
        }
    });
    
    // 计算当日收益率 = 当日盈利 / 总市值
    const daily_return_rate = totalMarketValue > 0 ? (totalDailyPnL / totalMarketValue) * 100 : 0;
    
    return {
        count: list.length,
        alerts: alertCount,
        total_market_value: totalMarketValue,
        total_daily_pnl: totalDailyPnL,
        total_daily_return_rate: daily_return_rate,
        total_pnl: totalPnL
    };
}

function renderTable() {
    const tbody = $("#fundTableBody");
    tbody.innerHTML = "";

    let list = allFunds.filter(f => currentGroup === "全部" || splitGroups(f.group_name).includes(currentGroup));
    
    // 按照保存的行顺序排序
    if (fundRowOrder.length > 0) {
        list.sort((a, b) => {
            const indexA = fundRowOrder.indexOf(a.id);
            const indexB = fundRowOrder.indexOf(b.id);
            const posA = indexA === -1 ? list.length : indexA;
            const posB = indexB === -1 ? list.length : indexB;
            return posA - posB;
        });
    }

    // 在表格前显示分组总览
    const summary = getGroupSummary(currentGroup);
    const groupHeaderEl = $("#groupSummary");
    if (groupHeaderEl) {
        const dailyPnLClass = summary.total_daily_pnl >= 0 ? 'color-up' : 'color-down';
        const totalPnLClass = summary.total_pnl >= 0 ? 'color-up' : 'color-down';
        groupHeaderEl.innerHTML = `
            <div class="group-summary-row" style="display:flex; align-items:center; gap:2rem; width:100%;">
                <span>当日盈利: <strong class="${dailyPnLClass}">${formatMoney(summary.total_daily_pnl)}</strong></span>
                <span>当日收益率: <strong class="${dailyPnLClass}">${formatPercent(summary.total_daily_return_rate)}</strong></span>
                <span style="margin-left:auto;">总盈亏: <strong class="${totalPnLClass}">${formatMoney(summary.total_pnl)}</strong></span>
            </div>
        `;
    }

    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="15" class="empty">该分组暂无基金。</td></tr>`;
        return;
    }

    list.forEach(fund => {
        const tr = document.createElement("tr");
        tr.draggable = true;
        tr.dataset.fundId = fund.id;
        
        if (fund.signal === "buy") tr.classList.add("signal-buy");
        if (fund.signal === "sell") tr.classList.add("signal-sell");
        
        // 添加拖动事件处理
        tr.addEventListener("dragstart", handleFundRowDragStart);
        tr.addEventListener("dragover", handleFundRowDragOver);
        tr.addEventListener("drop", handleFundRowDrop);
        tr.addEventListener("dragend", handleFundRowDragEnd);

        columnOrder.forEach(field => {
            const td = document.createElement("td");
            td.dataset.field = field;
            
            // 应用保存的列宽
            const width = columnWidths[field];
            if (width) td.style.width = width + "px";
            
            td.innerHTML = getCellHtml(fund, field);
            tr.appendChild(td);
        });

        tbody.appendChild(tr);
    });
    applyColumnWidths();
}

function getCellHtml(fund, field) {
    switch(field) {
        case "code": return fund.code;
        case "name": {
            const subtitleTradeCount = Number(fund.subtitle_trade_count || 0);
            let subtitle = "";
            
            if (subtitleTradeCount > 0) {
                const parts = buildTradeSubtitleParts(fund);
                subtitle = `<div class="pending-badge">${parts.join(" | ")}</div>`;
            }
            
            return `
                <button
                    type="button"
                    class="name-action"
                    data-fund-id="${fund.id}"
                    data-fund-name="${escapeHtml(fund.name)}"
                    title="点击管理：删除 / 移动分组"
                >
                    <div>${escapeHtml(fund.name)}</div>
                    ${subtitle}
                </button>
            `;
        }
        case "mode": return fund.mode === "holding" ? '<span class="badge">持有</span>' : '<span class="badge badge-outline">观察</span>';
        case "last_trade_price": return formatNumber(fund.last_trade_price);
        case "current_price": 
            const cp = formatNumber(fund.current_price);
            if (!fund.quote_available) return `<span class="muted" title="无实时行情">${cp}</span>`;
            return cp;
        case "daily_change_pct": 
            const dcp = fund.daily_change_pct;
            const dcpText = formatPercent(dcp);
            const dcpClass = getColorClass(dcp);
            return `<span class="${dcpClass}">${dcp > 0 ? '+' : ''}${dcpText}</span>`;
        case "daily_pnl": 
            const dpnl = fund.daily_pnl !== undefined ? fund.daily_pnl : null;
            if (dpnl === null || dpnl === undefined) {
                return `<span class="muted">--</span>`;
            }
            if (!fund.market_value || fund.market_value <= 0) {
                return `<span class="muted">--</span>`;  // 没有持仓时显示 --
            }
            const dpnlClass = getColorClass(dpnl);
            return `<span class="${dpnlClass}">${dpnl > 0 ? '+' : ''}${formatMoney(dpnl)}</span>`;
        case "yesterday_change_pct": 
            const ycp = fund.yesterday_change_pct;
            // 如果值为null或undefined，显示"--"；否则显示实际值（包括0）
            if (ycp === null || ycp === undefined) {
                return `<span class="muted">--</span>`;
            }
            const ycpText = formatPercent(ycp);
            const ycpClass = getColorClass(ycp);
            return `<span class="${ycpClass}">${ycp > 0 ? '+' : ''}${ycpText}</span>`;
        case "buy_line": return formatNumber(fund.buy_line);
        case "sell_line": return formatNumber(fund.sell_line);
        case "signal": 
            if (fund.signal === "buy") return '<span class="signal-badge buy">准备买入</span>';
            if (fund.signal === "sell") return '<span class="signal-badge sell">准备卖出</span>';
            if (fund.signal === "hold") return '<span class="signal-badge hold">持仓观望</span>';
            return '<span class="signal-badge no-data">无数据</span>';
        case "holding_shares": return formatNumber(fund.effective_holding_shares ?? fund.holding_shares, 2);
        case "market_value": return formatMoney(fund.market_value);
        case "cumulative_pnl": 
            const pnl = fund.cumulative_pnl;
            const costBasis = fund.buy_total || 0;
            const pnlClass = getColorClass(pnl);
            
            let returnRateHtml = "";
            if (costBasis > 0) {
                const returnRate = (pnl / costBasis) * 100;
                returnRateHtml = `<div style="font-size: 0.65em; font-weight: bold; margin-top: 2px; text-align: right;" class="${pnlClass}">${returnRate > 0 ? '+' : ''}${returnRate.toFixed(2)}%</div>`;
            }
            
            return `<div style="text-align: center;">
                <span class="${pnlClass}">${pnl > 0 ? '+' : ''}${formatMoney(pnl)}</span>
                ${returnRateHtml}
            </div>`;
        case "actions": 
            return `
                <div class="actions">
                    <button type="button" class="btn" onclick="openTradeDialog(${fund.id}, '${fund.code}')">交易</button>
                    <button type="button" class="btn" onclick="openEditDialog(${fund.id})">配置</button>
                </div>
            `;
    }
    return "";
}

// == Actions ==
async function handleAddFund(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = { code: fd.get("code") };
    
    try {
        await requestJSON("/api/funds", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        e.target.reset();
        if ($("#addName")) $("#addName").value = "";
        loadData(true);
    } catch (err) {
        alert(err.message);
    }
}

async function handleBatchAdd(e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = { codes: fd.get("codes") };
    
    try {
        const res = await requestJSON("/api/funds/batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        alert(res.message);
        $("#batchAddFundDialog").close();
        loadData(true);
    } catch (err) {
        alert(err.message);
    }
}

function initBatchTradeTable() {
    const table = $("#batchTradeTable");
    if (!table) return;
    
    // 更新表头 - 只有3列
    const thead = table.querySelector("thead");
    if (thead) {
        thead.innerHTML = `
            <tr>
                <th>日期</th>
                <th>方向</th>
                <th>金额(元) / 份额</th>
            </tr>
        `;
    }
    
    // 清空tbody，重置为一个空白行（3列，无操作列）
    const tbody = table.querySelector("tbody");
    if (tbody) {
        tbody.innerHTML = `
            <tr class="batch-trade-row" data-row-id="row-0">
                <td><input type="date" class="batch-date" required></td>
                <td>
                    <select class="batch-side" required>
                        <option value="">请选择</option>
                        <option value="buy">买入</option>
                        <option value="sell">卖出</option>
                    </select>
                </td>
                <td><input type="number" class="batch-value" placeholder="金额（买入）/份额（卖出）" step="0.01" required></td>
            </tr>
        `;
    }
    
    // 为所有input和select添加change/input监听，更新预览
    attachBatchTradeListeners();
}

function attachBatchTradeListeners() {
    const tbody = $("#batchTradeBody");
    if (!tbody) return;
    
    // Remove old listeners by cloning
    const inputs = tbody.querySelectorAll(".batch-date, .batch-side, .batch-value");
    inputs.forEach(input => {
        input.addEventListener("change", updateBatchPreview);
        input.addEventListener("input", updateBatchPreview);
    });
    
    // Also listen to select changes
    const selects = tbody.querySelectorAll(".batch-side");
    selects.forEach(select => {
        select.addEventListener("change", function() {
            const valueInput = this.closest("tr").querySelector(".batch-value");
            if (valueInput) {
                valueInput.placeholder = this.value === "buy" ? "金额（买入）" : "份额（卖出）";
            }
            updateBatchPreview();
        });
    });
}

function updateBatchPreview() {
    const tbody = $("#batchTradeBody");
    const previewBody = $("#batchTradePreviewBody");
    if (!tbody || !previewBody) return;
    
    const rows = tbody.querySelectorAll(".batch-trade-row");
    const trades = [];
    const today = new Date().toISOString().split("T")[0];
    
    for (let row of rows) {
        const dateInput = row.querySelector(".batch-date");
        const sideSelect = row.querySelector(".batch-side");
        const valueInput = row.querySelector(".batch-value");
        
        const date = dateInput.value?.trim();
        const side = sideSelect.value?.trim();
        const value = valueInput.value?.trim();
        
        // 只显示填写完整的行
        if (!date || !side || !value) continue;
        
        const numValue = parseFloat(value);
        if (isNaN(numValue) || numValue <= 0) continue;
        
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split("T")[0];

        const status = date >= yesterdayStr ? 
            '<span style="color: var(--warning, #ff9800);">待结算</span>' : 
            '<span class="color-up">已结算</span>';
        
        trades.push({
            date: date,
            side: side === "buy" ? "买入" : "卖出",
            value: formatNumber(numValue),
            status: status
        });
    }
    
    if (trades.length === 0) {
        previewBody.innerHTML = '<tr><td colspan="4" class="empty">填入数据后自动预览</td></tr>';
        return;
    }
    
    previewBody.innerHTML = trades.map(t => `
        <tr>
            <td>${t.date}</td>
            <td>${t.side}</td>
            <td>${t.value}</td>
            <td>${t.status}</td>
        </tr>
    `).join("");
}

function addBatchTradeRow() {
    const tbody = $("#batchTradeBody");
    if (!tbody) return;
    
    const rows = tbody.querySelectorAll(".batch-trade-row");
    const nextId = rows.length;
    
    // 添加新行（不含操作列）
    const newRow = document.createElement("tr");
    newRow.className = "batch-trade-row";
    newRow.dataset.rowId = `row-${nextId}`;
    newRow.innerHTML = `
        <td><input type="date" class="batch-date" required></td>
        <td>
            <select class="batch-side" required>
                <option value="">请选择</option>
                <option value="buy">买入</option>
                <option value="sell">卖出</option>
            </select>
        </td>
        <td><input type="number" class="batch-value" placeholder="金额（买入）/份额（卖出）" step="0.01" required></td>
    `;
    
    tbody.appendChild(newRow);
    
    // 为新行的inputs和selects添加change监听，更新placeholder和预览
    attachBatchTradeListeners();
}

async function submitBatchTrades() {
    const fundId = $("#tradeForm").fund_id.value;
    const fundCode = $("#tradeCode").value;
    const tbody = $("#batchTradeBody");
    const rows = tbody.querySelectorAll(".batch-trade-row");
    
    if (rows.length === 0) {
        alert("请至少添加一条交易记录");
        return;
    }
    
    const trades = [];
    for (let row of rows) {
        const dateInput = row.querySelector(".batch-date");
        const sideSelect = row.querySelector(".batch-side");
        const valueInput = row.querySelector(".batch-value");
        
        const date = dateInput.value?.trim();
        const side = sideSelect.value?.trim();
        const value = valueInput.value?.trim();
        
        if (!date || !side || !value) {
            alert("请填完整所有必填字段（日期、方向、金额/份额）");
            return;
        }
        
        // 验证日期
        try {
            const d = new Date(date);
            if (isNaN(d.getTime())) throw new Error("日期无效");
        } catch {
            alert(`日期格式错误: ${date}`);
            return;
        }
        
        const numValue = parseFloat(value);
        if (isNaN(numValue) || numValue <= 0) {
            alert(`无效的数值: ${value}`);
            return;
        }
        
        trades.push({
            trade_date: date,
            side: side,
            value: numValue  // 金额（买入）或份额（卖出）
        });
    }
    
    // 对于日期非今天的交易，查询历史价格
    const today = new Date().toISOString().split("T")[0];
    for (let i = 0; i < trades.length; i++) {
        const trade = trades[i];
        
        if (trade.trade_date !== today) {
            try {
                const historicalPrice = await fetchHistory(fundCode, trade.trade_date);
                if (!historicalPrice) {
                    alert(`无法获取 ${trade.trade_date} 的历史价格`);
                    return;
                }
                
                if (trade.side === "buy") {
                    // 金额 ÷ 价格 = 份额
                    trade.price = historicalPrice;
                    trade.shares = trade.value / historicalPrice;
                    delete trade.value;
                } else {
                    // 份额 × 价格 = 金额
                    trade.price = historicalPrice;
                    trade.amount = trade.value * historicalPrice;
                    trade.shares = trade.value;
                    delete trade.value;
                }
            } catch (err) {
                alert(`获取 ${trade.trade_date} 的价格失败: ${err.message}`);
                return;
            }
        }
    }
    
    try {
        const res = await requestJSON(`/api/funds/${fundId}/trades/batch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trades: trades })
        });
        alert(res.message || "批量导入成功");
        $("#batchTradeDialog").close();
        loadTrades(fundId);
        loadData(true);
    } catch (err) {
        alert(err.message);
    }
}

async function deleteFund(fundId, fundName, fundGroupsStr) {
    const fundGroups = splitGroups(fundGroupsStr);
    
    // 场景1: 仅在默认分组中
    if (fundGroups.length === 1 && fundGroups[0] === "默认分组") {
        if (!confirm(`确定删除基金"${fundName}"吗？此操作会同时删除该基金的所有交易记录。`)) {
            return;
        }
        try {
            await requestJSON(`/api/funds/${fundId}`, { method: "DELETE" });
            loadData(true);
        } catch (err) {
            alert(err.message);
        }
        return;
    }
    
    // 场景2: 在一个或多个自定义分组中 - 创建选择对话框
    const dialog = document.createElement("dialog");
    
    let optionsHTML = `<div style="padding:1rem;">该基金在以下分组中：<strong>${fundGroups.join(", ")}</strong><br>请选择操作：</div>`;
    optionsHTML += `<button type="button" class="btn btn-primary" data-action="delete-all">删除所有分组</button>`;
    optionsHTML += `<button type="button" class="btn btn-ghost" data-action="delete-group">删除当前分组</button>`;
    optionsHTML += `<button type="button" class="btn btn-ghost" data-action="cancel">取消</button>`;
    
    dialog.innerHTML = optionsHTML;
    
    return new Promise((resolve) => {
        dialog.addEventListener("click", async (e) => {
            const action = e.target.dataset.action;
            if (action === "delete-all") {
                try {
                    await requestJSON(`/api/funds/${fundId}`, { method: "DELETE" });
                    loadData(true);
                    dialog.close();
                    dialog.remove();
                    resolve();
                } catch (err) {
                    alert(err.message);
                }
            } else if (action === "delete-group") {
                const newGroups = fundGroups.filter(g => g !== currentGroup);
                const newGroupsStr = joinGroups(newGroups);
                try {
                    if (newGroupsStr) {
                        await requestJSON(`/api/funds/${fundId}`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ group_name: newGroupsStr })
                        });
                    } else {
                        await requestJSON(`/api/funds/${fundId}`, { method: "DELETE" });
                    }
                    loadData(true);
                    dialog.close();
                    dialog.remove();
                    resolve();
                } catch (err) {
                    alert(err.message);
                }
            } else {
                dialog.close();
                dialog.remove();
                resolve();
            }
        });
        document.body.appendChild(dialog);
        dialog.showModal();
    });
}

function handleFundTableClick(event) {
    const nameButton = event.target.closest(".name-action");
    if (!nameButton) return;
    event.preventDefault();
    event.stopPropagation();

    const fundId = Number(nameButton.dataset.fundId);
    const fundName = nameButton.dataset.fundName || "";
    
    // 从allFunds中获取基金的group_name
    const fund = allFunds.find(f => f.id === fundId);
    const fundGroups = fund ? fund.group_name : "默认分组";
    
    openNameActionDialog(fundId, fundName, fundGroups);
}

function initNameActionDialog() {
    nameActionDialogEl = $("#nameActionDialog");
    if (!nameActionDialogEl) return;
    nameActionTitleEl = nameActionDialogEl.querySelector("#nameActionTitle");
    nameActionBodyEl = nameActionDialogEl.querySelector("#nameActionBody");

    nameActionDialogEl.addEventListener("click", async (event) => {
        const closeButton = event.target.closest('[data-action="close"]');
        if (closeButton) {
            closeNameActionDialog();
            return;
        }

        const actionButton = event.target.closest("[data-action]");
        if (actionButton && nameActionDialogEl.contains(actionButton)) {
            const action = actionButton.dataset.action;
            if (action === "delete") {
                closeNameActionDialog();
                await deleteFund(nameActionState.fundId, nameActionState.fundName, nameActionState.fundGroups);
                return;
            }
            if (action === "move") {
                nameActionState.mode = "groups";
                renderNameActionDialog();
                return;
            }
            if (action === "back") {
                nameActionState.mode = "main";
                renderNameActionDialog();
                return;
            }
        }

        const groupButton = event.target.closest("[data-group]");
        if (groupButton && nameActionDialogEl.contains(groupButton)) {
            const group = groupButton.dataset.group;
            const mode = groupButton.dataset.mode || "move";
            if (!group) return;
            if (mode === "copy") {
                await copyFundToGroup(nameActionState.fundId, group);
            } else {
                await moveFundToGroup(nameActionState.fundId, group);
            }
            closeNameActionDialog();
        }
    });
}

function openNameActionDialog(fundId, fundName, fundGroups) {
    // Lazy initialize if needed
    if (!nameActionDialogEl) {
        initNameActionDialog();
    }
    
    nameActionState.fundId = fundId;
    nameActionState.fundName = fundName;
    nameActionState.fundGroups = fundGroups || "默认分组";
    nameActionState.mode = "main";
    renderNameActionDialog();
    if (nameActionDialogEl) {
        nameActionDialogEl.classList.remove("hidden");
        nameActionDialogEl.setAttribute("aria-hidden", "false");
    }
}

window.openNameActionDialog = openNameActionDialog;
window.closeNameActionDialog = closeNameActionDialog;

function closeNameActionDialog() {
    if (nameActionDialogEl) {
        nameActionDialogEl.classList.add("hidden");
        nameActionDialogEl.setAttribute("aria-hidden", "true");
    }
}

function renderNameActionDialog() {
    // Ensure dialog and body elements exist
    if (!nameActionDialogEl) {
        nameActionDialogEl = document.getElementById("nameActionDialog");
    }
    if (!nameActionDialogEl) {
        return;
    }
    
    // Find or create body element
    let bodyEl = nameActionDialogEl.querySelector("#nameActionBody");
    if (!bodyEl) {
        bodyEl = document.createElement("div");
        bodyEl.id = "nameActionBody";
        bodyEl.className = "name-action-body";
        nameActionDialogEl.appendChild(bodyEl);
    }
    nameActionBodyEl = bodyEl;
    
    // Ensure title element exists
    if (!nameActionTitleEl) {
        nameActionTitleEl = nameActionDialogEl.querySelector("#nameActionTitle");
    }

    if (nameActionState.mode === "groups") {
        const groups = allGroupNames.filter(group => group !== "全部");
        if (nameActionTitleEl) nameActionTitleEl.textContent = "选择分组和方式";
        
        // Show back button
        const backBtn = nameActionDialogEl.querySelector("#nameActionBackBtn");
        if (backBtn) backBtn.style.display = "block";
        
        bodyEl.innerHTML = `
            ${groups.map(group => `
                <div class="name-action-group-row">
                    <span class="name-action-group-name">${escapeHtml(group)}</span>
                    <div class="name-action-group-actions">
                        <button type="button" class="name-action-chip" data-group="${escapeHtml(group)}" data-mode="copy">复制</button>
                        <button type="button" class="name-action-chip primary" data-group="${escapeHtml(group)}" data-mode="move">移动</button>
                    </div>
                </div>
            `).join("")}
        `;
        return;
    }

    // Main (default) mode
    if (nameActionTitleEl) {
        nameActionTitleEl.textContent = nameActionState.fundName || "基金操作";
    }
    
    // Hide back button in default mode
    const backBtn = nameActionDialogEl.querySelector("#nameActionBackBtn");
    if (backBtn) backBtn.style.display = "none";
    
    // Set menu content
    bodyEl.innerHTML = `
        <div class="name-action-main-list">
            <button type="button" class="name-action-item danger" data-action="delete">删除基金</button>
            <button type="button" class="name-action-item" data-action="move">移动分组</button>
        </div>
    `;
}

async function moveFundToGroup(fundId, groupName) {
    try {
        await requestJSON(`/api/funds/${fundId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ group_name: groupName })
        });
        await loadData(true);
    } catch (err) {
        alert(err.message);
    }
}

async function copyFundToGroup(fundId, groupName) {
    const fund = allFunds.find(item => item.id === fundId);
    if (!fund) return;

    const nextGroups = joinGroups([...splitGroups(fund.group_name), groupName]);
    if (nextGroups === fund.group_name) {
        alert("该基金已经包含这个分组。");
        return;
    }

    try {
        await requestJSON(`/api/funds/${fundId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ group_name: nextGroups })
        });
        await loadData(true);
    } catch (err) {
        alert(err.message);
    }
}

async function openManageGroups() {
    try {
        const res = await requestJSON("/api/groups");
        const dialog = $("#manageGroupsDialog");
        if (!dialog) return;
        
        // 仅更新分组列表，保留 index.html 中定义的字号和间距
        const groupsHTML = res.groups.map(g => {
            if (g === "默认分组") return `<li class="group-item"><span>${escapeHtml(g)}</span> <span class="muted">系统默认</span></li>`;
            return `
                <li class="group-item">
                    <span>${escapeHtml(g)}</span>
                    <div>
                        <button type="button" class="btn " onclick='renameGroup(${JSON.stringify(g)})' style="padding:0.2rem 0.5rem;font-size:0.8rem;">重命名</button>
                        <button type="button" class="btn btn-ghost" onclick='deleteGroup(${JSON.stringify(g)})' style="padding:0.2rem 0.5rem;font-size:0.8rem;color:var(--danger);border-color:var(--danger)">删除</button>
                    </div>
                </li>
            `;
        }).join("");

        const listEl = dialog.querySelector("#groupsListUI");
        if (listEl) {
            listEl.innerHTML = groupsHTML;
        }
        
        dialog.showModal();
    } catch(e) {
        alert(e.message);
    }
}

async function handleAddGroup(e) {
    e.preventDefault();
    const name = $("#newGroupName").value.trim();
    if (!name) return;
    try {
        await requestJSON("/api/groups", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({name})
        });
        $("#newGroupName").value = "";
        openManageGroups();
        loadData();
    } catch(err) { alert(err.message); }
}

window.renameGroup = async function(oldName) {
    const newName = prompt(`将分组 "${oldName}" 重命名为:`);
    if (!newName || newName.trim() === oldName) return;
    try {
        await requestJSON(`/api/groups/${encodeURIComponent(oldName)}`, {
            method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({new_name: newName.trim()})
        });
        openManageGroups();
        loadData();
    } catch(err) { alert(err.message); }
};

window.deleteGroup = async function(name) {
    if (!confirm(`确定删除分组 "${name}" 吗？该组下的基金将归入默认分组。`)) return;
    try {
        await requestJSON(`/api/groups/${encodeURIComponent(name)}`, {
            method: "DELETE"
        });
        openManageGroups();
        loadData();
    } catch(err) { alert(err.message); }
};


// Edit
function openEditDialog(fundId) {
    const fund = allFunds.find(f => f.id === fundId);
    if (!fund) return;
    const form = $("#editFundForm");
    form.fund_id.value = fund.id;
    form.name.value = fund.name;
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
    
    // 自动填充当日交易的当前价格
    if (fund.current_price && fund.current_price > 0) {
        $("#tradePrice").value = fund.current_price;
    }
    
    // 记录当前对话框的基金ID，用于后续自动更新价格
    currentTradeDialogFundId = fundId;
    
    $("#tradeDialog").showModal();
    loadTrades(fundId);
}

// 如果交易对话框打开，自动更新其中的当前价格
function updateTradePriceIfDialogOpen() {
    if (!currentTradeDialogFundId || !$("#tradeDialog").open) {
        return;
    }
    
    const fund = allFunds.find(f => f.id == currentTradeDialogFundId);
    if (!fund) return;
    
    const today = new Date().toISOString().split("T")[0];
    const tradeDate = $("#tradeDate").value;
    
    // 只在当日交易且用户未手动修改过价格时更新
    if (tradeDate === today && fund.current_price && fund.current_price > 0) {
        // 检查价格字段是否为空或者是初始值
        const currentPrice = $("#tradePrice").value;
        const previousFund = allFunds.find(f => f.id == currentTradeDialogFundId);
        
        // 如果当前价格为空，或者等于之前的价格（说明还是初始值），就更新
        if (!currentPrice || parseFloat(currentPrice) === 0) {
            $("#tradePrice").value = fund.current_price;
        }
    }
}

async function loadTrades(fundId) {
    const tbody = $("#tradeTableBody");
    tbody.innerHTML = `<tr><td colspan="6" class="empty">加载中...</td></tr>`;
    try {
        const res = await requestJSON(`/api/funds/${fundId}/trades`);
        if (res.trades.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="empty">暂无交易记录</td></tr>`;
            return;
        }
        
        const today = new Date().toISOString().split("T")[0];
        tbody.innerHTML = res.trades.map((t, idx) => {
            // 仅未结算的交易显示待结算
            const isPending = !t.is_settled;
            const statusBadge = isPending ? 
                `<span style="font-size:0.75rem; background:var(--warning, #ff9800); color:white; padding:0.1rem 0.3rem; border-radius:3px;">待结算</span>` : '';
            return `
            <tr style="${isPending ? 'opacity:0.7;' : ''}" data-field="note" data-trade-id="${t.id}">
                <td>${t.trade_date}</td>
                <td><span class="${t.side === 'buy' ? 'color-down' : 'color-up'}">${t.side === 'buy' ? '买入' : '卖出'}</span></td>
                <td>${formatNumber(t.shares, 2)}</td>
                <td>${formatNumber(t.price)}</td>
                <td>${formatNumber(t.amount, 2)}</td>
                <td><a href="javascript:void(0)" onclick="deleteTrade(${fundId}, ${t.id})" class="color-down" style="font-size:0.8rem">撤销</a> ${statusBadge}</td>
            </tr>
        `}).join("");
        // 为交易表添加列宽调整功能
        attachTradeTableResizeHandles();
    } catch(err) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty">${err.message}</td></tr>`;
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

function attachTradeTableResizeHandles() {
    // Apply resize handles using the same mechanism as main table
    const ths = document.querySelectorAll("#tradeTable thead th");
    ths.forEach((th, idx) => {
        if (idx < ths.length - 1 && !th.querySelector(".resize-handle")) {
            const resizeHandle = document.createElement("div");
            resizeHandle.className = "resize-handle";
            resizeHandle.addEventListener("mousedown", (e) => handleColumnResize(e, th.dataset.field || ""));
            th.appendChild(resizeHandle);
        }
    });
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


