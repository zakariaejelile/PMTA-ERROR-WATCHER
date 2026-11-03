const scanBtn = document.getElementById("scanBtn");
const clearBtn = document.getElementById("clearBtn");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");
const settingsBtn = document.getElementById("settingsBtn");
const liveBtn = document.getElementById("liveBtn");
const historyBtn = document.getElementById("historyBtn");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const filterBar = document.getElementById("filterBar");
const filterInput = document.getElementById("filterInput");
const summaryEl = document.getElementById("summary");
const viewHint = document.getElementById("viewHint");

// In-memory state
let currentResults = [];
let historyRows = []; // flat error rows from storage
let currentFilter = "";
let viewMode = "live"; // "live" | "history"

const IP_RE = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/;

scanBtn.addEventListener("click", runScan);
clearBtn.addEventListener("click", clearResults);
clearHistoryBtn.addEventListener("click", clearHistory);
settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
liveBtn.addEventListener("click", () => switchView("live"));
historyBtn.addEventListener("click", () => switchView("history"));
filterInput.addEventListener("input", () => {
  currentFilter = filterInput.value.trim();
  if (viewMode === "live") renderLive(currentResults);
  else renderHistory(historyRows);
});
document.addEventListener("DOMContentLoaded", async () => {
  await loadLastScan();
  await loadHistory();
});

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : null;
}

async function runScan() {
  scanBtn.disabled = true;
  setStatus("Scanning open PMTA servers...");
  try {
    const tabId = await getActiveTabId();
    if (!tabId) {
      setStatus("No active tab found.");
      return;
    }
    const res = await chrome.runtime.sendMessage({ type: "SCAN_ALL", tabId });
    if (res.error) {
      setStatus("Scan failed: " + res.error);
      currentResults = res.results || [];
      switchView("live");
      renderLive(currentResults);
      return;
    }
    currentResults = res.results || [];
    currentFilter = "";
    filterInput.value = "";
    switchView("live");
    renderLive(currentResults);
    setStatus(formatStatus(res));
    // history is appended in background; refresh local copy
    await loadHistory();
  } finally {
    scanBtn.disabled = false;
  }
}

async function clearResults() {
  clearBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "CLEAR_SCAN" });
    currentResults = [];
    currentFilter = "";
    filterInput.value = "";
    if (viewMode === "live") {
      resultsEl.innerHTML = "";
      summaryEl.classList.remove("visible");
      summaryEl.textContent = "";
      filterBar.classList.remove("visible");
      viewHint.classList.remove("visible");
      setStatus("No scan yet");
    }
  } finally {
    clearBtn.disabled = false;
  }
}

async function clearHistory() {
  if (!confirm("Clear all stored error history? This cannot be undone.")) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_HISTORY" });
  historyRows = [];
  if (viewMode === "history") {
    renderHistory([]);
    setStatus("History cleared");
  }
}

async function loadLastScan() {
  const { lastScan } = await chrome.storage.local.get("lastScan");
  if (lastScan) {
    currentResults = lastScan.results || [];
    if (viewMode === "live") {
      renderLive(currentResults);
      setStatus(formatStatus(lastScan));
    }
  } else {
    if (viewMode === "live") {
      setStatus('No scan yet - open your multi-server panel tab, then click "Scan Now".');
    }
  }
}

async function loadHistory() {
  const { errorHistory } = await chrome.storage.local.get("errorHistory");
  historyRows = Array.isArray(errorHistory) ? errorHistory : [];
  if (viewMode === "history") renderHistory(historyRows);
}

async function switchView(mode) {
  viewMode = mode;
  liveBtn.classList.toggle("active", mode === "live");
  historyBtn.classList.toggle("active", mode === "history");
  clearBtn.style.display = mode === "live" ? "" : "none";
  clearHistoryBtn.style.display = mode === "history" ? "" : "none";
  scanBtn.style.display = mode === "live" ? "" : "none";

  if (mode === "live") {
    renderLive(currentResults);
    const { lastScan } = await chrome.storage.local.get("lastScan");
    if (lastScan) setStatus(formatStatus(lastScan));
    else setStatus('No scan yet - open your multi-server panel tab, then click "Scan Now".');
  } else {
    await loadHistory();
    renderHistory(historyRows);
    setStatus(
      historyRows.length
        ? `Error history — ${historyRows.length} stored error(s)`
        : "Error history is empty — run a scan to start collecting."
    );
  }
}

function formatStatus(res) {
  const total = (res.results || []).reduce((s, r) => s + (r.errorCount || 0), 0);
  const time = new Date(res.time).toLocaleTimeString();
  const serverCount = (res.results || []).length;
  const modeLabel =
    res.mode === "panelUrl" ? "via panel URL" : res.mode === "openTab" ? "via open tab" : null;
  const modeSuffix = modeLabel ? ` (${modeLabel})` : "";
  return `Last scan ${time}${modeSuffix} - ${serverCount} server(s) checked, ${total} error(s) found`;
}

function setStatus(text) {
  statusEl.textContent = text;
}

/**
 * Prefer the IP that actually had the error:
 * 1) IP embedded in VMTA name (e.g. gmail-51.68.148.19)
 * 2) First IP found in the error text
 * 3) Fall back to the server monitor IP
 */
function extractErrorIp(err, serverIp) {
  const vmta = (err && err.vmta) || "";
  const error = (err && err.error) || "";

  // VMTA often ends with -x.x.x.x or is the IP itself
  let m = vmta.match(IP_RE);
  if (m) return m[1];

  m = error.match(IP_RE);
  if (m) return m[1];

  return serverIp || "";
}

