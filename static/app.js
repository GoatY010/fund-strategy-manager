const state = {
    funds: [],
    fundMap: new Map(),
    refreshTimerId: null,
};

const signalLabelMap = {
    buy: "买入预警",
    sell: "卖出预警",
    hold: "观望",
    "no-data": "无数据",
};

const signalClassMap = {
    buy: "buy",
    sell: "sell",
    hold: "hold",
    "no-data": "no-data",
};

const addFundForm = document.getElementById("addFundForm");
const refreshBtn = document.getElementById("refreshBtn");
const fundTableBody = document.getElementById("fundTableBody");
const lastUpdated = document.getElementById("lastUpdated");
const toast = document.getElementById("toast");

const editDialog = document.getElementById("editDialog");
const editFundForm = document.getElementById("editFundForm");

const tradeDialog = document.getElementById("tradeDialog");
const tradeDialogTitle = document.getElementById("tradeDialogTitle");
const tradeForm = document.getElementById("tradeForm");
const tradeTableBody = document.getElementById("tradeTableBody");

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function formatNumber(value, digits = 4) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
        return "--";
    }
    return Number(value).toFixed(digits);
}

function formatPercent(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
        return "--";
    }
    const num = Number(value);
    const sign = num > 0 ? "+" : "";
    return `${sign}${num.toFixed(2)}%`;
}

function formatMoney(value) {
    const amount = Number(value || 0);
    return `¥${amount.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function classByPnl(value) {
    if (value > 0) return "pnl-positive";
    if (value < 0) return "pnl-negative";
    return "";
}

async function requestJSON(url, options = {}) {
    const response = await fetch(url, {
        headers: {
            "Content-Type": "application/json",
            ...(options.headers || {}),
        },
        ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || "请求失败");
    }
    return data;
}

function showToast(message, type = "info") {
    toast.textContent = message;
    toast.className = `toast ${type}`;
    toast.classList.remove("hidden");
    window.setTimeout(() => {
        toast.classList.add("hidden");
    }, 2200);
}

function renderSummary(summary) {
    document.getElementById("summaryCount").textContent = String(summary.count || 0);
    document.getElementById("summaryAlerts").textContent = String(summary.alerts || 0);
    document.getElementById("summaryMarketValue").textContent = formatMoney(summary.total_market_value || 0);

    const pnlElem = document.getElementById("summaryPnL");
    pnlElem.textContent = formatMoney(summary.total_cumulative_pnl || 0);
    pnlElem.className = classByPnl(summary.total_cumulative_pnl || 0);
}

function renderFunds(funds) {
    if (!funds.length) {
        fundTableBody.innerHTML = `<tr><td colspan="13" class="empty">暂无基金，请先添加。</td></tr>`;
        return;
    }

    const rows = funds.map((fund) => {
        const signalText = signalLabelMap[fund.signal] || "无数据";
        const signalClass = signalClassMap[fund.signal] || "no-data";
        const modeText = fund.mode === "holding" ? "实际持有" : "仅观察";
        const rowClass = fund.signal === "buy" ? "signal-buy" : fund.signal === "sell" ? "signal-sell" : "";
        const currentPrice = formatNumber(fund.current_price, 4);
        const buyLine = formatNumber(fund.buy_line, 4);
        const sellLine = formatNumber(fund.sell_line, 4);
        const pnlCls = classByPnl(fund.cumulative_pnl);

        return `
            <tr class="${rowClass}">
                <td>${escapeHtml(fund.code)}</td>
                <td title="${escapeHtml(fund.name)}">${escapeHtml(fund.name)}</td>
                <td>${modeText}</td>
                <td>${formatNumber(fund.last_trade_price, 4)}</td>
                <td>${currentPrice}</td>
                <td>${formatPercent(fund.daily_change_pct)}</td>
                <td>${buyLine}</td>
                <td>${sellLine}</td>
                <td><span class="signal-badge ${signalClass}">${signalText}</span></td>
                <td>${formatNumber(fund.holding_shares, 2)}</td>
                <td>${formatMoney(fund.market_value)}</td>
                <td class="${pnlCls}">${formatMoney(fund.cumulative_pnl)}</td>
                <td>
                    <div class="actions">
                        <button class="btn" data-action="edit" data-id="${fund.id}">修改</button>
                        <button class="btn" data-action="trade" data-id="${fund.id}">交易</button>
                        <button class="btn btn-ghost" data-action="delete" data-id="${fund.id}">删除</button>
                    </div>
                </td>
            </tr>
        `;
    });

    fundTableBody.innerHTML = rows.join("");
}

async function loadFunds(force = false) {
    const data = await requestJSON(`/api/funds?force=${force ? 1 : 0}`);
    state.funds = data.funds || [];
    state.fundMap = new Map(state.funds.map((fund) => [fund.id, fund]));
    renderSummary(data.summary || {});
    renderFunds(state.funds);
    lastUpdated.textContent = `上次刷新: ${new Date().toLocaleString("zh-CN")}`;
}

function resetAddForm() {
    addFundForm.reset();
    addFundForm.elements.mode.value = "watch";
    addFundForm.elements.holding_shares.value = "0";
}

function openEditDialog(fundId) {
    const fund = state.fundMap.get(fundId);
    if (!fund) return;

    editFundForm.elements.fund_id.value = String(fund.id);
    editFundForm.elements.name.value = fund.name;
    editFundForm.elements.mode.value = fund.mode;
    editFundForm.elements.holding_shares.value = Number(fund.holding_shares || 0).toFixed(2);
    editFundForm.elements.last_trade_price.value = Number(fund.last_trade_price || 0).toFixed(4);
    editDialog.showModal();
}

async function openTradeDialog(fundId) {
    const fund = state.fundMap.get(fundId);
    if (!fund) return;

    tradeForm.elements.fund_id.value = String(fund.id);
    tradeForm.elements.trade_date.value = new Date().toISOString().slice(0, 10);
    tradeForm.elements.side.value = "buy";
    tradeForm.elements.shares.value = "";
    tradeForm.elements.price.value = fund.current_price || fund.last_trade_price || "";
    tradeForm.elements.note.value = "";

    tradeDialogTitle.textContent = `交易录入 - ${fund.code} ${fund.name}`;
    tradeDialog.showModal();
    await loadTrades(fund.id);
}

async function loadTrades(fundId) {
    const data = await requestJSON(`/api/funds/${fundId}/trades`);
    const trades = data.trades || [];
    if (!trades.length) {
        tradeTableBody.innerHTML = `<tr><td colspan="6" class="empty">暂无交易记录。</td></tr>`;
        return;
    }

    tradeTableBody.innerHTML = trades.map((trade) => `
        <tr>
            <td>${escapeHtml(trade.trade_date)}</td>
            <td>${trade.side === "buy" ? "买入" : "卖出"}</td>
            <td>${formatNumber(trade.shares, 2)}</td>
            <td>${formatNumber(trade.price, 4)}</td>
            <td>${formatMoney(trade.amount)}</td>
            <td>${escapeHtml(trade.note || "-")}</td>
        </tr>
    `).join("");
}

async function onAddFundSubmit(event) {
    event.preventDefault();
    const payload = {
        code: addFundForm.elements.code.value.trim(),
        mode: addFundForm.elements.mode.value,
        holding_shares: Number(addFundForm.elements.holding_shares.value || 0),
        last_trade_price: addFundForm.elements.last_trade_price.value
            ? Number(addFundForm.elements.last_trade_price.value)
            : null,
    };

    try {
        await requestJSON("/api/funds", {
            method: "POST",
            body: JSON.stringify(payload),
        });
        showToast("基金已添加", "success");
        resetAddForm();
        await loadFunds(true);
    } catch (error) {
        showToast(error.message, "error");
    }
}

async function onEditFundSubmit(event) {
    event.preventDefault();
    const fundId = Number(editFundForm.elements.fund_id.value);
    const payload = {
        name: editFundForm.elements.name.value.trim(),
        mode: editFundForm.elements.mode.value,
        holding_shares: Number(editFundForm.elements.holding_shares.value),
        last_trade_price: Number(editFundForm.elements.last_trade_price.value),
    };

    try {
        await requestJSON(`/api/funds/${fundId}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
        });
        editDialog.close();
        showToast("基金信息已更新", "success");
        await loadFunds(true);
    } catch (error) {
        showToast(error.message, "error");
    }
}

