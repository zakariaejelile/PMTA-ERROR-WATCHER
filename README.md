# PMTA Error Watcher

A Chrome extension (Manifest V3) that scans a multi-server **PowerMTA** panel and shows which servers, IPs, domains and VMTAs have sending errors — without clicking into each server one by one.

It also keeps a rolling **error history** (up to 2,000 rows) in local storage, so you can see errors from past scans even after they clear from the panel.

> Version: **2.2.1** · Manifest V3 · Chrome 116+

---

## Table of contents

- [Features](#features)
- [How it works](#how-it-works)
- [Install](#install)
- [Usage](#usage)
- [Settings](#settings)
- [Output columns](#output-columns)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Privacy & permissions](#privacy--permissions)
- [Limitations](#limitations)
- [Changelog](#changelog)
- [License](#license)

---

## Features

- **Two scan modes**
  - **Panel-URL mode (recommended)** — set your MultiPMTA panel URL once and scans run entirely in the background. No tab needs to be open.
  - **Open-tab mode (fallback)** — with no panel URL configured, scans whichever PMTA panel tab is currently open.
- **Automatic server discovery** — reads every `<iframe>` on the panel page, so it works with any number of servers and does not rely on hard-coded IPs or hostnames.
- **Deep scan per server** — follows the **Domains** tab, reads the domains list, then drills into each domain detail page.
- **Both error sources are read**
  - The classic per-VMTA **Last Errors** table.
  - The **Last Error** column of the Domains summary table (`Name | #Rcpt | KBytes | #Conn | Last Error`).
- **Flat results table** — every row carries Server, Error IP, Domain, VMTA, Time and the full error text.
- **Smart error-IP resolution** — prefers the IP embedded in the VMTA name (e.g. `gmail-51.68.148.19`), then the first IP in the error text, then the server's own IP.
- **Live / History views** — switch between the latest scan and the persistent error history.
- **Error history with de-duplication** — identical errors are stored once (server + IP + domain + VMTA + time + error text), newest kept, capped at 2,000 rows.
- **Instant filter/search** across server, IP, origin, domain, VMTA, timestamp and error text.
- **Badge counter** — total error count shown on the extension icon.
- **Optional auto-scan** — run a scan every *N* minutes via `chrome.alarms` (panel-URL mode only).
- **Test Connection** — verifies the panel URL and reports how many server frames it found before you commit to a full scan.
- **Unreachable servers are still listed** — so a failed fetch never looks like "no errors".

---

## How it works

### Panel-URL mode

1. The service worker fetches the panel page.
2. The panel HTML is handed to a hidden **offscreen document** (MV3 service workers have no DOM) where `parser.js` extracts every server `<iframe>` URL.
3. For each server it fetches the landing page, extracts the server label (e.g. `s_vms1_10048` / `182.239.49.164`) and finds the **Domains** link.
4. It fetches the Domains page, parses:
   - any Last Errors table, and
   - the `Last Error` column of the domains summary table.
5. It then fetches every domain detail page and parses the same two sources again, tagging each row with its domain name.
6. Rows are de-duplicated, saved to `chrome.storage.local` under `lastScan`, appended to `errorHistory`, and the badge is updated.

### Open-tab mode

1. `content.js` is injected into every frame of the active tab.
2. It only activates in frames that *look like* a PowerMTA monitor box (page text contains `PowerMTA`, `Domains` and `Queues`) — never in the top frame.
3. Each PMTA frame scans itself in place using the same `parser.js` functions, fetched with `credentials: "include"`, without disturbing the page you're looking at.

### Shared parser

`parser.js` is deliberately **pure** — no `chrome.*` calls, just DOM parsing. It is loaded into both the content script and the offscreen document, so the two scan paths can never drift apart.

Two detection strategies are used for the Last Errors table:

- **Strategy A** — a `<table>` whose first row mentions both `vmta` and `error`.
- **Strategy B** — locate the element whose own text is exactly `Last Errors`, then take the next data table in document order.

Any table containing form controls (`input`, `select`, `textarea`, `button`, `option`) is excluded, so the PMTA "View options" filter/sort panel is never mistaken for an error table.

---

## Install

This is loaded unpacked (no Chrome Web Store listing).

1. Download or clone this repository.
2. Keep the folder somewhere permanent — Chrome loads the extension from it directly.
3. Open `chrome://extensions`.
4. Enable **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select this folder.
6. Pin the extension (puzzle-piece icon → pin).

**Updating:** replace the files, then click the reload icon on the extension's card in `chrome://extensions`.

**Requirements**

- Chrome / Edge / any Chromium browser with Manifest V3 support.
- `chrome.offscreen` → Chrome **109+**.
- `chrome.runtime.getContexts` → Chrome **116+**.

---

## Usage

### Recommended: configure the panel URL once

1. Click the extension icon → **⚙** (settings).
2. Paste the URL of your MultiPMTA panel page (the page whose HTML contains all the server `<iframe>` boxes).
3. Click **Test Connection** — it should report how many server frames it found, with a few captions.
4. Optionally set **Auto-scan every (minutes)** — `0` disables auto-scan.
5. Click **Save**.
6. Open the popup and click **Scan Now**. No panel tab needs to be open.

### Fallback: scan whatever is open

1. Open the tab with your multi-server PMTA panel (the grid of boxes).
2. Click the extension icon → **Scan Now**.

### Popup controls

| Button | Action |
| --- | --- |
| **Live** | Show the results of the latest scan |
| **History** | Show errors collected across all past scans |
| **Scan Now** | Run a new scan (Live view only) |
| **Clear** | Clear live results, stored `lastScan`, and the badge |
| **Clear history** | Delete all stored error history (asks for confirmation) |
| **⚙** | Open settings |

The status line under the header shows the scan time, which mode was used, how many servers were checked, and how many errors were found. The last scan is remembered, so reopening the popup shows it immediately.

---

## Settings

| Setting | Description |
| --- | --- |
| **MultiPMTA panel URL** | Optional. The page that embeds every server box as an iframe. When set, all scans run in the background. Leave blank to use open-tab mode. |
| **Auto-scan every (minutes)** | Only applies when a panel URL is set. `0` = manual only. Implemented with `chrome.alarms`, so it survives service-worker restarts. |
| **Test Connection** | Fetches the panel URL, counts the server frames, and prints the first few captions. Does not run a full scan. |

Settings are stored in `chrome.storage.local`.

---

## Output columns

| Column | Meaning |
| --- | --- |
| **Server** | PMTA box name (e.g. `s_vms1_10048`); hover shows the origin URL |
| **Error IP** | IP tied to that specific error: from the VMTA name, else the error text, else the server IP |
| **Domain** | Domain the error belongs to |
| **VMTA** | Virtual MTA name, when reported |
| **Time** | Timestamp reported by PowerMTA |
| **Logged** | *(History view only)* when the error was first stored by the extension |
| **Error** | Full error text |

Row styling:

- Normal rows — an actual error.
- Green rows — server reachable, no errors found.
- Italic red rows — server could not be read (fetch/parse failure).

---

## Project structure

```
pmta-error-watcher-v2.2.1/
├── manifest.json     # MV3 manifest, permissions, entry points
├── background.js     # service worker: both scan paths, message routing,
│                     #   badge, error history, auto-scan alarm
├── parser.js         # pure DOM parsing helpers (shared, no chrome.* calls)
├── content.js        # open-tab mode: scans PMTA iframes in place
├── offscreen.html    # hidden document used by panel-URL mode
├── offscreen.js      # gives the service worker a real DOM for parsing
├── options.html      # settings page
├── options.js
├── popup.html        # popup UI (Live/History, filter, summary, table)
└── popup.js
```

### Storage keys

| Key | Contents |
| --- | --- |
| `panelUrl` | Configured MultiPMTA panel URL |
| `scanIntervalMinutes` | Auto-scan interval in minutes (`0` = off) |
| `lastScan` | `{ time, mode, results[], error? }` from the latest scan |
| `errorHistory` | Flat array of stored error rows (max 2,000, deduplicated) |

---

## Troubleshooting

### "No PMTA servers were found."

- **Panel-URL mode:** re-check the URL in Settings with **Test Connection**. Make sure the URL is the page that *contains the iframes*, not one individual server.
- **Open-tab mode:** make sure the tab with the multi-server panel is the active tab when you click **Scan Now**.

### "Could not read this server: …"

The fetch itself failed — host unreachable, wrong port, timeout, or a login redirect. Open that server directly in a browser tab to confirm it responds.

### Garbage-looking "errors" (UI labels, filter text, etc.)

A table was matched that shouldn't have been. The parser has already been hardened against the "View options" panel, but real markup can vary.

**Fastest fix — send fixture HTML:**

1. Open that server's **Domains** tab directly in a normal tab.
2. Right-click → **View Page Source** (or save the page).
3. Share the HTML — especially any table that produced bad output.

With a real fixture the parser can be matched exactly instead of guessed from screenshots.

### Everything shows "0 errors" but the panel clearly has errors

Errors may only exist in the Domains list **Last Error** column. v2.2.1 reads both that column and the per-VMTA Last Errors table. If it still misses, a fixture of the Domains page will pinpoint the layout difference.

### After updating, nothing changed

Click the reload icon on the extension card in `chrome://extensions`, then close and reopen the popup.

---

## Privacy & permissions

- **All data stays local.** Results and history are written only to `chrome.storage.local` on your machine. Nothing is sent to any third party.
- **No analytics, no telemetry, no external servers.**
- Permissions requested:
  - `storage` — save settings, last scan and history.
  - `tabs` / `webNavigation` — enumerate frames of the active tab in open-tab mode.
  - `offscreen` — hidden DOM for parsing fetched HTML.
  - `alarms` — optional periodic auto-scan.
  - `<all_urls>` — required because the extension has no way to know your panel's host/port ahead of time; it only fetches your configured panel URL and the server URLs discovered on it.

---

## Limitations

- Built for **PowerMTA monitoring panels that expose servers as iframes**; other layouts are not supported out of the box.
- **No authentication handling.** It relies on the panel being reachable without login (or an existing browser session for open-tab mode).
- Panel-URL mode makes **one request per domain per server** — with many domains this can be slow and chatty. A "recent traffic only" filter could be added later.
- The parser is tuned against observed PowerMTA markup, not a published spec; unusual builds may need new fixtures.
- The alarm-based auto-scan only runs while the browser is running.

### Possible future additions

- Desktop notifications for newly seen errors.
- Reading the **Queues** tab as an additional source.
- CSV / JSON export of the error list.
- Domain-count / request throttling options.
- Extension icons (the manifest currently uses Chrome's default icon).

---

## Changelog

### v2.2.1

- **Error history** — errors from every scan are appended to `chrome.storage.local`, de-duplicated, newest-first, capped at 2,000 rows.
- **Live / History tabs** in the popup, each with its own status line and empty state.
- **Clear history** action with confirmation.
- **Error IP column** — resolves the IP tied to each error (VMTA name → error text → server IP) instead of always showing the server IP.
- Reads the **Domains list "Last Error" column** (`Name | #Rcpt | KBytes | #Conn | Last Error`), including timestamps embedded in the cell.
- Parses per-domain detail pages for both error sources and tags rows with the domain name.
- Origin URL exposed as a hover tooltip on the server name and included in search.

### v2.1.1

- Flat error table with Server, IP, Domain, VMTA, Time and full error text on every row.
- Clear button (results + storage + badge).
- Live filter/search with no rescan required.

### v2.0.1

- Fixed false positives from the "View options" filter/sort panel by excluding any table containing form controls.

### v2.0.0

- Panel-URL scanning with no tab open.
- Optional auto-scan interval.
- Open-tab scanning retained as automatic fallback.
- Last Errors parser hardened: two detection strategies, explicit URL resolution against the fetched page.

---

## License

No license file is included in this repository. Add one (for example MIT) before distributing or accepting contributions.
