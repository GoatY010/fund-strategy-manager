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

function escapeHtml(text) {
    return String(text)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
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
let allGroupNames = [];
let currentGroup = "全部";
let nameActionDialogEl = null;
let nameActionTitleEl = null;
let nameActionBodyEl = null;
let nameActionState = {
    fundId: null,
    fundName: "",
    mode: "main",
};

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

// 列宽度管理
let columnWidths = localStorage.getItem("columnWidths");
columnWidths = columnWidths ? JSON.parse(columnWidths) : {};
let resizingField = null;
let resizeStartX = 0;


// == Initialization ==
document.addEventListener("DOMContentLoaded", () => {
    // Fill current date
    const today = new Date().toISOString().split("T")[0];
    if ($("#tradeDate")) {
        $("#tradeDate").value = today;
    }

    // Events
    $("#refreshBtn").addEventListener("click", () => loadData(true));
    $("#addFundForm").addEventListener("submit", handleAddFund);
    $("#editFundForm").addEventListener("submit", handleEditFund);
    $("#tradeForm").addEventListener("submit", handleTrade);

    // Auto fetch prices
    $("#addCode").addEventListener("input", autoFetchAddName);

    if ($("#tradeDate")) $("#tradeDate").addEventListener("blur", autoFetchTradePrice);
    if ($("#fetchTradePriceBtn")) $("#fetchTradePriceBtn").addEventListener("click", autoFetchTradePrice);

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

        // 异步结算待处理交易（不阻塞UI），如有结算完成则立即刷新一次列表
        let settledAny = false;
        for (const fund of data.funds) {
            try {
                const settleResult = await requestJSON(`/api/funds/${fund.id}/settle_pending_trades`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" }
                });
                if ((settleResult.settled_count || 0) > 0) {
                    settledAny = true;
                }
            } catch (e) {
                // 忽略结算失败
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

function getGroupSummary(groupName) {
    const list = groupName === "全部" ? allFunds : allFunds.filter(f => splitGroups(f.group_name).includes(groupName));
    let totalMarketValue = 0;
    let totalPnL = 0;
    let alertCount = 0;
    
    list.forEach(fund => {
        totalMarketValue += fund.market_value || 0;
        totalPnL += fund.cumulative_pnl || 0;
        if (fund.signal === "buy" || fund.signal === "sell") {
            alertCount += 1;
        }
    });
    
    return {
        count: list.length,
        alerts: alertCount,
        total_market_value: totalMarketValue,
        total_pnl: totalPnL
    };
}

function renderTable() {
    const tbody = $("#fundTableBody");
    tbody.innerHTML = "";

    const list = allFunds.filter(f => currentGroup === "全部" || splitGroups(f.group_name).includes(currentGroup));

    // 在表格前显示分组总览
    const summary = getGroupSummary(currentGroup);
    const groupHeaderEl = $("#groupSummary");
    if (groupHeaderEl) {
        groupHeaderEl.innerHTML = `
            <div class="group-summary-row">
                <span>基金数: <strong>${summary.count}</strong></span>
                <span>预警数: <strong>${summary.alerts}</strong></span>
                <span>总市值: <strong>${formatMoney(summary.total_market_value)}</strong></span>
                <span style="${summary.total_pnl >= 0 ? 'color:var(--success,green)' : 'color:var(--danger,red)'};font-weight:bold;margin-left:auto;">总盈亏: ${formatMoney(summary.total_pnl)}</span>
            </div>
        `;
    }

    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="13" class="empty">该分组暂无基金。</td></tr>`;
        return;
    }

    list.forEach(fund => {
        const tr = document.createElement("tr");
        if (fund.signal === "buy") tr.classList.add("signal-buy");
        if (fund.signal === "sell") tr.classList.add("signal-sell");

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
            const pendingCount = Number(fund.pending_count || 0);
            let subtitle = "";
            
            if (pendingCount > 0) {
                const parts = [];
                const displayMode = fund.pending_display_mode || "pending";

                if (displayMode === "pending") {
                    if (fund.pending_buy_shares > 0) {
                        parts.push(`待买入${formatMoney(fund.pending_buy_amount)}`);
                    }
                    if (fund.pending_sell_shares > 0) {
                        parts.push(`待卖出${formatNumber(fund.pending_sell_shares, 2)}份`);
                    }
                } else {
                    if (fund.pending_buy_shares > 0) {
                        const settlePrice = fund.pending_price || fund.current_price || 0;
                        const buyAmount = settlePrice > 0 ? fund.pending_buy_shares * settlePrice : fund.pending_buy_amount;
                        parts.push(`一笔买入中，合计${formatMoney(buyAmount)}`);
                    }
                    if (fund.pending_sell_shares > 0) {
                        parts.push(`一笔赎回中，合计${formatNumber(fund.pending_sell_shares, 2)}份`);
                    }
                }

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
            const dcpClass = dcp > 0 ? "color-up" : (dcp < 0 ? "color-down" : "");
            return `<span class="${dcpClass}">${dcp > 0 ? '+' : ''}${dcpText}</span>`;
        case "buy_line": return formatNumber(fund.buy_line);
        case "sell_line": return formatNumber(fund.sell_line);
        case "signal": 
            if (fund.signal === "buy") return '<span class="signal-badge buy">准备买入</span>';
            if (fund.signal === "sell") return '<span class="signal-badge sell">准备卖出</span>';
            if (fund.signal === "hold") return '<span class="signal-badge hold">持仓观望</span>';
            return '<span class="signal-badge no-data">无数据</span>';
        case "holding_shares": return formatNumber(fund.holding_shares, 2);
        case "market_value": return formatMoney(fund.market_value);
        case "cumulative_pnl": 
            const pnl = fund.cumulative_pnl;
            const pnlClass = pnl > 0 ? "color-up" : (pnl < 0 ? "color-down" : "");
            return `<span class="${pnlClass}">${pnl > 0 ? '+' : ''}${formatMoney(pnl)}</span>`;
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
        
        const status = date === today ? 
            '<span style="color: var(--warning, #ff9800);">待处理</span>' : 
            '<span class="color-up">正常</span>';
        
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

async function deleteFund(fundId, fundName) {
    if (!confirm(`确定删除基金“${fundName}”吗？此操作会同时删除该基金的所有交易记录。`)) {
        return;
    }
    try {
        await requestJSON(`/api/funds/${fundId}`, { method: "DELETE" });
        loadData(true);
    } catch (err) {
        alert(err.message);
    }
}

function handleFundTableClick(event) {
    const nameButton = event.target.closest(".name-action");
    if (!nameButton) return;
    event.preventDefault();
    event.stopPropagation();

    const fundId = Number(nameButton.dataset.fundId);
    const fundName = nameButton.dataset.fundName || "";
    openNameActionDialog(fundId, fundName);
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
                await deleteFund(nameActionState.fundId, nameActionState.fundName);
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

function openNameActionDialog(fundId, fundName) {
    // Lazy initialize if needed
    if (!nameActionDialogEl) {
        initNameActionDialog();
    }
    
    nameActionState.fundId = fundId;
    nameActionState.fundName = fundName;
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
    
    $("#tradeDialog").showModal();
    loadTrades(fundId);
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
            // 仅当日未结算的交易显示待处理
            const statusBadge = (t.trade_date === today && !t.is_settled) ? 
                `<span style="font-size:0.75rem; background:var(--warning, #ff9800); color:white; padding:0.1rem 0.3rem; border-radius:3px;">待处理</span>` : '';
            return `
            <tr style="${(t.trade_date === today && !t.is_settled) ? 'opacity:0.7;' : ''}" data-field="note" data-trade-id="${t.id}">
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
    const table = $("#tradeTableBody");
    if (!table) return;

    const theadTr = table.parentElement.parentElement.querySelector("thead tr");
    if (!theadTr) return;
    
    const ths = theadTr.querySelectorAll("th");
    ths.forEach((th, idx) => {
        if (idx < ths.length - 1) {  // 最后一列不添加resize handle
            const handle = th.querySelector(".resize-handle");
            if (!handle) {
                const resizeHandle = document.createElement("div");
                resizeHandle.className = "resize-handle";
                resizeHandle.style.cssText = "position:absolute; right:0; top:0; bottom:0; width:6px; cursor:col-resize; user-select:none;";
                th.style.position = "relative";
                th.appendChild(resizeHandle);
                
                resizeHandle.addEventListener("mousedown", (e) => {
                    e.preventDefault();
                    const startX = e.clientX;
                    const startWidth = th.offsetWidth;
                    
                    const handleMouseMove = (e) => {
                        const diff = e.clientX - startX;
                        const newWidth = Math.max(40, startWidth + diff);
                        th.style.width = newWidth + "px";
                    };
                    
                    const handleMouseUp = () => {
                        document.removeEventListener("mousemove", handleMouseMove);
                        document.removeEventListener("mouseup", handleMouseUp);
                    };
                    
                    document.addEventListener("mousemove", handleMouseMove);
                    document.addEventListener("mouseup", handleMouseUp);
                });
            }
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
