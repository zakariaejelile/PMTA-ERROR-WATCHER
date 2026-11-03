// background.js
// Two scanning paths:
//   1. Panel-URL mode (preferred, set on the options page): fetches the
//      panel page directly, finds every <iframe> on it, then fetches each
//      server's Domains page and every domain's detail page - all from the
//      background, no tab needs to be open. HTML is parsed via a hidden
//      offscreen document (service workers have no DOMParser).
//   2. Open-tab mode (fallback, used when no panel URL is configured):
//      enumerates the frames of whichever tab the popup was opened from and
//      asks each PMTA frame's content script to scan itself in place.

const OFFSCREEN_URL = "offscreen.html";
const ALARM_NAME = "pmta-auto-scan";

let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (existing && existing.length > 0) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["DOM_PARSER"],
    justification: "Parse fetched PowerMTA HTML pages outside of any open tab.",
  });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function parseViaOffscreen(op, html, baseUrl, args) {
  await ensureOffscreenDocument();
  const res = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_PARSE",
    op,
    html,
    baseUrl,
    args: args || {},
  });
  if (!res || !res.ok) {
    throw new Error((res && res.error) || "Offscreen parse failed for op " + op);
  }
  return res.result;
}

async function fetchText(url) {
  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) throw new Error("HTTP " + resp.status + " for " + url);
  return await resp.text();
}

function describeError(e) {
  return e && e.message ? e.message : String(e);
}


const HISTORY_KEY = "errorHistory";
const MAX_HISTORY = 2000; // keep last N error rows

function extractErrorIp(err, serverIp) {
  const IP_RE = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/;
  const vmta = (err && err.vmta) || "";
  const error = (err && err.error) || "";
  let m = vmta.match(IP_RE);
  if (m) return m[1];
  m = error.match(IP_RE);
  if (m) return m[1];
  return serverIp || "";
}

async function appendErrorHistory(results) {
  if (!results || !results.length) return;
  const { errorHistory } = await chrome.storage.local.get(HISTORY_KEY);
  let hist = Array.isArray(errorHistory) ? errorHistory : [];
  const now = Date.now();
  const seenKeys = new Set(hist.map((h) => h.dedupeKey).filter(Boolean));

  for (const r of results) {
    if (!r || !r.errorCount || !r.errors || !r.errors.length) continue;
    const label = r.label || {};
    const serverName = label.id || "(unknown)";
    const serverIp = label.ip || "";
    for (const e of r.errors) {
      const errorIp = extractErrorIp(e, serverIp);
      const dedupeKey = [serverName, errorIp, e.domain || "", e.vmta || "", e.time || "", e.error || ""].join("|");
      // Skip if we already stored this exact error (same content)
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);
      hist.push({
        server: serverName,
        ip: serverIp,
        errorIp,
        origin: r.origin || "",
        domain: e.domain || "",
        vmta: e.vmta || "",
        time: e.time || "",
        error: e.error || "",
        seenAt: now,
        dedupeKey,
      });
    }
  }

  // Cap size — keep newest
  if (hist.length > MAX_HISTORY) {
    hist = hist.slice(hist.length - MAX_HISTORY);
  }
  await chrome.storage.local.set({ [HISTORY_KEY]: hist });
}


