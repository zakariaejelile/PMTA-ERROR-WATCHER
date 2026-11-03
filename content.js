// content.js
// Runs in every frame of the currently-open tab (top frame + every PMTA
// iframe). This is the "no panel URL configured" fallback path - see
// background.js for the primary panel-URL scanning path, which runs
// entirely from the background and doesn't need any tab to be open.
//
// All HTML-parsing logic lives in parser.js (loaded right before this file
// in the manifest) so the two scanning paths can't drift apart.

(function () {
  if (window === window.top) return;
  if (!window.PmtaParser || !window.PmtaParser.looksLikePmtaFrame(document)) return;

  const P = window.PmtaParser;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "SCAN_FRAME") {
      scanThisServer()
        .then(sendResponse)
        .catch((err) =>
          sendResponse({
            origin: location.origin,
            label: P.extractServerLabel(document, location.href),
            errors: [],
            errorCount: 0,
            fetchError: describeError(err),
          })
        );
      return true; // keep the message channel open for the async response
    }
  });

  async function scanThisServer() {
    const label = P.extractServerLabel(document, location.href);
    const result = { origin: location.origin, label, errors: [], errorCount: 0, fetchError: null };

    const domainsHref = P.findNavHref(document, "Domains", location.href);
    if (!domainsHref) {
      result.fetchError = 'Could not find a "Domains" tab link on this page.';
      return result;
    }

    let listDoc;
    try {
      listDoc = await fetchDoc(domainsHref);
    } catch (e) {
      result.fetchError = "Failed to load Domains page: " + describeError(e);
      return result;
    }

    // 1) Classic Last Errors table (usually on domain detail, sometimes list)
    let errors = P.parseErrorsTable(listDoc).map((e) => ({ ...e, domain: e.domain || null }));

    // 2) Domains LIST page "Last Error" column (Name | #Rcpt | ... | Last Error)
    //    This is the layout seen on real proxied PowerMTA 4.x panels.
    const listColErrors = P.parseDomainsListLastErrors(listDoc);
    errors = errors.concat(listColErrors);

    // 3) Drill into each domain detail page for full per-VMTA Last Errors
    const domainLinks = P.findDomainLinks(listDoc, domainsHref);
    for (const link of domainLinks) {
      try {
        const dDoc = await fetchDoc(link);
        const detail = P.parseDomainDetail(dDoc);
        const domainName = detail.name || null;
        const dErrors = P.parseErrorsTable(dDoc).map((e) => ({
          ...e,
          domain: domainName || e.domain || null,
        }));
        const dListErrs = P.parseDomainsListLastErrors(dDoc).map((e) => ({
          ...e,
          domain: domainName || e.domain || null,
        }));
        errors = errors.concat(dErrors, dListErrs);
      } catch (e) {
        errors.push({
          vmta: "",
          time: "",
          error: "(failed to read domain page " + link + ": " + describeError(e) + ")",
          domain: null,
        });
      }
    }

    // De-dupe identical error rows (list column + detail can overlap)
    const seen = new Set();
    result.errors = errors.filter((e) => {
      if (!e.vmta && !e.error) return false;
      const key = [e.domain || "", e.vmta || "", e.time || "", e.error || ""].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    result.errorCount = result.errors.length;
    return result;
  }

  async function fetchDoc(url) {
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const html = await resp.text();
    return new DOMParser().parseFromString(html, "text/html");
  }

  function describeError(e) {
    return e && e.message ? e.message : String(e);
  }
})();
