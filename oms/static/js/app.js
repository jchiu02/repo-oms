let portfolioData = [];
let currentPortfolio = null;
const draftTrades = new Map();
let displayMode = "market_value"; // "notional" or "market_value"
let lastComplianceData = null;
let lastComplianceTime = null;
let complianceExpiryTimer = null;
let complianceCountdownTimer = null;
const COMPLIANCE_TTL_MS = 2 * 60 * 1000; // 2 minutes
let orderedTrades = []; // Sent but not yet settled
let betaMode = false;
let sortColumn = null; // 0-5 for T+n, or null for the default type/maturity sort
let sortDirection = null; // "asc" | "desc" | null

document.addEventListener("DOMContentLoaded", () => {
  renderBusinessDate();

  fetch("/api/portfolios")
    .then((r) => r.json())
    .then((data) => {
      portfolioData = data.portfolios;
      updateLastRefreshed(data.last_refreshed);
      populateDropdown();
    });

  document
    .getElementById("portfolio-select")
    .addEventListener("change", onPortfolioChange);

  document
    .getElementById("refresh-btn")
    .addEventListener("click", onRefreshPrices);

  document
    .getElementById("display-toggle")
    .addEventListener("change", onDisplayToggle);

  document
    .getElementById("run-compliance-btn")
    .addEventListener("click", onRunCompliance);

  document
    .getElementById("reset-btn")
    .addEventListener("click", onReset);

  document
    .getElementById("send-trade-btn")
    .addEventListener("click", onSendTrade);

  document.getElementById("sent-trades-btn").addEventListener("click", openDrawer);
  document.getElementById("close-drawer-btn").addEventListener("click", closeDrawer);
  document.getElementById("drawer-backdrop").addEventListener("click", closeDrawer);
  // document.getElementById("beta-btn").addEventListener("click", onBetaToggle);

  document.querySelectorAll("#positions-table thead .col-tn").forEach((th, i) => {
    th.addEventListener("click", () => onSortHeaderClick(i));
  });

  document.getElementById("expand-all-btn").addEventListener("click", onExpandAll);
});

function openDrawer() {
  document.getElementById("sent-trades-drawer").classList.add("open");
  document.getElementById("drawer-backdrop").classList.remove("hidden");
}

function closeDrawer() {
  document.getElementById("sent-trades-drawer").classList.remove("open");
  document.getElementById("drawer-backdrop").classList.add("hidden");
}

function renderBusinessDate() {
  const dates = getBusinessDates(1);
  const formatted = dates[0].toLocaleDateString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  document.getElementById("business-date").textContent = formatted;
}

// Returns an array of `count` consecutive business days starting from today's business date
function getBusinessDates(count) {
  const dates = [];
  const d = new Date();
  // Normalise to most recent weekday
  const dow = d.getDay();
  if (dow === 0) d.setDate(d.getDate() - 2);
  else if (dow === 6) d.setDate(d.getDate() - 1);

  let cursor = new Date(d);
  while (dates.length < count) {
    dates.push(new Date(cursor));
    // Advance to next business day
    cursor.setDate(cursor.getDate() + 1);
    while (cursor.getDay() === 0 || cursor.getDay() === 6) {
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return dates;
}

function populateDropdown() {
  const select = document.getElementById("portfolio-select");
  portfolioData.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    select.appendChild(opt);
  });

  // Auto-select the first portfolio
  if (portfolioData.length > 0) {
    select.value = portfolioData[0].id;
    select.dispatchEvent(new Event("change"));
  }
}