function dedupeErrors(errors) {
  const seen = new Set();
  return (errors || []).filter((e) => {
    if (!e.vmta && !e.error) return false;
    const key = [e.domain || "", e.vmta || "", e.time || "", e.error || ""].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---- panel-URL scanning path ------------------------------------------

async function scanServerByUrl(frameUrl, captionHint) {
  const result = {
    origin: null,
    label: { id: captionHint || null, ip: null, host: null },
    errors: [],
    errorCount: 0,
    fetchError: null,
  };
  try {
    result.origin = new URL(frameUrl).origin;
  } catch (e) {
    result.origin = frameUrl;
  }

  let homeHtml;
  try {
    homeHtml = await fetchText(frameUrl);
  } catch (e) {
    result.fetchError = "Failed to load server page: " + describeError(e);
    return result;
  }

  try {
    const label = await parseViaOffscreen("extractServerLabel", homeHtml, frameUrl, {});
    result.label = {
      id: label.id || captionHint || null,
      ip: label.ip,
      host: label.host,
    };
  } catch (e) {
    // Label is cosmetic only
  }

  let domainsHref;
  try {
    domainsHref = await parseViaOffscreen("findNavHref", homeHtml, frameUrl, { label: "Domains" });
  } catch (e) {
    result.fetchError = "Failed to parse server page: " + describeError(e);
    return result;
  }
  if (!domainsHref) {
    result.fetchError = 'Could not find a "Domains" tab link on this server.';
    return result;
  }

  let listHtml;
  try {
    listHtml = await fetchText(domainsHref);
  } catch (e) {
    result.fetchError = "Failed to load Domains page: " + describeError(e);
    return result;
  }

  let errors = [];
  try {
    const listErrors = await parseViaOffscreen("parseErrorsTable", listHtml, domainsHref, {});
    errors = listErrors.map((e) => ({ ...e, domain: e.domain || null }));
  } catch (e) {
    // non-fatal
  }

  // Domains LIST "Last Error" column (Name | #Rcpt | ... | Last Error)
  try {
    const colErrors = await parseViaOffscreen(
      "parseDomainsListLastErrors",
      listHtml,
      domainsHref,
      {}
    );
    errors = errors.concat(colErrors || []);
  } catch (e) {
    // non-fatal
  }

  let domainLinks = [];
  try {
    domainLinks = await parseViaOffscreen("findDomainLinks", listHtml, domainsHref, {});
  } catch (e) {
    domainLinks = [];
  }

  for (const link of domainLinks) {
    try {
      const dHtml = await fetchText(link);
      const detail = await parseViaOffscreen("parseDomainDetail", dHtml, link, {});
      const dErrors = await parseViaOffscreen("parseErrorsTable", dHtml, link, {});
      const domainName = (detail && detail.name) || null;
      errors = errors.concat(
        (dErrors || []).map((e) => ({ ...e, domain: domainName || e.domain || null }))
      );
      try {
        const dList = await parseViaOffscreen("parseDomainsListLastErrors", dHtml, link, {});
        errors = errors.concat(
          (dList || []).map((e) => ({ ...e, domain: domainName || e.domain || null }))
        );
      } catch (e2) {
        /* ignore */
      }
    } catch (e) {
      errors.push({
        vmta: "",
        time: "",
        error: "(failed to read domain page " + link + ": " + describeError(e) + ")",
        domain: null,
      });
    }
  }

  result.errors = dedupeErrors(errors);
  result.errorCount = result.errors.length;
  return result;
}

async function scanViaPanelUrl(panelUrl) {
  let panelHtml;
  try {
    panelHtml = await fetchText(panelUrl);
  } catch (e) {
    const payload = {
      time: Date.now(),
      mode: "panelUrl",
      results: [],
      error: "Failed to load panel URL: " + describeError(e),
    };
    await chrome.storage.local.set({ lastScan: payload });
    return payload;
  }

  let frames = [];
  try {
    frames = await parseViaOffscreen("findFrameLinks", panelHtml, panelUrl, {});
  } catch (e) {
    const payload = {
      time: Date.now(),
      mode: "panelUrl",
      results: [],
      error: "Failed to parse panel page: " + describeError(e),
    };
    await chrome.storage.local.set({ lastScan: payload });
    return payload;
  }

  const results = [];
  for (const f of frames) {
    results.push(await scanServerByUrl(f.url, f.caption));
  }

  const payload = { time: Date.now(), mode: "panelUrl", results };
  await chrome.storage.local.set({ lastScan: payload });
  updateBadge(results);
  try { await appendErrorHistory(results); } catch (e) { /* non-fatal */ }
  return payload;
}

// ---- open-tab scanning path (fallback) ---------------------------------

async function scanAllFrames(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const innerFrames = (frames || []).filter((f) => f.frameId !== 0);

  const results = [];
  for (const f of innerFrames) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: "SCAN_FRAME" }, { frameId: f.frameId });
      if (res) results.push(res);
    } catch (e) {
      // not a PMTA frame
    }
  }

  const payload = { time: Date.now(), mode: "openTab", results };
  await chrome.storage.local.set({ lastScan: payload });
  updateBadge(results);
  try { await appendErrorHistory(results); } catch (e) { /* non-fatal */ }
  return payload;
}

function updateBadge(results) {
  const totalErrors = results.reduce((sum, r) => sum + (r.errorCount || 0), 0);
  chrome.action.setBadgeText({ text: totalErrors ? String(totalErrors) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#b00020" });
}

// ---- message routing -----------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "SCAN_ALL") {
    (async () => {
      try {
        const { panelUrl } = await chrome.storage.local.get("panelUrl");
        const payload = panelUrl ? await scanViaPanelUrl(panelUrl) : await scanAllFrames(msg.tabId);
        sendResponse(payload);
      } catch (e) {
        sendResponse({ time: Date.now(), results: [], error: describeError(e) });
      }
    })();
    return true;
  }

  if (msg.type === "TEST_PANEL_URL") {
    (async () => {
      try {
        const html = await fetchText(msg.panelUrl);
        const frames = await parseViaOffscreen("findFrameLinks", html, msg.panelUrl, {});
        sendResponse({ ok: true, frameCount: frames.length, frames });
      } catch (e) {
        sendResponse({ ok: false, error: describeError(e) });
      }
    })();
    return true;
  }

  if (msg.type === "CLEAR_SCAN") {
    (async () => {
      await chrome.storage.local.remove("lastScan");
      chrome.action.setBadgeText({ text: "" });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "CLEAR_HISTORY") {
    (async () => {
      await chrome.storage.local.remove("errorHistory");
      sendResponse({ ok: true });
    })();
    return true;
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  (async () => {
    const { panelUrl } = await chrome.storage.local.get("panelUrl");
    if (panelUrl) await scanViaPanelUrl(panelUrl);
  })();
});

async function applyAlarmSetting() {
  const { scanIntervalMinutes } = await chrome.storage.local.get("scanIntervalMinutes");
  await chrome.alarms.clear(ALARM_NAME);
  if (scanIntervalMinutes && Number(scanIntervalMinutes) > 0) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: Number(scanIntervalMinutes) });
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.scanIntervalMinutes) {
    applyAlarmSetting();
  }
});

applyAlarmSetting();