async function onTradeSubmit(event) {
    event.preventDefault();
    const fundId = Number(tradeForm.elements.fund_id.value);
    const payload = {
        trade_date: tradeForm.elements.trade_date.value,
        side: tradeForm.elements.side.value,
        shares: Number(tradeForm.elements.shares.value),
        price: Number(tradeForm.elements.price.value),
        note: tradeForm.elements.note.value.trim(),
    };

    try {
        await requestJSON(`/api/funds/${fundId}/trades`, {
            method: "POST",
            body: JSON.stringify(payload),
        });
        showToast("交易已录入", "success");
        tradeForm.elements.shares.value = "";
        tradeForm.elements.note.value = "";
        await loadTrades(fundId);
        await loadFunds(true);
    } catch (error) {
        showToast(error.message, "error");
    }
}

async function onFundTableClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) return;

    const action = button.dataset.action;
    const fundId = Number(button.dataset.id);
    if (!fundId) return;

    if (action === "edit") {
        openEditDialog(fundId);
        return;
    }
    if (action === "trade") {
        await openTradeDialog(fundId);
        return;
    }
    if (action === "delete") {
        const confirmed = window.confirm("删除该基金会同时删除其交易记录，是否继续？");
        if (!confirmed) return;
        try {
            await requestJSON(`/api/funds/${fundId}`, { method: "DELETE" });
            showToast("基金已删除", "success");
            await loadFunds(true);
        } catch (error) {
            showToast(error.message, "error");
        }
    }
}

function setupAutoRefresh() {
    if (state.refreshTimerId) {
        window.clearInterval(state.refreshTimerId);
    }
    state.refreshTimerId = window.setInterval(async () => {
        try {
            await loadFunds(false);
        } catch (error) {
            showToast(error.message, "error");
        }
    }, 45000);
}

async function initialize() {
    addFundForm.addEventListener("submit", onAddFundSubmit);
    editFundForm.addEventListener("submit", onEditFundSubmit);
    tradeForm.addEventListener("submit", onTradeSubmit);
    fundTableBody.addEventListener("click", onFundTableClick);

    refreshBtn.addEventListener("click", async () => {
        refreshBtn.disabled = true;
        try {
            await loadFunds(true);
            showToast("行情已刷新", "info");
        } catch (error) {
            showToast(error.message, "error");
        } finally {
            refreshBtn.disabled = false;
        }
    });

    try {
        await loadFunds(true);
    } catch (error) {
        showToast(error.message, "error");
    }
    setupAutoRefresh();
}

document.addEventListener("DOMContentLoaded", initialize);