function buildSearchText(row) {
  return [
    row.server,
    row.ip,
    row.errorIp,
    row.origin,
    row.domain,
    row.vmta,
    row.time,
    row.error,
    row.seenAt || "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function matchesFilter(row) {
  if (!currentFilter) return true;
  return buildSearchText(row).includes(currentFilter.toLowerCase());
}

function renderLive(results) {
  resultsEl.innerHTML = "";
  viewHint.textContent =
    "IP column = IP tied to each error (from VMTA / error text). Server column = PMTA box name.";
  viewHint.classList.add("visible");

  if (!results || results.length === 0) {
    filterBar.classList.remove("visible");
    summaryEl.classList.remove("visible");
    resultsEl.innerHTML =
      '<div id="empty">No PMTA servers were found.<br><br>' +
      "If you've set a panel URL in Settings (⚙), double-check it with \"Test Connection\" there. " +
      "Otherwise, make sure the tab with your multi-server panel is active, then click \"Scan Now\".</div>";
    return;
  }

  filterBar.classList.add("visible");

  const flatRows = [];
  let serversWithErrors = 0;
  let serversOk = 0;
  let serversFailed = 0;
  let totalErrors = 0;

  const sorted = [...results].sort((a, b) => (b.errorCount || 0) - (a.errorCount || 0));

  for (const r of sorted) {
    const label = r.label || {};
    const serverName = label.id || "(unknown)";
    const serverIp = label.ip || "";
    const origin = r.origin || "";

    if (r.fetchError) {
      serversFailed++;
      const row = {
        type: "fetch-error",
        server: serverName,
        ip: serverIp,
        errorIp: serverIp,
        origin,
        domain: "",
        vmta: "",
        time: "",
        error: "Could not read this server: " + r.fetchError,
      };
      if (matchesFilter(row)) flatRows.push(row);
      continue;
    }

    if (!r.errorCount || r.errorCount === 0) {
      serversOk++;
      const row = {
        type: "ok",
        server: serverName,
        ip: serverIp,
        errorIp: "",
        origin,
        domain: "",
        vmta: "",
        time: "",
        error: "No errors found",
      };
      if (matchesFilter(row)) flatRows.push(row);
      continue;
    }

    serversWithErrors++;
    totalErrors += r.errorCount;
    for (const e of r.errors || []) {
      const errorIp = extractErrorIp(e, serverIp);
      const row = {
        type: "error",
        server: serverName,
        ip: serverIp,
        errorIp,
        origin,
        domain: e.domain || "",
        vmta: e.vmta || "",
        time: e.time || "",
        error: e.error || "",
      };
      if (matchesFilter(row)) flatRows.push(row);
    }
  }

  const filterNote = currentFilter
    ? ` · showing ${flatRows.length} matching row(s) for "${currentFilter}"`
    : "";
  summaryEl.textContent =
    `${serversWithErrors} of ${results.length} server(s) have errors` +
    (totalErrors ? ` (${totalErrors} total)` : "") +
    (serversOk ? ` · ${serversOk} OK` : "") +
    (serversFailed ? ` · ${serversFailed} unreachable` : "") +
    filterNote;
  summaryEl.classList.add("visible");

  if (flatRows.length === 0) {
    resultsEl.innerHTML =
      '<div id="empty">' +
      (currentFilter
        ? "No rows match the filter. Clear the search box to see everything."
        : "No rows to display.") +
      "</div>";
    return;
  }

  renderTable(flatRows, { showSeenAt: false });
}

function renderHistory(rows) {
  resultsEl.innerHTML = "";
  viewHint.textContent =
    "Stored errors from past scans. Each row keeps the error IP, server, and when it was first stored.";
  viewHint.classList.add("visible");
  filterBar.classList.add("visible");

  const filtered = (rows || []).filter(matchesFilter);

  summaryEl.textContent = currentFilter
    ? `${filtered.length} of ${rows.length} history row(s) match "${currentFilter}"`
    : `${rows.length} stored error(s)`;
  summaryEl.classList.add("visible");

  if (!filtered.length) {
    resultsEl.innerHTML =
      '<div id="empty">' +
      (rows.length === 0
        ? "No history yet. Run a scan — errors are saved automatically."
        : "No rows match the filter.") +
      "</div>";
    return;
  }

  // Newest first
  const sorted = [...filtered].sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0));
  renderTable(sorted, { showSeenAt: true });
}

function renderTable(flatRows, opts) {
  const showSeenAt = opts && opts.showSeenAt;
  const table = document.createElement("table");
  table.className = "errors-table";
  const thead = document.createElement("thead");
  thead.innerHTML =
    "<tr>" +
    "<th>Server</th>" +
    "<th>Error IP</th>" +
    "<th>Domain</th>" +
    "<th>VMTA</th>" +
    "<th>Time</th>" +
    (showSeenAt ? "<th>Logged</th>" : "") +
    "<th>Error</th>" +
    "</tr>";
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of flatRows) {
    const tr = document.createElement("tr");
    if (row.type === "fetch-error") tr.className = "fetch-error";
    else if (row.type === "ok") tr.className = "no-errors";

    const logged = row.seenAt ? new Date(row.seenAt).toLocaleString() : "";

    tr.innerHTML =
      `<td class="server-cell" title="${escapeHtml(row.origin || "")}">${escapeHtml(
        row.server || ""
      )}</td>` +
      `<td class="ip-cell">${escapeHtml(row.errorIp || row.ip || "")}</td>` +
      `<td>${escapeHtml(row.domain || "")}</td>` +
      `<td>${escapeHtml(row.vmta || "")}</td>` +
      `<td>${escapeHtml(row.time || "")}</td>` +
      (showSeenAt ? `<td>${escapeHtml(logged)}</td>` : "") +
      `<td class="error-cell">${escapeHtml(row.error || "")}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  resultsEl.appendChild(table);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
