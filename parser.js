// parser.js
// Pure HTML-parsing helpers shared by content.js (runs inside a live PMTA
// frame, current-tab mode) and offscreen.js (runs inside a hidden offscreen
// document, panel-URL mode). Both environments have `document`/`DOMParser`,
// so the same code works in either place - this file just attaches
// everything to a shared `PmtaParser` global instead of using ES modules,
// since content scripts can't import modules directly.
//
// No chrome.* calls in this file - keep it pure so it can be unit-tested
// outside the extension (e.g. under Node + jsdom) without any mocking.

(function (global) {
  "use strict";

  // ---- detection -----------------------------------------------------

  // A frame/page "looks like" a PowerMTA monitor box if its visible text
  // mentions PowerMTA plus two of the tabs every box has.
  function looksLikePmtaFrame(doc) {
    const text = doc.body ? doc.body.textContent || "" : "";
    return /PowerMTA/i.test(text) && /Domains/i.test(text) && /Queues/i.test(text);
  }

  // ---- nav / links -----------------------------------------------------

  // `baseUrl` is required whenever `doc` came from DOMParser/fetch rather
  // than being the live page - a parsed document has no real location of
  // its own, so relative hrefs must be resolved explicitly against the URL
  // they were fetched from, not against whatever page happens to be open.
  function resolveUrl(href, baseUrl) {
    if (!href) return null;
    try {
      return new URL(href, baseUrl || undefined).href;
    } catch (e) {
      return baseUrl ? null : href; // last resort: return as-is
    }
  }

  function findNavHref(doc, label, baseUrl) {
    const links = Array.from(doc.querySelectorAll("a[href]"));
    const norm = label.toLowerCase();
    const match = links.find((a) => a.textContent.trim().toLowerCase() === norm);
    if (!match) return null;
    return resolveUrl(match.getAttribute("href"), baseUrl);
  }

  // Finds every <iframe>/<frame> on a "MultiPMTA"-style panel page - one per
  // PMTA server box - and resolves each src to an absolute URL. Also grabs
  // whatever caption text sits just above/around the frame (the grey title
  // bar in the screenshots, e.g. "(24) [ 241904 ] - s_vms1_10048"), purely
  // as a friendlier label to show before the frame's own page has loaded.
  // Skips non-PMTA iframes (e.g. "Run Cmds" portals on unrelated hosts/ports).
  function findFrameLinks(doc, baseUrl) {
    const frameEls = Array.from(doc.querySelectorAll("iframe[src], frame[src]"));
    const seen = new Set();
    const out = [];
    for (const el of frameEls) {
      const raw = el.getAttribute("src");
      if (!raw || /^javascript:/i.test(raw)) continue;
      const abs = resolveUrl(raw, baseUrl);
      if (!abs || seen.has(abs)) continue;
      // Skip obvious non-PMTA embeds (deploy/run-cmd portals, etc.)
      if (/\/deploy\/|\/run\/commands|runcmd/i.test(abs)) continue;
      try {
        const u = new URL(abs);
        // PMTA monitor boxes are typically on :8181 (or similar) with /pmta path
        // Keep anything that looks like a monitor; drop unrelated admin UIs.
        if (u.port === "90" && !/pmta/i.test(u.pathname + u.search)) continue;
      } catch (e) {
        /* keep */
      }
      seen.add(abs);
      out.push({ url: abs, caption: guessCaption(el) });
    }
    return out;
  }

  // Walks a few ancestors/previous-siblings up from a frame looking for a
  // short line of text that looks like a box title (contains a bracketed
  // number or "s_..." id), so the popup can show something before the
  // frame's own page has been fetched.
  function guessCaption(el) {
    let node = el;
    for (let hops = 0; hops < 6 && node; hops++) {
      node = node.previousElementSibling || node.parentElement;
      if (!node) break;
      const text = (node.textContent || "").trim();
      if (text && text.length < 200 && /s_[a-z0-9_]+|\[\s*\d+\s*\]/i.test(text)) {
        return text.split("\n")[0].trim();
      }
    }
    return null;
  }

  // Finds links that look like domain names (e.g. gmail.com, hotmail.queue)
  // inside tables - these are the per-domain detail page links on a Domains
  // *list* page.
  function findDomainLinks(doc, baseUrl) {
    const links = Array.from(doc.querySelectorAll("table a[href]"));
    const domainLinks = links.filter((a) => {
      const t = a.textContent.trim();
      // classic TLD or PowerMTA queue-style names like hotmail.queue
      return /^[a-z0-9.-]+\.[a-z0-9]{2,}$/i.test(t) && !/^(http|https|ftp):/i.test(t);
    });
    const seen = new Set();
    return domainLinks
      .map((a) => resolveUrl(a.getAttribute("href"), baseUrl))
      .filter((href) => {
        if (!href || seen.has(href)) return false;
        seen.add(href);
        return true;
      });
  }

  // Pulls "Domain Detail" key/value rows (name, recipients, kbytes, active
  // connections) from a domain-detail-style page.
  function parseDomainDetail(doc) {
    const info = {};
    const rows = Array.from(doc.querySelectorAll("table tr"));
    rows.forEach((row) => {
      const cells = Array.from(row.querySelectorAll("td, th")).map((c) =>
        c.textContent.trim()
      );
      if (cells.length === 2) {
        const key = cells[0].toLowerCase();
        if (["name", "recipients", "kbytes", "active connections"].includes(key)) {
          info[key] = cells[1];
        }
      }
    });
    return info;
  }

  // ---- server label -----------------------------------------------------

  // Pulls a friendly "s_vms1_10048 / 182.239.49.164" style label out of a
  // PMTA box's page text. `originHint` is the URL the page was fetched
  // from (or the live frame's location) - used as a fallback host when no
  // IP can be found in the visible text itself.
  function extractServerLabel(doc, originHint) {
    const text = doc.body ? doc.body.textContent || "" : "";
    // Title often looks like: "243063 - s_vms1_10053 - 149.50.98.2 | PowerMTA domains"
    const title = (doc.title || "") + " " + text;
    const idMatch = title.match(/s_[a-z0-9_]+/i);
    const ipMatch = title.match(/\b(\d{1,3}\.){3}\d{1,3}\b/);
    let host = null;
    let hostname = null;
    try {
      const u = new URL(originHint);
      host = u.host;
      hostname = u.hostname;
    } catch (e) {
      host = originHint || null;
      hostname = originHint || null;
    }
    return {
      id: idMatch ? idMatch[0] : null,
      ip: ipMatch ? ipMatch[0] : hostname,
      host: host,
    };
  }

  // ---- error table parsing -----------------------------------------------

  // Rows that just mean "nothing to report" - never treat these as errors.
  function isPlaceholderRow(text) {
    return /^\s*no errors? found\s*$/i.test(text) || /^\s*none\s*$/i.test(text);
  }

  // Turns a <table> whose rows are [vmta, time, error...] into row objects.
  // Handles header rows built from <th> OR plain <td>, and skips section
  // header/spacer rows that only have one real cell.
  function extractRowsFromTable(table) {
    const allRows = Array.from(table.querySelectorAll("tr"));
    const rows = [];
    let sawHeader = false;
    for (const row of allRows) {
      const cellEls = Array.from(row.querySelectorAll("td, th"));
      const cells = cellEls.map((c) => c.textContent.replace(/\s+/g, " ").trim());
      if (cells.length < 2) continue; // section-title / spacer row
      const joined = cells.join(" ").toLowerCase();
      const allTh = cellEls.length > 0 && cellEls.every((c) => c.tagName === "TH");
      const looksLikeHeaderWords = cells.length <= 4 && /vmta/.test(joined) && /error/.test(joined);
      if (!sawHeader && (allTh || looksLikeHeaderWords)) {
        sawHeader = true; // this row *is* the header - don't emit it as data
        continue;
      }
      const wholeRowText = cells.join(" ");
      if (isPlaceholderRow(wholeRowText)) continue;
      const vmta = cells[0];
      let time = "";
      let errorCells;
      if (cells.length >= 3) {
        time = cells[1];
        errorCells = cells.slice(2);
      } else {
        errorCells = cells.slice(1);
      }
      const error = errorCells.join(" ").replace(/\s+/g, " ").trim();
      if (!vmta && !error) continue;
      rows.push({ vmta, time, error });
    }
    return rows;
  }

  // A "View options" filter/sort panel (seen at the top of PMTA list pages)
  // is a real <table> too, and can otherwise satisfy the header-word check
  // below if its labels happen to include words like "Virtual MTA" - but it
  // always contains actual form controls (text inputs, radios, a submit
  // button), which a genuine data table (Last Errors / Domain Detail /
  // Queues) never does. Excluding any table with form controls keeps the
  // options panel from ever being mistaken for the errors table.
  function isFormTable(table) {
    return !!table.querySelector("input, select, textarea, button, option");
  }

  // Strategy A: a table whose header row literally contains "vmta" and
  // "error" (fast path, matches the layout in the original screenshots).
  function findErrorTableByHeader(doc) {
    const tables = Array.from(doc.querySelectorAll("table"));
    for (const table of tables) {
      if (isFormTable(table)) continue;
      const firstRow = table.querySelector("tr");
      if (!firstRow) continue;
      const headerText = firstRow.textContent.toLowerCase();
      if (headerText.includes("vmta") && headerText.includes("error")) {
        return table;
      }
    }
    return null;
  }

  // Strategy B: find any element whose OWN text (not descendants) reads
  // "Last Errors" (PMTA renders this as a little section-title bar), then
  // take the next <table> that appears after it in document order. Catches
  // layouts where the data table's own header row is worded differently
  // (e.g. "Message" instead of "Error").
  function findErrorTableByHeading(doc) {
    const all = Array.from(doc.querySelectorAll("body, body *"));
    let headingEl = null;
    for (const el of all) {
      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join(" ")
        .trim();
      if (/^last\s+errors?$/i.test(ownText)) {
        headingEl = el;
        break;
      }
    }
    if (!headingEl) return null;

    const treeWalker = doc.createTreeWalker
      ? doc.createTreeWalker(doc.body, 1 /* NodeFilter.SHOW_ELEMENT */)
      : null;
    if (!treeWalker) return null;

    let passedHeading = false;
    let node;
    while ((node = treeWalker.nextNode())) {
      if (node === headingEl) {
        passedHeading = true;
        continue;
      }
      if (!passedHeading) continue;
      if (node.tagName === "TABLE") {
        if (isFormTable(node)) continue; // not a real data table - keep looking
        return node;
      }
      const ownText = Array.from(node.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join(" ")
        .trim();
      if (
        ownText &&
        /^(domain detail|queues|traffic totals|top domains|active connections|queue totals)$/i.test(
          ownText
        )
      ) {
        return null; // hit the next section before finding a table - give up
      }
    }
    return null;
  }

  // Public: finds the Last Errors table (by whichever strategy works) and
  // returns [{vmta, time, error}, ...]. Returns [] if the section says
  // "No errors found" or can't be located at all.
  function parseErrorsTable(doc) {
    const table = findErrorTableByHeader(doc) || findErrorTableByHeading(doc);
    if (!table) return [];
    return extractRowsFromTable(table);
  }

  // ---- Domains LIST page: "Last Error" column ----------------------------
  //
  // Real PowerMTA Domains pages (esp. when proxied via /pmta?u=...) show a
  // summary table:
  //   Name | #Rcpt | KBytes | #Conn | Last Error
  // The classic per-VMTA Last Errors table only appears on domain *detail*
  // pages. Without reading this column we miss errors that only show on the
  // list (and look like "0 errors" in the popup).

  function parseDomainsListLastErrors(doc) {
    const tables = Array.from(doc.querySelectorAll("table"));
    const out = [];
    for (const table of tables) {
      if (isFormTable(table)) continue;
      const rows = Array.from(table.querySelectorAll("tr"));
      if (rows.length < 2) continue;

      const headerCells = Array.from(rows[0].querySelectorAll("th, td")).map((c) =>
        c.textContent.replace(/\s+/g, " ").trim().toLowerCase()
      );
      // Must look like the domains summary table
      const nameIdx = headerCells.findIndex((h) => h === "name" || h === "domain");
      const errIdx = headerCells.findIndex(
        (h) => h === "last error" || h === "error" || /last\s*error/.test(h)
      );
      if (nameIdx < 0 || errIdx < 0) continue;
      // Prefer tables that also have recipient/conn style columns (avoid random matches)
      const looksLikeDomains =
        headerCells.some((h) => /rcpt|recipient|#rcpt/.test(h)) ||
        headerCells.some((h) => /kbyte|conn/.test(h)) ||
        headerCells.length >= 3;
      if (!looksLikeDomains) continue;

      for (let i = 1; i < rows.length; i++) {
        const cells = Array.from(rows[i].querySelectorAll("td, th")).map((c) =>
          c.textContent.replace(/\s+/g, " ").trim()
        );
        if (cells.length <= Math.max(nameIdx, errIdx)) continue;
        const domain = cells[nameIdx] || "";
        let lastError = cells[errIdx] || "";
        if (!lastError || isPlaceholderRow(lastError)) continue;
        // Decode HTML entities that may have been left as text (&quot; etc.)
        lastError = lastError
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">");

        // Many cells start with a timestamp: "2026-09-18 10:22:20 Error: ..."
        let time = "";
        let error = lastError;
        const m = lastError.match(
          /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*(.*)$/
        );
        if (m) {
          time = m[1];
          error = m[2] || lastError;
        }
        out.push({
          vmta: "",
          time,
          error,
          domain: domain || null,
        });
      }
      if (out.length) break; // first matching domains table is enough
    }
    return out;
  }

  global.PmtaParser = {
    looksLikePmtaFrame,
    findNavHref,
    findFrameLinks,
    findDomainLinks,
    parseDomainDetail,
    parseErrorsTable,
    parseDomainsListLastErrors,
    extractServerLabel,
    resolveUrl,
    // exposed for tests / debugging only:
    _extractRowsFromTable: extractRowsFromTable,
    _findErrorTableByHeader: findErrorTableByHeader,
    _findErrorTableByHeading: findErrorTableByHeading,
  };
})(typeof window !== "undefined" ? window : this);