function onPortfolioChange(e) {
  const id = e.target.value;
  const holdingsPanel = document.getElementById("holdings-panel");
  const tradesPanel = document.getElementById("trades-panel");
  const empty = document.getElementById("empty-state");

  if (!id) {
    holdingsPanel.classList.add("hidden");
    tradesPanel.classList.add("hidden");
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");
  holdingsPanel.classList.remove("hidden");

  // Clear trades when switching portfolio
  document.getElementById("trades-body").innerHTML = "";
  tradesPanel.classList.add("hidden");
  draftTrades.clear();
  updateTradesCount();

  currentPortfolio = portfolioData.find((p) => p.id === id);
  orderedTrades = (currentPortfolio.sent_trades || []);
  renderSentTradesBlotter(orderedTrades);
  renderTable(currentPortfolio);
}

function getExpandedGroups() {
  const expanded = new Set();
  document.querySelectorAll("tr.parent-row.expanded").forEach((tr) => {
    expanded.add(tr.dataset.groupId);
  });
  return expanded;
}

function renderTable(portfolio) {
  const expanded = getExpandedGroups();
  renderTnHeaders();
  const tbody = document.getElementById("positions-body");
  tbody.innerHTML = "";
  const t0Date = getBusinessDates(1)[0];

  // ── Cash row ─────────────────────────────────────────────────────────────
  const cashBalance = portfolio.cash_balance || 0;
  const cashGroupId = "cash";
  const allDrafts = Array.from(draftTrades.values()).filter(d => !(d.reason || "").startsWith("trs_"));
  const hasDrafts = allDrafts.length > 0;
  const orderedCashTrades = orderedTrades.filter(o => o.status === "ordered" && !(o.reason || "").startsWith("trs_"));
  const confirmedCashTrades = orderedTrades.filter(o => o.status === "confirmed" && !(o.reason || "").startsWith("trs_"));

  // Cash impact is the opposite sign of market_value: a repo (negative notional/MV)
  // gives collateral away and brings cash IN; a reverse repo (positive notional/MV)
  // receives collateral and pays cash OUT.
  function cashAt(trades, t) {
    let total = 0;
    trades.forEach(o => {
      const s_t = tOffset(o.sdate, t0Date);
      const m_t = tOffset(o.mdate, t0Date);
      if (s_t !== -1 && t >= s_t && (m_t === -1 || t < m_t)) total += -(o.market_value || 0);
    });
    return total;
  }

  function draftCashAt(t) {
    let total = 0;
    allDrafts.forEach(d => {
      const s_t = tOffset(d.sdate, t0Date);
      const m_t = tOffset(d.mdate, t0Date);
      if (s_t !== -1 && t >= s_t && (m_t === -1 || t < m_t)) total += -(d.market_value || 0);
    });
    return total;
  }

  function makeEmptyCell() { return document.createElement("td"); }
  function makeBadgeCell(label, cls) {
    const td = document.createElement("td");
    td.innerHTML = `<span class="type-badge ${cls}">${label}</span>`;
    return td;
  }
  function makeNumCell(val) {
    const td = document.createElement("td");
    td.className = `num ${val >= 0 ? "positive" : "negative"}`;
    td.textContent = formatNum(val);
    return td;
  }

  const trsPositions = betaMode ? portfolio.bonds.flatMap(b => b.positions.filter(p => p.type === "trs_receiver" || p.type === "trs_payer")) : [];
  const hasTrsCash = trsPositions.length > 0;
  function trsCashAt(t) {
    let total = 0;
    trsPositions.forEach(pos => { if (t < pos.repo_maturity_t) total += (pos.market_value || 0); });
    return total;
  }
  const hasProjected = hasDrafts || orderedCashTrades.length > 0 || confirmedCashTrades.length > 0;

  // Parent: Cash
  const cashParentTr = document.createElement("tr");
  cashParentTr.className = "parent-row cash-parent-row";
  cashParentTr.dataset.groupId = cashGroupId;
  cashParentTr.addEventListener("click", () => toggleChildren(cashParentTr, cashGroupId));
  const cashChevron = document.createElement("span");
  cashChevron.className = "chevron";
  cashChevron.innerHTML = "&#9654;";
  const cashNameCell = document.createElement("td");
  cashNameCell.appendChild(cashChevron);
  cashNameCell.appendChild(document.createTextNode(hasProjected ? "Projected Cash" : "Cash"));
  cashParentTr.appendChild(cashNameCell);
  cashParentTr.appendChild(makeEmptyCell());
  cashParentTr.appendChild(makeEmptyCell());
  cashParentTr.appendChild(makeBadgeCell(hasProjected ? "Projected" : "Cash", hasProjected ? "projected-cash-badge" : "cash-badge"));
  cashParentTr.appendChild(makeEmptyCell());
  for (let t = 0; t <= 5; t++) {
    const base = t < 2 ? 1_000_000 : cashBalance;
    cashParentTr.appendChild(makeNumCell(base + draftCashAt(t) + cashAt(orderedCashTrades, t) + cashAt(confirmedCashTrades, t) + trsCashAt(t)));
  }
  tbody.appendChild(cashParentTr);

  // Child: Draft Cash
  if (hasDrafts) {
    const tr = document.createElement("tr");
    tr.className = "child-row";
    tr.dataset.parentId = cashGroupId;
    tr.appendChild(makeEmptyCell()); tr.appendChild(makeEmptyCell()); tr.appendChild(makeEmptyCell());
    tr.appendChild(makeBadgeCell("Draft Cash", "draft-cash"));
    tr.appendChild(makeEmptyCell());
    for (let t = 0; t <= 5; t++) {
      const val = draftCashAt(t);
      const td = document.createElement("td");
      td.className = `num ${val > 0 ? "positive" : "matured"}`;
      td.textContent = formatNum(val);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  // Child: Working Cash
  if (orderedCashTrades.length > 0) {
    const tr = document.createElement("tr");
    tr.className = "child-row";
    tr.dataset.parentId = cashGroupId;
    tr.appendChild(makeEmptyCell()); tr.appendChild(makeEmptyCell()); tr.appendChild(makeEmptyCell());
    tr.appendChild(makeBadgeCell("Working Cash", "type-working"));
    tr.appendChild(makeEmptyCell());
    for (let t = 0; t <= 5; t++) {
      const val = cashAt(orderedCashTrades, t);
      const td = document.createElement("td");
      td.className = `num ${val > 0 ? "positive" : "matured"}`;
      td.textContent = formatNum(val);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  // Child: Confirmed Cash
  if (confirmedCashTrades.length > 0) {
    const tr = document.createElement("tr");
    tr.className = "child-row";
    tr.dataset.parentId = cashGroupId;
    tr.appendChild(makeEmptyCell()); tr.appendChild(makeEmptyCell()); tr.appendChild(makeEmptyCell());
    tr.appendChild(makeBadgeCell("Confirmed Cash", "type-confirmed"));
    tr.appendChild(makeEmptyCell());
    for (let t = 0; t <= 5; t++) {
      const val = cashAt(confirmedCashTrades, t);
      const td = document.createElement("td");
      td.className = `num ${val > 0 ? "positive" : "matured"}`;
      td.textContent = formatNum(val);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  // Child: TRS Cash (beta mode — net MtM of active TRS positions)
  if (hasTrsCash) {
    const tr = document.createElement("tr");
    tr.className = "child-row";
    tr.dataset.parentId = cashGroupId;
    tr.appendChild(makeEmptyCell()); tr.appendChild(makeEmptyCell()); tr.appendChild(makeEmptyCell());
    tr.appendChild(makeBadgeCell("TRS Cash", "trs-return"));
    tr.appendChild(makeEmptyCell());
    for (let t = 0; t <= 5; t++) {
      const val = trsCashAt(t);
      const td = document.createElement("td");
      td.className = `num ${val > 0 ? "positive" : val < 0 ? "negative" : "matured"}`;
      td.textContent = formatNum(val);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  // Child: Cash balance
  const cashLineTr = document.createElement("tr");
  cashLineTr.className = "child-row";
  cashLineTr.dataset.parentId = cashGroupId;
  cashLineTr.appendChild(makeEmptyCell()); cashLineTr.appendChild(makeEmptyCell()); cashLineTr.appendChild(makeEmptyCell());
  cashLineTr.appendChild(makeBadgeCell("Cash", "cash-badge"));
  cashLineTr.appendChild(makeEmptyCell());
  for (let t = 0; t <= 5; t++) cashLineTr.appendChild(makeNumCell(t < 2 ? 1_000_000 : cashBalance));
  tbody.appendChild(cashLineTr);

  if (expanded.has(cashGroupId)) {
    cashParentTr.classList.add("expanded");
    document.querySelectorAll(`tr[data-parent-id="${cashGroupId}"]`).forEach(tr => tr.classList.add("visible"));
  }
  // ─────────────────────────────────────────────────────────────────────────

  const sortedBonds = getSortedBonds(portfolio, t0Date);
  sortedBonds.forEach((bond) => {
    const bondPos = bond.positions.find((p) => p.type === "bond");
    const repos = bond.positions.filter((p) => p.type === "repo");
    const groupId = `bond-${bond.isin}`;

    // Parent row: net available
    const parentTr = document.createElement("tr");
    parentTr.className = "parent-row";
    parentTr.dataset.groupId = groupId;

    // Clicking the row (not the + button) expands children
    parentTr.addEventListener("click", (e) => {
      if (!e.target.closest(".add-trade-btn")) {
        toggleChildren(parentTr, groupId);
      }
    });

    // Build + button
    const addBtn = document.createElement("button");
    addBtn.className = "add-trade-btn";
    addBtn.title = `Add trade for ${bond.name}`;
    addBtn.textContent = "+";
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      addTradeRow(bond);
    });

    // Bond name cell
    const bondCell = document.createElement("td");
    const chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.innerHTML = "&#9654;";
    bondCell.appendChild(chevron);
    bondCell.appendChild(document.createTextNode(bond.name));
    bondCell.appendChild(addBtn);

    parentTr.appendChild(bondCell);

    // Bond classification (INF / IR / CORP)
    const bondTypeCell = document.createElement("td");
    const { label: btLabel, cls: btCls } = bondTypeLabel(bond.name);
    bondTypeCell.innerHTML = `<span class="type-badge ${btCls}">${btLabel}</span>`;
    parentTr.appendChild(bondTypeCell);

    const isinCell = document.createElement("td");
    isinCell.textContent = bond.isin;
    parentTr.appendChild(isinCell);

    const typeCell = document.createElement("td");
    typeCell.innerHTML = `<span class="type-badge net">Net Avail</span>`;
    parentTr.appendChild(typeCell);

    const cptyCell = document.createElement("td");
    parentTr.appendChild(cptyCell);

    for (let t = 0; t <= 5; t++) {
      const net = netAvailableBook(bond, t, t0Date);
      const cls = net > 0 ? "positive" : net < 0 ? "negative" : "";
      const td = document.createElement("td");
      td.className = `num ${cls}`;
      td.textContent = formatNum(net);
      parentTr.appendChild(td);
    }

    // Draft Net Avail row — only when this bond has proposed trades
    const bondDrafts = Array.from(draftTrades.values()).filter(d => d.isin === bond.isin && !(d.reason || "").startsWith("trs_"));
    let activePrimaryRow = parentTr;
    if (bondDrafts.length > 0) {
      const draftNetTr = document.createElement("tr");
      draftNetTr.className = "parent-row draft-net-row";
      draftNetTr.dataset.groupId = groupId;
      draftNetTr.style.cursor = "pointer";
      draftNetTr.addEventListener("click", (e) => {
        if (!e.target.closest(".add-trade-btn")) toggleChildren(draftNetTr, groupId);
      });

      const draftNameCell = document.createElement("td");
      const draftChevron = document.createElement("span");
      draftChevron.className = "chevron";
      draftChevron.innerHTML = "&#9654;";
      draftNameCell.appendChild(draftChevron);
      draftNameCell.appendChild(document.createTextNode(bond.name));
      draftNameCell.appendChild(addBtn);
      draftNetTr.appendChild(draftNameCell);

      const draftBondTypeCell = document.createElement("td");
      const { label: dtLabel, cls: dtCls } = bondTypeLabel(bond.name);
      draftBondTypeCell.innerHTML = `<span class="type-badge ${dtCls}">${dtLabel}</span>`;
      draftNetTr.appendChild(draftBondTypeCell);

      const draftIsinCell = document.createElement("td");
      draftIsinCell.textContent = bond.isin;
      draftNetTr.appendChild(draftIsinCell);

      const draftTypeCell = document.createElement("td");
      draftTypeCell.innerHTML = `<span class="type-badge draft-net-badge">Draft Net</span>`;
      draftNetTr.appendChild(draftTypeCell);

      draftNetTr.appendChild(document.createElement("td"));

      for (let t = 0; t <= 5; t++) {
        const net = netAvailable(bond, t, t0Date);
        const cls = net > 0 ? "positive" : net < 0 ? "negative" : "";
        const td = document.createElement("td");
        td.className = `num ${cls}`;
        td.textContent = formatNum(net);
        draftNetTr.appendChild(td);
      }

      tbody.appendChild(draftNetTr);
      activePrimaryRow = draftNetTr;
    } else {
      tbody.appendChild(parentTr);
    }

    // Children: repo positions
    repos.forEach((repo) => {
      const repoTr = document.createElement("tr");
      repoTr.className = "child-row";
      repoTr.dataset.parentId = groupId;
      repoTr.innerHTML =
        `<td></td>` +
        `<td></td>` +
        `<td></td>` +
        `<td><span class="type-badge repo">Repo</span></td>` +
        `<td>${escHtml(repo.counterparty)}</td>`;

      for (let t = 0; t <= 5; t++) {
        const active = t < repo.repo_maturity_t;
        const val = active ? posValue(repo) : 0;
        const cls = active ? "negative" : "matured";
        repoTr.innerHTML += `<td class="num ${cls}">${formatNum(val)}</td>`;
      }
      tbody.appendChild(repoTr);
    });

    // Children: TRS positions (beta mode — one net row per position)
    if (betaMode) {
      bond.positions.filter(p => p.type === "trs_receiver" || p.type === "trs_payer").forEach(pos => {
        const isTrsReceiver = pos.type === "trs_receiver";
        const badgeCls   = isTrsReceiver ? "trs-recv-return" : "trs-pay-return";
        const badgeLabel = isTrsReceiver ? "TRS Recv"        : "TRS Payer";

        const trsTr = document.createElement("tr");
        trsTr.className = "child-row";
        trsTr.dataset.parentId = groupId;
        trsTr.innerHTML =
          `<td></td><td></td><td></td>` +
          `<td><span class="type-badge ${badgeCls}">${badgeLabel}</span></td>` +
          `<td>${escHtml(pos.counterparty)}</td>`;
        for (let t = 0; t <= 5; t++) {
          const active = t < pos.repo_maturity_t;
          const val = active ? (pos.market_value || 0) : 0;
          const cls = val > 0 ? "positive" : val < 0 ? "negative" : "matured";
          trsTr.innerHTML += `<td class="num ${cls}">${formatNum(val)}</td>`;
        }
        tbody.appendChild(trsTr);
      });
    }

    // Children: ordered (sent) trades — exclude rejected and settled
    const ordered = orderedTrades.filter(o => o.isin === bond.isin && o.status !== "settled" && o.status !== "rejected");
    ordered.forEach(o => {
      const orderedTr = document.createElement("tr");
      orderedTr.className = "child-row ordered-row";
      orderedTr.dataset.parentId = groupId;
      const badgeCls = o.status === "confirmed" ? "type-confirmed" : "type-working";
      const badgeLabel = o.status === "confirmed" ? "Confirmed" : "Working";
      orderedTr.innerHTML =
        `<td></td><td></td><td></td>` +
        `<td><span class="type-badge ${badgeCls}">${badgeLabel}</span></td>` +
        `<td>${escHtml(o.counterparty)}</td>`;
      for (let t = 0; t <= 5; t++) {
        const s_t = tOffset(o.sdate, t0Date);
        const m_t = tOffset(o.mdate, t0Date);
        const active = s_t !== -1 && t >= s_t && (m_t === -1 || t < m_t);
        const val = active ? (displayMode === "notional" ? o.notional : o.market_value) : 0;
        const cls = active ? "negative" : "matured";
        orderedTr.innerHTML += `<td class="num ${cls}">${formatNum(val)}</td>`;
      }
      tbody.appendChild(orderedTr);
    });

    // Children: draft trades (repo only — TRS drafts don't affect bond inventory)
    const drafts = Array.from(draftTrades.values()).filter(d => d.isin === bond.isin && !(d.reason || "").startsWith("trs_"));
    if (drafts.length > 0) {
      const draftTr = document.createElement("tr");
      draftTr.className = "child-row draft-row";
      draftTr.dataset.parentId = groupId;
      
      draftTr.innerHTML =
        `<td></td>` +
        `<td></td>` +
        `<td></td>` +
        `<td><span class="type-badge draft-repo">Draft Repo</span></td>` +
        `<td>Proposed</td>`;

      for (let t = 0; t <= 5; t++) {
        let totalVal = 0;
        let anyActive = false;
        drafts.forEach(draft => {
          const s_t = tOffset(draft.sdate, t0Date);
          const m_t = tOffset(draft.mdate, t0Date);
          const active = (s_t !== -1 && t >= s_t) && (m_t === -1 || t < m_t);
          if (active) {
            anyActive = true;
            totalVal += (displayMode === "notional" ? draft.notional : draft.market_value);
          }
        });
        
        const cls = anyActive ? (totalVal < 0 ? "negative" : "positive") : "matured";
        draftTr.innerHTML += `<td class="num ${cls}">${formatNum(totalVal)}</td>`;
      }
      tbody.appendChild(draftTr);
    }

    // Child: bond position
    const bondTr = document.createElement("tr");
    bondTr.className = "child-row";
    bondTr.dataset.parentId = groupId;
    bondTr.innerHTML =
      `<td></td>` +
      `<td></td>` +
      `<td></td>` +
      `<td><span class="type-badge bond">Bond</span></td>` +
      `<td></td>`;

    for (let t = 0; t <= 5; t++) {
      bondTr.innerHTML += `<td class="num positive">${formatNum(posValue(bondPos))}</td>`;
    }
    tbody.appendChild(bondTr);

    if (expanded.has(groupId)) {
      activePrimaryRow.classList.add("expanded");
      document.querySelectorAll(`tr[data-parent-id="${groupId}"]`).forEach((tr) => {
        tr.classList.add("visible");
      });
    }
  });
  // Check if any draft trade causes a short sell (negative net available at settlement)
  checkShortSellWarning(portfolio, t0Date);
}

function checkShortSellWarning(portfolio, t0Date) {
  const warningEl = document.getElementById("short-sell-warning");
  if (!warningEl) return;

  let hasShortSell = false;

  portfolio.bonds.forEach(bond => {
    const drafts = Array.from(draftTrades.values()).filter(d => d.isin === bond.isin);
    if (drafts.length === 0) return;

    drafts.forEach(draft => {
      const s_t = tOffset(draft.sdate, t0Date);
      if (s_t === -1) return;
      const net = netAvailableNotional(bond, s_t, t0Date);
      if (net < 0) hasShortSell = true;
    });
  });

  if (hasShortSell) {
    warningEl.classList.remove("hidden");
  } else {
    warningEl.classList.add("hidden");
  }
}

function onBetaToggle() {
  betaMode = !betaMode;
  document.getElementById("beta-btn").classList.toggle("active", betaMode);
  if (currentPortfolio) renderTable(currentPortfolio);
}

function onReset() {
  fetch("/api/reset", { method: "POST" })
    .then(r => r.json())
    .then(data => {
      portfolioData = data.portfolios;
      orderedTrades = [];
      draftTrades.clear();
      lastComplianceData = null;
      lastComplianceTime = null;
      if (complianceExpiryTimer) clearTimeout(complianceExpiryTimer);
      if (complianceCountdownTimer) clearInterval(complianceCountdownTimer);
      document.getElementById("trades-body").innerHTML = "";
      document.getElementById("trades-panel").classList.add("hidden");
      document.getElementById("compliance-overlay").classList.add("hidden");
      updateTradesCount();
      const selected = document.getElementById("portfolio-select").value;
      if (selected) {
        currentPortfolio = portfolioData.find(p => p.id === selected);
        orderedTrades = currentPortfolio.sent_trades || [];
        renderSentTradesBlotter(orderedTrades);
        renderTable(currentPortfolio);
      }
    });
}

function onDisplayToggle(e) {
  displayMode = e.target.value;
  const selected = document.getElementById("portfolio-select").value;
  if (selected) {
    const portfolio = portfolioData.find((p) => p.id === selected);
    renderTable(portfolio);
  }
}

function posValue(pos) {
  return displayMode === "market_value"
    ? (pos.market_value ?? pos.notional)
    : pos.notional;
}

// ── Price refresh ───────────────────────────────────────────────────────────

function onRefreshPrices() {
  const btn = document.getElementById("refresh-btn");
  btn.disabled = true;
  btn.textContent = "Refreshing…";

  fetch("/api/refresh-prices", { method: "POST" })
    .then((r) => r.json())
    .then((data) => {
      portfolioData = data.portfolios;
      updateLastRefreshed(data.last_refreshed);
      const selected = document.getElementById("portfolio-select").value;
      if (selected) {
        const portfolio = portfolioData.find((p) => p.id === selected);
        renderTable(portfolio);
      }
    })
    .finally(() => {
      btn.disabled = false;
      btn.textContent = "↻ Refresh Prices";
    });
}

function updateLastRefreshed(ts) {
  const el = document.getElementById("last-refreshed");
  if (ts) {
    el.textContent = `Last refreshed: ${ts}`;
  }
}

// ── T+n headers ──────────────────────────────────────────────────────────────

function renderTnHeaders() {
  const dates = getBusinessDates(6);
  const ths = document.querySelectorAll("#positions-table thead .col-tn");
  ths.forEach((th, i) => {
    const label = dates[i].toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
    });
    th.innerHTML =
      `<span class="tn-label">T+${i}</span>` +
      `<span class="tn-date">${label}</span>`;
    th.classList.toggle("sort-asc", sortColumn === i && sortDirection === "asc");
    th.classList.toggle("sort-desc", sortColumn === i && sortDirection === "desc");
  });
}

// Clicking a T+n header cycles asc -> desc -> reset (back to default type/maturity order)
function onSortHeaderClick(t) {
  if (sortColumn !== t) {
    sortColumn = t;
    sortDirection = "asc";
  } else if (sortDirection === "asc") {
    sortDirection = "desc";
  } else {
    sortColumn = null;
    sortDirection = null;
  }
  if (currentPortfolio) renderTable(currentPortfolio);
}

// ── Trades panel ─────────────────────────────────────────────────────────────

function addTradeRow(bond) {
  const tradesPanel = document.getElementById("trades-panel");
  const tbody = document.getElementById("trades-body");

  if (tradesPanel.classList.contains("hidden")) {
    tradesPanel.classList.remove("hidden");
  }

  const dates = getBusinessDates(6);
  const t0Str = toInputDate(dates[0]);
  const t2Str = toInputDate(dates[2]);
  const t3mDate = new Date(dates[0]);
  t3mDate.setMonth(t3mDate.getMonth() + 3);
  if (t3mDate.getDay() === 6) t3mDate.setDate(t3mDate.getDate() + 2);
  if (t3mDate.getDay() === 0) t3mDate.setDate(t3mDate.getDate() + 1);
  const t3mStr = toInputDate(t3mDate);
  const t2Notional = -netAvailableNotional(bond, 2, dates[0]);

  const tr = document.createElement("tr");
  tr.className = "trade-row";

  // Bond name cell (plain text)
  const bondTd = document.createElement("td");
  bondTd.textContent = bond.name;
  tr.appendChild(bondTd);

  // Type cell — updates based on notional
  const typeTd = document.createElement("td");
  const typeSpan = document.createElement("span");
  typeTd.appendChild(typeSpan);
  tr.appendChild(typeTd);

  function updateTypeBadge(val) {
    let parsedStr = String(val).replace(/,/g, '').trim();
    let num = 0;
    if (parsedStr.startsWith('(') && parsedStr.endsWith(')')) {
      num = -parseFloat(parsedStr.slice(1, -1));
    } else {
      num = parseFloat(parsedStr);
    }
    if (isNaN(num)) num = 0;

    const reason = tr.querySelector(".trade-select")?.value || "";
    if (reason === "trs_receiver") {
      typeSpan.className = "type-badge trs-recv-return";
      typeSpan.textContent = "TRS Recv"; return;
    }
    if (reason === "trs_payer") {
      typeSpan.className = "type-badge trs-pay-return";
      typeSpan.textContent = "TRS Payer"; return;
    }
    if (num < 0) {
      typeSpan.className = "type-badge repo";
      typeSpan.textContent = "Repo";
    } else {
      typeSpan.className = "type-badge rev-repo";
      typeSpan.textContent = "Rev Repo";
    }
  }

  const dirtyPrice = bond.dirty_price ?? 100;
  let syncing = false;

  const tradeId = Date.now() + "-" + Math.random().toString(36).substr(2, 9);
  const initAbsMv = Math.abs(t2Notional * dirtyPrice / 100);
  const draftTrade = {
    id: tradeId,
    isin: bond.isin,
    notional: t2Notional,
    market_value: t2Notional < 0 ? -initAbsMv : initAbsMv,
    sdate: t2Str,
    mdate: t3mStr,
    counterparty: "",
  };
  draftTrades.set(tradeId, draftTrade);
  lastComplianceData = null; lastComplianceTime = null;
  if (complianceExpiryTimer) { clearTimeout(complianceExpiryTimer); complianceExpiryTimer = null; }
  if (complianceCountdownTimer) { clearInterval(complianceCountdownTimer); complianceCountdownTimer = null; }
  const countdown = document.getElementById("compliance-countdown");
  if (countdown) countdown.textContent = "";

  function syncDraftTrade() {
    const notional = parseInput(notionalInput.value) || 0;
    const absMv = Math.abs(parseInput(mvInput.value) || 0);
    draftTrade.notional = notional;
    const rSelect = tr.querySelector(".trade-select");
    const reason = rSelect ? rSelect.value : "repo";
    draftTrade.reason = reason;
    if (reason.startsWith("trs_")) {
      draftTrade.market_value = notional >= 0 ? absMv : -absMv;
    } else {
      draftTrade.market_value = notional < 0 ? -absMv : absMv;
    }
    if (currentPortfolio) renderTable(currentPortfolio);
  }

  function parseInput(str) {
    let s = String(str).replace(/,/g, "").trim();
    if (s.startsWith("(") && s.endsWith(")")) return -parseFloat(s.slice(1, -1));
    return parseFloat(s);
  }

  // Notional — pre-filled with T+2 net available, editable
  const notionalTd = document.createElement("td");
  const notionalInput = document.createElement("input");
  notionalInput.type = "text";
  notionalInput.className = "trade-input";
  notionalInput.value = formatInputNum(t2Notional);
  notionalInput.placeholder = "Notional";

  // Market Value — editable, opposite sign to notional, syncs with notional
  const mvTd = document.createElement("td");
  const mvInput = document.createElement("input");
  mvInput.type = "text";
  mvInput.className = "trade-input";
  mvInput.placeholder = "Market value";

  notionalInput.addEventListener("input", () => {
    if (syncing) return;
    syncing = true;
    const notional = parseInput(notionalInput.value);
    if (!isNaN(notional) && notional !== 0) {
      const reason = tr.querySelector(".trade-select")?.value || "repo";
      const mv = reason.startsWith("trs_")
        ? (notional * dirtyPrice / 100)
        : -(notional * dirtyPrice / 100);
      mvInput.value = formatInputNum(Math.round(mv));
    } else {
      mvInput.value = "";
    }
    updateTypeBadge(notionalInput.value);
    syncing = false;
    syncDraftTrade();
  });

  mvInput.addEventListener("input", () => {
    if (syncing) return;
    syncing = true;
    const mv = parseInput(mvInput.value);
    if (!isNaN(mv) && mv !== 0 && dirtyPrice > 0) {
      const reason = tr.querySelector(".trade-select")?.value || "repo";
      const notional = reason.startsWith("trs_")
        ? (mv / dirtyPrice * 100)
        : -(mv / dirtyPrice * 100);
      notionalInput.value = formatInputNum(Math.round(notional));
    } else {
      notionalInput.value = "";
    }
    updateTypeBadge(notionalInput.value);
    syncing = false;
    syncDraftTrade();
  });

  // Initial sync
  const initMv = -(t2Notional * dirtyPrice / 100);
  mvInput.value = initMv !== 0 ? formatInputNum(Math.round(initMv)) : "";
  updateTypeBadge(t2Notional);

  notionalTd.appendChild(notionalInput);
  tr.appendChild(notionalTd);
  mvTd.appendChild(mvInput);
  tr.appendChild(mvTd);

  // Settlement Date — display text + calendar icon label wrapping hidden input
  const sdateTd = document.createElement("td");
  const sdateContainer = document.createElement("div");
  sdateContainer.className = "sdate-container";

  const sdateDisplay = document.createElement("span");
  sdateDisplay.className = "sdate-display";

  const sdateIconBtn = document.createElement("button");
  sdateIconBtn.className = "sdate-icon-btn";
  sdateIconBtn.type = "button";
  sdateIconBtn.title = "Pick date";
  sdateIconBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;

  const sdateInput = document.createElement("input");
  sdateInput.type = "text";
  sdateInput.className = "sdate-hidden";

  function fmtSdate(dateStr) {
    if (!dateStr) return "—";
    const [y, mo, d] = dateStr.split("-").map(Number);
    const dt = new Date(y, mo - 1, d);
    const ddmmyyyy = dt.toLocaleDateString("en-GB");
    const tn = businessDaysFromT0(dateStr, dates[0]);
    return tn ? `${ddmmyyyy} (${tn})` : ddmmyyyy;
  }

  const t5Str = toInputDate(dates[5]);

  let mdateFp; // Reference for Maturity Flatpickr
  // Store parsed YYYY-MM-DD strings directly from Flatpickr to avoid format issues
  let currentSdate = t2Str;
  let currentMdate = t3mStr;

  const sdateFp = flatpickr(sdateInput, {
    defaultDate: t2Str,
    minDate: t0Str,
    maxDate: t5Str,
    dateFormat: "Y-m-d",
    disable: [ function(date) { return (date.getDay() === 0 || date.getDay() === 6); } ],
    onChange: function(selectedDates, dateStr) {
      currentSdate = dateStr;
      draftTrade.sdate = dateStr;
      sdateDisplay.textContent = fmtSdate(dateStr);
      if (mdateFp) {
        mdateFp.set("minDate", dateStr);
        if (currentMdate && currentMdate < dateStr) {
          mdateFp.setDate(dateStr);
          currentMdate = dateStr;
          draftTrade.mdate = dateStr;
          mdateDisplay.textContent = fmtSdate(dateStr);
        }
      }
      syncDraftTrade();
    }
  });

  sdateIconBtn.addEventListener("click", () => {
    sdateFp.open();
  });

  sdateDisplay.textContent = fmtSdate(t2Str);
  sdateContainer.appendChild(sdateDisplay);
  sdateContainer.appendChild(sdateIconBtn);
  sdateContainer.appendChild(sdateInput);
  sdateTd.appendChild(sdateContainer);
  tr.appendChild(sdateTd);

  // Maturity Date — same overlay structure, default T+3 months, min = settlement date
  const mdateTd = document.createElement("td");
  const mdateContainer = document.createElement("div");
  mdateContainer.className = "sdate-container"; // Reuse same layout CSS

  const mdateDisplay = document.createElement("span");
  mdateDisplay.className = "sdate-display";

  const mdateIconBtn = document.createElement("button");
  mdateIconBtn.className = "sdate-icon-btn";
  mdateIconBtn.type = "button";
  mdateIconBtn.title = "Pick date";
  mdateIconBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;

  const mdateInput = document.createElement("input");
  mdateInput.type = "text";
  mdateInput.className = "sdate-hidden";

  const maturityDetails = computeRepoMaturityDetails(currentPortfolio);

  mdateFp = flatpickr(mdateInput, {
    defaultDate: t3mStr,
    minDate: t2Str,
    dateFormat: "Y-m-d",
    disable: [ function(date) { return (date.getDay() === 0 || date.getDay() === 6); } ],
    onDayCreate: function(dObj, dStr, fp, dayElem) {
      const entries = maturityDetails.get(toInputDate(dayElem.dateObj)) || [];
      const count = entries.length;
      if (count > 0) {
        const tier = Math.min(count, 3);
        dayElem.classList.add("maturity-heat", `maturity-heat-${tier}`);

        const header =
          `<div class="maturity-tooltip-row maturity-tooltip-header">` +
            `<span class="mt-name">Instrument</span>` +
            `<span class="mt-notional">Notional</span>` +
            `<span class="mt-mv">Market Value</span>` +
          `</div>`;
        const tooltipHtml = header + entries.map(e =>
          `<div class="maturity-tooltip-row">` +
            `<span class="mt-name">${escHtml(e.name)}</span>` +
            `<span class="mt-notional">${formatNum(e.notional)}</span>` +
            `<span class="mt-mv">${formatNum(Math.round(Math.abs(e.market_value)))}</span>` +
          `</div>`
        ).join("");
        dayElem.addEventListener("mouseenter", () => showMaturityTooltip(dayElem, tooltipHtml));
        dayElem.addEventListener("mouseleave", hideMaturityTooltip);
      }
    },
    onReady: function(selectedDates, dateStr, instance) {
      const legend = document.createElement("div");
      legend.className = "maturity-legend";
      legend.innerHTML =
        `<span class="maturity-legend-item"><span class="maturity-swatch maturity-heat-1"></span>1 repo maturing</span>` +
        `<span class="maturity-legend-item"><span class="maturity-swatch maturity-heat-2"></span>2 repos maturing</span>` +
        `<span class="maturity-legend-item"><span class="maturity-swatch maturity-heat-3"></span>3+ repos maturing</span>`;
      instance.calendarContainer.appendChild(legend);
    },
    onChange: function(selectedDates, dateStr) {
      currentMdate = dateStr;
      draftTrade.mdate = dateStr;
      mdateDisplay.textContent = fmtSdate(dateStr);
      syncDraftTrade();
    },
    onClose: function() {
      hideMaturityTooltip();
    }
  });

  mdateIconBtn.addEventListener("click", () => {
    mdateFp.open();
  });

  mdateDisplay.textContent = fmtSdate(t3mStr);
  mdateContainer.appendChild(mdateDisplay);
  mdateContainer.appendChild(mdateIconBtn);
  mdateContainer.appendChild(mdateInput);
  mdateTd.appendChild(mdateContainer);
  tr.appendChild(mdateTd);

  // Reason — dropdown
  const reasonTd = document.createElement("td");
  const reasonSelect = document.createElement("select");
  reasonSelect.className = "trade-select";
  const reasonOptions = [["", "Reason…"], ["repo", "Repo"], ["repo_rollover", "Repo Rollover"]];
  if (betaMode) {
    reasonOptions.push(["trs_receiver", "TRS Receiver"], ["trs_payer", "TRS Payer"]);
  }
  reasonOptions.forEach(([val, label]) => {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = label;
    if (val === "repo") opt.selected = true; // Default to Repo
    reasonSelect.appendChild(opt);
  });
  reasonSelect.addEventListener("change", () => {
    const reason = reasonSelect.value;
    if (reason.startsWith("trs_")) {
      const bondNotional = bond.positions.find(p => p.type === "bond")?.notional || 0;
      const trsNotional = reason === "trs_receiver" ? bondNotional : -bondNotional;
      notionalInput.value = formatInputNum(trsNotional);
      mvInput.value = formatInputNum(Math.round(trsNotional * dirtyPrice / 100));
    } else if (reason === "repo" || reason === "repo_rollover") {
      notionalInput.value = formatInputNum(t2Notional);
      mvInput.value = formatInputNum(Math.round(-(t2Notional * dirtyPrice / 100)));
    }
    updateTypeBadge(notionalInput.value);
    syncDraftTrade();
  });
  reasonTd.appendChild(reasonSelect);
  tr.appendChild(reasonTd);

  // Remove button
  const removeTd = document.createElement("td");
  const removeBtn = document.createElement("button");
  removeBtn.className = "remove-btn";
  removeBtn.title = "Remove";
  removeBtn.innerHTML = "&#x2715;";
  removeBtn.addEventListener("click", () => {
    draftTrades.delete(tradeId);
    lastComplianceData = null; lastComplianceTime = null;
    if (complianceExpiryTimer) { clearTimeout(complianceExpiryTimer); complianceExpiryTimer = null; }
    if (complianceCountdownTimer) { clearInterval(complianceCountdownTimer); complianceCountdownTimer = null; }
    const countdownEl = document.getElementById("compliance-countdown");
    if (countdownEl) countdownEl.textContent = "";
    tr.remove();
    updateTradesCount();
    if (currentPortfolio) renderTable(currentPortfolio);
    if (document.getElementById("trades-body").children.length === 0) {
      document.getElementById("trades-panel").classList.add("hidden");
      const w = document.getElementById("short-sell-warning");
      if (w) w.classList.add("hidden");
    }
  });
  removeTd.appendChild(removeBtn);
  tr.appendChild(removeTd);

  tbody.appendChild(tr);
  updateTradesCount();
  if (currentPortfolio) renderTable(currentPortfolio);
}

function updateTradesCount() {
  const count = document.getElementById("trades-body").children.length;
  const badge = document.getElementById("trades-count");
  badge.textContent = `${count} trade${count !== 1 ? "s" : ""}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function netAvailableBook(bond, t, t0Date) {
  const bondPos = bond.positions.find((p) => p.type === "bond");
  const bondVal = posValue(bondPos);
  const repoSum = bond.positions
    .filter((p) => p.type === "repo" && t < p.repo_maturity_t)
    .reduce((sum, p) => sum + Math.abs(posValue(p)), 0);
  let orderedSum = 0;
  if (t0Date) {
    orderedTrades.filter(o => o.isin === bond.isin && !(o.reason || "").startsWith("trs_")).forEach(o => {
      const s_t = tOffset(o.sdate, t0Date);
      const m_t = tOffset(o.mdate, t0Date);
      if (s_t !== -1 && t >= s_t && (m_t === -1 || t < m_t)) {
        orderedSum += displayMode === "notional" ? Math.abs(o.notional) : Math.abs(o.market_value);
      }
    });
  }
  return bondVal - repoSum - orderedSum;
}

function netAvailable(bond, t, t0Date) {
  const bondPos = bond.positions.find((p) => p.type === "bond");
  let bondVal = posValue(bondPos);

  // Let's keep original math.
  let originalRepoSum = bond.positions
    .filter((p) => p.type === "repo" && t < p.repo_maturity_t)
    .reduce((sum, p) => sum + Math.abs(posValue(p)), 0);

  let draftSum = 0;
  if (t0Date) {
    const drafts = Array.from(draftTrades.values()).filter(d => d.isin === bond.isin && !(d.reason || "").startsWith("trs_"));
    drafts.forEach(draft => {
      const s_t = tOffset(draft.sdate, t0Date);
      const m_t = tOffset(draft.mdate, t0Date);
      if (s_t !== -1 && t >= s_t && (m_t === -1 || t < m_t)) {
        // A draft repo (negative notional) means we GIVE bond and RECEIVE cash.
        // It subtracts from net available bond.
        // A draft rev repo (positive notional) means we RECEIVE bond. It adds to net available bond.
        const valToApply = displayMode === "notional" ? draft.notional : draft.market_value;
        if (draft.notional < 0) {
          draftSum += Math.abs(valToApply);
        } else {
          draftSum -= Math.abs(valToApply);
        }
      }
    });
  }
  let orderedSum = 0;
  if (t0Date) {
    orderedTrades.filter(o => o.isin === bond.isin && !(o.reason || "").startsWith("trs_")).forEach(o => {
      const s_t = tOffset(o.sdate, t0Date);
      const m_t = tOffset(o.mdate, t0Date);
      if (s_t !== -1 && t >= s_t && (m_t === -1 || t < m_t)) {
        const val = displayMode === "notional" ? Math.abs(o.notional) : Math.abs(o.market_value);
        orderedSum += val;
      }
    });
  }
  return bondVal - originalRepoSum - draftSum - orderedSum;
}

function netAvailableNotional(bond, t, t0Date) {
  const bondNotional = bond.positions.find((p) => p.type === "bond").notional;
  let originalRepoSum = bond.positions
    .filter((p) => p.type === "repo" && t < p.repo_maturity_t)
    .reduce((sum, p) => sum + Math.abs(p.notional), 0);

  let draftSum = 0;
  if (t0Date) {
    const drafts = Array.from(draftTrades.values()).filter(d => d.isin === bond.isin && !(d.reason || "").startsWith("trs_"));
    drafts.forEach(draft => {
      const s_t = tOffset(draft.sdate, t0Date);
      const m_t = tOffset(draft.mdate, t0Date);
      if (s_t !== -1 && t >= s_t && (m_t === -1 || t < m_t)) {
        if (draft.notional < 0) {
          draftSum += Math.abs(draft.notional);
        } else {
          draftSum -= Math.abs(draft.notional);
        }
      }
    });
  }

  let orderedSum = 0;
  if (t0Date) {
    orderedTrades.filter(o => o.isin === bond.isin && !(o.reason || "").startsWith("trs_")).forEach(o => {
      const s_t = tOffset(o.sdate, t0Date);
      const m_t = tOffset(o.mdate, t0Date);
      if (s_t !== -1 && t >= s_t && (m_t === -1 || t < m_t)) {
        orderedSum += Math.abs(o.notional);
      }
    });
  }
  return bondNotional - originalRepoSum - draftSum - orderedSum;
}

function toggleChildren(parentTr, groupId) {
  const isExpanded = parentTr.classList.toggle("expanded");
  document.querySelectorAll(`tr[data-parent-id="${groupId}"]`).forEach((tr) => {
    tr.classList.toggle("visible", isExpanded);
  });
}

function onExpandAll() {
  document.querySelectorAll("#positions-body tr.parent-row").forEach((tr) => {
    tr.classList.add("expanded");
    const groupId = tr.dataset.groupId;
    document.querySelectorAll(`tr[data-parent-id="${groupId}"]`).forEach((child) => {
      child.classList.add("visible");
    });
  });
}

function formatNum(n) {
  if (n === 0) return "0";
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString("en-GB");
  return n < 0 ? `(${formatted})` : formatted;
}

function formatInputNum(n) {
  if (n === 0) return "0";
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString("en-GB");
  return n < 0 ? `-${formatted}` : formatted;
}

function bondTypeLabel(name) {
  const u = name.toUpperCase();
  if (u.includes("UKTI")) return { label: "INF",  cls: "inf" };
  if (u.includes("UKT"))  return { label: "IR",   cls: "ir" };
                          return { label: "CORP", cls: "corp" };
}

// Default sort order: IR, then INF, then CORP
function bondTypeRank(name) {
  const cls = bondTypeLabel(name).cls;
  return cls === "ir" ? 0 : cls === "inf" ? 1 : 2;
}

// Returns portfolio.bonds sorted per the current header sort state: the
// default is type-rank then maturity ascending; clicking a T+n column header
// instead sorts by that column's net-available value (already reflecting
// draft/ordered/confirmed trades, matching the current display mode).
function getSortedBonds(portfolio, t0Date) {
  const bonds = portfolio.bonds.slice();

  if (sortColumn === null) {
    return bonds.sort((a, b) => {
      const rankDiff = bondTypeRank(a.name) - bondTypeRank(b.name);
      if (rankDiff !== 0) return rankDiff;
      return (a.maturity_date || "").localeCompare(b.maturity_date || "");
    });
  }

  const t = sortColumn;
  const dir = sortDirection === "desc" ? -1 : 1;
  // netAvailable already branches on displayMode internally (via posValue), matching
  // how the "Draft Net Avail" row calls it unconditionally elsewhere in this file.
  return bonds.sort((a, b) => (netAvailable(a, t, t0Date) - netAvailable(b, t, t0Date)) * dir);
}

function escHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function toInputDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}



// Returns a "T+N" string by counting business days from t0 to the given date string
function businessDaysFromT0(dateStr, t0Date) {
  if (!dateStr) return "";
  // Parse selected date in local time
  const [y, mo, d] = dateStr.split("-").map(Number);
  const sel = new Date(y, mo - 1, d);
  const dow = sel.getDay();
  if (dow === 0 || dow === 6) return "Non-business day";

  const t0 = new Date(
    t0Date.getFullYear(),
    t0Date.getMonth(),
    t0Date.getDate()
  );

  if (sel < t0) return "";
  if (sel.getTime() === t0.getTime()) return "T+0";

  let count = 0;
  const cursor = new Date(t0);
  while (cursor < sel) {
    cursor.setDate(cursor.getDate() + 1);
    const cDow = cursor.getDay();
    if (cDow !== 0 && cDow !== 6) count++;
  }
  return `T+${count}`;
}

// Helper to convert date string to T+ offset integer (returns -1 if invalid or weekend)
function tOffset(dateStr, t0Date) {
  const label = businessDaysFromT0(dateStr, t0Date);
  if (label.startsWith("T+")) return parseInt(label.substring(2), 10);
  return -1;
}

// Maps calendar date string -> [{name, notional, market_value}, ...] of repo positions maturing that day
function computeRepoMaturityDetails(portfolio) {
  let maxT = 0;
  portfolio.bonds.forEach(b => b.positions.forEach(p => {
    if (p.type === "repo") maxT = Math.max(maxT, p.repo_maturity_t || 0);
  }));
  const dates = getBusinessDates(maxT + 1);
  const details = new Map();
  portfolio.bonds.forEach(b => {
    b.positions.forEach(p => {
      if (p.type !== "repo") return;
      const key = toInputDate(dates[p.repo_maturity_t]);
      if (!details.has(key)) details.set(key, []);
      details.get(key).push({ name: b.name, notional: p.notional, market_value: p.market_value });
    });
  });
  return details;
}

// Single shared tooltip element, appended to <body> so it escapes Flatpickr's
// own overflow:hidden day-container (used to mask month-slide animations) —
// a tooltip positioned as a descendant of a day cell gets clipped to it.
let maturityTooltipEl = null;

function showMaturityTooltip(anchorEl, html) {
  if (!maturityTooltipEl) {
    maturityTooltipEl = document.createElement("div");
    maturityTooltipEl.className = "maturity-tooltip";
    document.body.appendChild(maturityTooltipEl);
  }
  maturityTooltipEl.innerHTML = html;
  maturityTooltipEl.style.display = "block";

  const rect = anchorEl.getBoundingClientRect();
  const tRect = maturityTooltipEl.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - tRect.width / 2;
  left = Math.max(4, Math.min(left, window.innerWidth - tRect.width - 4));
  let top = rect.bottom + 4;
  if (top + tRect.height > window.innerHeight - 4) {
    top = rect.top - tRect.height - 4;
  }
  maturityTooltipEl.style.left = `${left}px`;
  maturityTooltipEl.style.top = `${top}px`;
}

function hideMaturityTooltip() {
  if (maturityTooltipEl) maturityTooltipEl.style.display = "none";
}

// ── Compliance ──────────────────────────────────────────────────────────────

function onSendTrade() {
  if (!currentPortfolio || draftTrades.size === 0) return;

  const btn = document.getElementById("send-trade-btn");
  btn.disabled = true;
  btn.textContent = "Sending…";

  // Collect all approved counterparties (toggled Yes) — dealer picks from this list
  const approvedCounterparties = Array.from(
    document.querySelectorAll("#counterparty-results-body .tradeable-toggle")
  )
    .filter(b => b.textContent.trim() === "Yes")
    .map(b => b.closest("tr")?.cells[0]?.textContent.trim())
    .filter(Boolean);

  const trades = Array.from(draftTrades.values()).map(d => ({
    id: d.id,
    isin: d.isin,
    bond_name: (portfolioData.find(p => p.id === currentPortfolio.id)?.bonds
      .find(b => b.isin === d.isin)?.name) || d.isin,
    notional: d.notional,
    market_value: d.market_value,
    approved_counterparties: approvedCounterparties,
    sdate: d.sdate,
    mdate: d.mdate,
    reason: d.reason || "repo",
  }));

  // Bonds with a draft in this batch, in case the request fails and we need to roll back
  const draftIsins = [...new Set(trades.map(t => t.isin))];
  const sentAt = new Date().toISOString();
  const optimisticTrades = trades.map(t => ({
    ...t,
    counterparty: "",
    status: "ordered",
    sent_at: sentAt,
  }));
  const optimisticIds = new Set(optimisticTrades.map(t => t.id));

  // Render immediately as "Working" so the send has a visible in-flight stage
  orderedTrades = orderedTrades.concat(optimisticTrades);
  draftTrades.clear();
  lastComplianceData = null;
  lastComplianceTime = null;
  if (complianceExpiryTimer) clearTimeout(complianceExpiryTimer);
  if (complianceCountdownTimer) clearInterval(complianceCountdownTimer);

  document.getElementById("compliance-overlay").classList.add("hidden");
  document.getElementById("trades-panel").classList.add("hidden");
  document.getElementById("trades-body").innerHTML = "";
  updateTradesCount();

  renderSentTradesBlotter(orderedTrades);
  if (currentPortfolio) renderTable(currentPortfolio);
  openDrawer();

  const MIN_WORKING_MS = 700;
  Promise.all([
    fetch("/api/send-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ portfolio_id: currentPortfolio.id, trades }),
    }).then(r => r.json()),
    new Promise(resolve => setTimeout(resolve, MIN_WORKING_MS)),
  ])
    .then(([data]) => {
      orderedTrades = data.sent_trades || [];
      // Keep portfolioData in sync so switching portfolios and back doesn't
      // clobber orderedTrades with a stale snapshot (onPortfolioChange reads
      // sent_trades off portfolioData, not the live orderedTrades variable).
      const pd = portfolioData.find(p => p.id === currentPortfolio.id);
      if (pd) pd.sent_trades = orderedTrades;
      const results = data.results || [];

      renderSentTradesBlotter(orderedTrades);
      if (currentPortfolio) renderTable(currentPortfolio);

      // Rejected trades go back into the draft panel for redraft
      results.filter(r => r.status === "rejected").forEach(r => {
        const bond = currentPortfolio.bonds.find(b => b.isin === r.isin);
        if (bond) addTradeRow(bond);
      });

      // If any confirmed trade already settles as of today, refresh holdings
      const t0Date = getBusinessDates(1)[0];
      const needsRefresh = results.some(r => {
        if (r.status !== "confirmed") return false;
        const [y, mo, d] = r.sdate.split("-").map(Number);
        return new Date(y, mo - 1, d) <= t0Date;
      });
      if (needsRefresh) {
        fetch("/api/portfolios").then(r => r.json()).then(pdata => {
          portfolioData = pdata.portfolios;
          currentPortfolio = portfolioData.find(p => p.id === currentPortfolio.id);
          orderedTrades = currentPortfolio.sent_trades || [];
          renderSentTradesBlotter(orderedTrades);
          renderTable(currentPortfolio);
        });
      }
    })
    .catch(err => {
      alert("Send failed: " + err.message);
      // Roll back the optimistic "Working" rows and let the PM redraft
      orderedTrades = orderedTrades.filter(o => !optimisticIds.has(o.id));
      renderSentTradesBlotter(orderedTrades);
      if (currentPortfolio) renderTable(currentPortfolio);
      draftIsins.forEach(isin => {
        const bond = currentPortfolio.bonds.find(b => b.isin === isin);
        if (bond) addTradeRow(bond);
      });
      btn.disabled = false;
      btn.textContent = "Send Trade";
    });
}

function sentTradeStatusBadge(t) {
  switch (t.status) {
    case "confirmed":
      return `<span class="type-badge type-confirmed">Confirmed</span>`;
      // + (t.dealer_commentary ? `<div class="blotter-commentary">${escHtml(t.dealer_commentary)}</div>` : "");
    case "rejected":
      return `<span class="type-badge type-rejected">Rejected</span>`;
      // + (t.rejection_reason ? `<div class="blotter-commentary">${escHtml(t.rejection_reason)}</div>` : "");
    case "settled":
      return `<span class="type-badge type-settled">Settled</span>`;
    default:
      return `<span class="type-badge type-working">Working</span>`;
  }
}

function renderSentTradesBlotter(trades) {
  const tbody = document.getElementById("sent-trades-body");
  const count = document.getElementById("sent-trades-count");
  const badge = document.getElementById("sent-trades-badge");
  const n = trades ? trades.length : 0;
  count.textContent = `${n} trade${n !== 1 ? "s" : ""}`;
  badge.textContent = n;
  tbody.innerHTML = "";
  if (!trades || n === 0) return;

  trades.forEach(t => {
    const tr = document.createElement("tr");
    tr.dataset.tradeId = t.id;
    // const rateText = t.repo_rate != null ? `${t.repo_rate.toFixed(2)}%` : t.trs_fixed_rate != null ? `${t.trs_fixed_rate.toFixed(2)}%` : "—";
    const cptyDisplay = t.counterparty || (t.status === "ordered" ? "Pending" : (t.approved_counterparties || []).join(", ") || "—");
    tr.innerHTML =
      `<td>${escHtml(t.bond_name)}</td>` +
      `<td>${escHtml(cptyDisplay)}</td>` +
      `<td class="num negative">${formatNum(t.notional)}</td>` +
      `<td class="num">${formatNum(Math.round(Math.abs(t.market_value)))}</td>` +
      // `<td class="num">${rateText}</td>` +
      `<td>${escHtml(t.sdate)}</td>` +
      `<td>${escHtml(t.mdate)}</td>` +
      `<td>${sentTradeStatusBadge(t)}</td>` +
      `<td></td>`;

    tbody.appendChild(tr);
  });

}

function onRunCompliance() {
  if (!currentPortfolio || draftTrades.size === 0) return;

  // Re-open cached results if still fresh
  if (lastComplianceData && lastComplianceTime && (Date.now() - lastComplianceTime < COMPLIANCE_TTL_MS)) {
    renderComplianceResults(lastComplianceData);
    return;
  }

  const btn = document.getElementById("run-compliance-btn");
  btn.disabled = true;
  btn.textContent = "Running…";

  const trades = Array.from(draftTrades.values()).map((d) => ({
    isin: d.isin,
    notional: d.notional,
    market_value: d.market_value,
    counterparty: d.counterparty || "Unknown",
    maturity: d.mdate || "2026-01-01",
  }));

  fetch("/api/run-compliance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      portfolio_id: currentPortfolio.id,
      draft_trades: trades,
    }),
  })
    .then((r) => r.json())
    .then((data) => {
      console.log("Compliance response:", data);
      if (data.error) {
        alert("Compliance error: " + data.error);
        return;
      }
      lastComplianceData = data;
      lastComplianceTime = Date.now();
      startComplianceExpiry();
      renderComplianceResults(data);
    })
    .catch((err) => {
      console.error("Compliance check failed:", err);
      alert("Compliance check failed: " + err.message);
    })
    .finally(() => {
      btn.disabled = false;
      btn.textContent = "Run Compliance Checks";
    });
}

function startComplianceExpiry() {
  if (complianceExpiryTimer) clearTimeout(complianceExpiryTimer);
  if (complianceCountdownTimer) clearInterval(complianceCountdownTimer);

  complianceExpiryTimer = setTimeout(() => {
    if (complianceCountdownTimer) clearInterval(complianceCountdownTimer);
    lastComplianceData = null;
    lastComplianceTime = null;
    const btn = document.getElementById("send-trade-btn");
    if (btn) btn.disabled = true;
    const banner = document.getElementById("compliance-stale-banner");
    if (banner) banner.classList.remove("hidden");
    const verdictEl = document.getElementById("compliance-verdict");
    if (verdictEl) {
      verdictEl.className = "compliance-verdict verdict-fail";
      verdictEl.textContent = "Expired";
    }
    const countdown = document.getElementById("compliance-countdown");
    if (countdown) countdown.textContent = "";
  }, COMPLIANCE_TTL_MS);

  // Tick every second to update the countdown display
  complianceCountdownTimer = setInterval(() => {
    if (!lastComplianceTime) { clearInterval(complianceCountdownTimer); return; }
    const remaining = COMPLIANCE_TTL_MS - (Date.now() - lastComplianceTime);
    const countdown = document.getElementById("compliance-countdown");
    if (!countdown) return;
    if (remaining <= 0) {
      countdown.textContent = "";
      clearInterval(complianceCountdownTimer);
      return;
    }
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    const urgent = remaining < 30000;
    countdown.textContent = `Expires in ${mins}:${String(secs).padStart(2, "0")}`;
    countdown.className = `compliance-countdown ${urgent ? "countdown-urgent" : ""}`;
  }, 1000);
}

function renderComplianceResults(data) {
  const overlay = document.getElementById("compliance-overlay");
  overlay.classList.remove("hidden");

  // Reset Send Trade button each time the modal opens
  const sendBtn = document.getElementById("send-trade-btn");
  if (sendBtn) { sendBtn.textContent = "Send Trade"; sendBtn.disabled = true; }

  document.getElementById("close-compliance").onclick = () => {
    overlay.classList.add("hidden");
  };

  // Hide stale banner on fresh render
  document.getElementById("compliance-stale-banner").classList.add("hidden");
  // Reset Table 3 on each compliance run
  document.getElementById("counterparty-rules-body").innerHTML = "";
  document.getElementById("counterparty-rules-section").style.display = "none";

  const verdictEl = document.getElementById("compliance-verdict");
  if (!data.pm_override_required) {
    verdictEl.className = "compliance-verdict verdict-pass";
    verdictEl.textContent = "All Passed";
  } else {
    verdictEl.className = "compliance-verdict verdict-fail";
    verdictEl.textContent = "Override Required";
  }
  // Store so checkSendTradeEnabled can update it
  verdictEl.dataset.overrideRequired = data.pm_override_required ? "1" : "0";

  function buildRows(tbody, results, mode) {
    tbody.innerHTML = "";
    results.forEach((r) => {
      const failed = r.breached;
      const status = failed ? "failed" : "passed";
      const desc = r.description || `Rule ${r.parent_rule_id}`;

      const statusText = mode === "tradeable"
        ? (r.tradeable ? "Yes" : "No")
        : (failed ? "Breach" : "Pass");
      const badgeCls = mode === "tradeable"
        ? (r.tradeable ? "tradeable-yes" : "tradeable-no")
        : (failed ? "status-fail" : "status-pass");

      // Parent row: Rule ID | Description | Status | Override
      const parentTr = document.createElement("tr");
      parentTr.className = "compliance-row";
      parentTr.dataset.status = status;
      if (mode !== "tradeable") parentTr.style.cursor = "pointer";
      if (mode === "tradeable") {
        const cptyName = (r.child_results && r.child_results[0] && r.child_results[0].filter)
          || (r.description && r.description.split(":")[0].trim())
          || desc;
        parentTr.innerHTML =
          `<td>${escHtml(cptyName)}</td>` +
          `<td class="status-cell"></td>`;
      } else {
        parentTr.innerHTML =
          `<td class="rule-id-cell"><span class="compliance-chevron">&#9654;</span> ${r.parent_rule_id}</td>` +
          `<td>${escHtml(desc)} <span class="compliance-logic">(${escHtml(r.logic)})</span></td>` +
          `<td class="status-cell"></td>` +
          `<td class="override-cell"></td>`;
      }
      tbody.appendChild(parentTr);

      const statusCell = parentTr.querySelector(".status-cell");
      const overrideCell = parentTr.querySelector(".override-cell");

      function buildOverrideInput() {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "override-input";
        input.placeholder = "Override note…";
        input.addEventListener("click", (e) => e.stopPropagation());
        return input;
      }

      if (mode === "tradeable") {
        // Table 2: counterparty name + tradeable toggle only (no override cell)

        let tradeable = r.tradeable;
        const badge = document.createElement("span");
        badge.className = tradeable ? "tradeable-yes tradeable-toggle" : "tradeable-no tradeable-toggle";
        badge.textContent = tradeable ? "Yes" : "No";
        badge.title = "Click to toggle tradeable status";
        statusCell.appendChild(badge);

        badge.addEventListener("click", (e) => {
          e.stopPropagation();
          tradeable = !tradeable;
          badge.className = tradeable ? "tradeable-yes tradeable-toggle" : "tradeable-no tradeable-toggle";
          badge.textContent = tradeable ? "Yes" : "No";

          // When flipped No→Yes, add a rule row in Table 3. When flipped back, remove it.
          const rulesSection = document.getElementById("counterparty-rules-section");
          const rulesBody = document.getElementById("counterparty-rules-body");
          const rowId = `cpty-rule-${r.parent_rule_id}`;
          const existing = document.getElementById(rowId);

          if (tradeable && !r.tradeable) {
            if (!existing) {
              const ruleRow = document.createElement("tr");
              ruleRow.id = rowId;
              ruleRow.className = "compliance-row";
              ruleRow.dataset.status = "failed";
              const overrideInput = buildOverrideInput();
              overrideInput.addEventListener("input", checkSendTradeEnabled);
              const chevron3 = document.createElement("span");
              chevron3.className = "compliance-chevron";
              chevron3.innerHTML = "&#9654;";
              const descTd = document.createElement("td");
              descTd.appendChild(chevron3);
              descTd.appendChild(document.createTextNode(r.description || `Rule ${r.parent_rule_id}`));
              ruleRow.appendChild(document.createElement("td")).textContent = r.parent_rule_id;
              ruleRow.cells[0].className = "rule-id-cell";
              ruleRow.appendChild(descTd);
              const overrideTd = document.createElement("td");
              overrideTd.appendChild(overrideInput);
              ruleRow.appendChild(overrideTd);
              rulesBody.appendChild(ruleRow);

              // Child rows — hidden by default, toggled by clicking the rule row
              const childRows3 = [];
              (r.child_results || []).forEach(c => {
                const cTr = document.createElement("tr");
                cTr.className = "compliance-child";
                cTr.dataset.parentId = rowId;
                cTr.style.display = "none";
                const cStatus = c.breached ? "Breach" : "Pass";
                const cCls = c.breached ? "status-fail" : "status-pass";
                cTr.innerHTML =
                  `<td class="child-id-cell">${c.id}</td>` +
                  `<td class="child-detail-cell">` +
                    `<div class="child-desc">${escHtml(c.description || c.filter)}</div>` +
                    `<div class="child-values">` +
                      `<span class="child-val-label">Value:</span> <span class="child-val num">${formatNum(Math.round(c.net_value))}</span>` +
                      `<span class="child-val-label">Bounds:</span> <span class="child-val">[${formatNum(c.lower_bound)}, ${formatNum(c.upper_bound)}]</span>` +
                    `</div>` +
                  `</td>` +
                  `<td><span class="${cCls}">${cStatus}</span></td>`;
                rulesBody.appendChild(cTr);
                childRows3.push(cTr);
              });

              ruleRow.style.cursor = "pointer";
              ruleRow.addEventListener("click", (e) => {
                if (e.target.closest(".override-input")) return;
                const opening = childRows3[0] && childRows3[0].style.display === "none";
                childRows3.forEach(tr => { tr.style.display = opening ? "table-row" : "none"; });
                chevron3.classList.toggle("open", opening);
              });
            }
            rulesSection.style.display = "";
          } else {
            if (existing) {
              // Remove the rule row and its child rows
              document.querySelectorAll(`#counterparty-rules-body tr[data-parent-id="${rowId}"]`)
                .forEach(tr => tr.remove());
              existing.remove();
            }
            if (rulesBody.children.length === 0) rulesSection.style.display = "none";
          }
          checkSendTradeEnabled();
        });
      } else {
        // Static Pass/Breach badge
        const badge = document.createElement("span");
        badge.className = badgeCls;
        badge.textContent = statusText;
        statusCell.appendChild(badge);

        // Override note only shown if this rule is breached
        if (failed) {
          overrideCell.appendChild(buildOverrideInput());
        }
      }

      // Expandable child detail rows only apply to Table 1 (status mode) — Table 2
      // (tradeable mode) has its own separate expand-into-Table-3 mechanism above,
      // triggered by the Yes/No badge, not by clicking the row itself.
      if (mode !== "tradeable") {
        const detailRows = [];

        // Child rows: ID | Description + Value + Bounds | Status
        if (r.child_results) {
          r.child_results.forEach((c) => {
            const cTr = document.createElement("tr");
            cTr.className = "compliance-child";
            cTr.dataset.status = status;
            cTr.style.display = "none";
            const cStatus = c.breached ? "Breach" : "Pass";
            const cCls = c.breached ? "status-fail" : "status-pass";
            cTr.innerHTML =
              `<td class="child-id-cell">${c.id}</td>` +
              `<td class="child-detail-cell">` +
                `<div class="child-desc">${escHtml(c.description || c.filter)}</div>` +
                `<div class="child-values">` +
                  `<span class="child-val-label">Value:</span> <span class="child-val num">${formatNum(Math.round(c.net_value))}</span>` +
                  `<span class="child-val-label">Bounds:</span> <span class="child-val">[${formatNum(c.lower_bound)}, ${formatNum(c.upper_bound)}]</span>` +
                `</div>` +
              `</td>` +
              `<td><span class="${cCls}">${cStatus}</span></td>` +
              `<td></td>`;
            tbody.appendChild(cTr);
            detailRows.push(cTr);
          });
        }

        parentTr.addEventListener("click", () => {
          const opening = detailRows[0] && detailRows[0].style.display === "none";
          detailRows.forEach((dr) => {
            dr.style.display = opening ? "table-row" : "none";
          });
          parentTr.querySelector(".compliance-chevron").classList.toggle("open", opening);
        });
      }
    });
  }

  buildRows(
    document.getElementById("maturity-results-body"),
    data.maturity_results || [],
    "status"
  );
  buildRows(
    document.getElementById("counterparty-results-body"),
    data.counterparty_results || [],
    "tradeable"
  );

  // Re-evaluate send button whenever override inputs change or toggles are clicked
  document.getElementById("maturity-results-body").addEventListener("input", checkSendTradeEnabled);
  document.getElementById("counterparty-results-body").addEventListener("click", checkSendTradeEnabled);
  checkSendTradeEnabled();

  // Filter buttons
  const filterBtns = document.querySelectorAll(".filter-btn");
  filterBtns.forEach((btn) => {
    btn.onclick = () => {
      filterBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      applyComplianceFilter(btn.dataset.filter);
    };
  });
  applyComplianceFilter("all");
}

function checkSendTradeEnabled() {
  const maturityRows = document.querySelectorAll("#maturity-results-body .compliance-row");
  const maturityOk = Array.from(maturityRows).every(tr => {
    if (tr.dataset.status !== "failed") return true;
    const input = tr.querySelector(".override-input");
    return input && input.value.trim().length > 0;
  });

  // Check that every counterparty override rule row (parent rows only) has an override note
  const cptyOverrideInputs = document.querySelectorAll("#counterparty-rules-body .override-input");
  const cptyRulesOk = cptyOverrideInputs.length === 0 ||
    Array.from(cptyOverrideInputs).every(input => input.value.trim().length > 0);

  const tradeableBadges = document.querySelectorAll("#counterparty-results-body .tradeable-toggle");
  const counterpartyOk = Array.from(tradeableBadges).some(b => b.textContent.trim() === "Yes") && cptyRulesOk;

  const enabled = maturityOk && counterpartyOk;
  const btn = document.getElementById("send-trade-btn");
  if (btn) btn.disabled = !enabled;

  const verdictEl = document.getElementById("compliance-verdict");
  if (verdictEl && verdictEl.dataset.overrideRequired === "1") {
    if (enabled) {
      verdictEl.className = "compliance-verdict";
      verdictEl.textContent = "";
    } else {
      verdictEl.className = "compliance-verdict verdict-fail";
      verdictEl.textContent = "Override Required";
    }
  }
}

function applyComplianceFilter(filter) {
  // Reset all rows first
  document.querySelectorAll(".compliance-row, .compliance-child").forEach((tr) => {
    if (filter === "all" || tr.dataset.status === filter) {
      tr.classList.remove("filtered-out");
      // Parent rows visible, child rows stay hidden until expanded
      if (tr.classList.contains("compliance-row")) {
        tr.style.display = "";
      }
    } else {
      tr.classList.add("filtered-out");
      tr.style.display = "none";
      // Collapse any expanded parent
      if (tr.classList.contains("compliance-row")) {
        tr.querySelector(".compliance-chevron")?.classList.remove("open");
      }
    }
  });
  // Always hide child rows when filter changes (collapse all)
  document.querySelectorAll(".compliance-child:not(.filtered-out)").forEach((tr) => {
    tr.style.display = "none";
  });
}
