// offscreen.js
// MV3 service workers have no DOMParser/document. When background.js is
// scanning via a configured panel URL (no tab involved at all), it hands
// any HTML it fetches to this hidden offscreen document, which builds a
// real DOM for it and runs the same parser.js functions content.js uses
// inline inside a live frame.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "OFFSCREEN_PARSE") return; // not for us - ignore

  try {
    const doc = new DOMParser().parseFromString(msg.html || "", "text/html");
    const args = msg.args || {};
    let result;

    switch (msg.op) {
      case "looksLikePmtaFrame":
        result = window.PmtaParser.looksLikePmtaFrame(doc);
        break;
      case "findNavHref":
        result = window.PmtaParser.findNavHref(doc, args.label, msg.baseUrl);
        break;
      case "findFrameLinks":
        result = window.PmtaParser.findFrameLinks(doc, msg.baseUrl);
        break;
      case "findDomainLinks":
        result = window.PmtaParser.findDomainLinks(doc, msg.baseUrl);
        break;
      case "parseDomainDetail":
        result = window.PmtaParser.parseDomainDetail(doc);
        break;
      case "parseErrorsTable":
        result = window.PmtaParser.parseErrorsTable(doc);
        break;
      case "parseDomainsListLastErrors":
        result = window.PmtaParser.parseDomainsListLastErrors(doc);
        break;
      case "extractServerLabel":
        result = window.PmtaParser.extractServerLabel(doc, msg.baseUrl);
        break;
      default:
        sendResponse({ ok: false, error: "Unknown op: " + msg.op });
        return;
    }
    sendResponse({ ok: true, result });
  } catch (e) {
    sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});
