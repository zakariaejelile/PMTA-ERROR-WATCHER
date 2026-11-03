const panelUrlEl = document.getElementById("panelUrl");
const intervalEl = document.getElementById("interval");
const saveBtn = document.getElementById("saveBtn");
const testBtn = document.getElementById("testBtn");
const savedNote = document.getElementById("savedNote");
const testResultEl = document.getElementById("testResult");

document.addEventListener("DOMContentLoaded", load);
saveBtn.addEventListener("click", save);
testBtn.addEventListener("click", test);

async function load() {
  const { panelUrl, scanIntervalMinutes } = await chrome.storage.local.get([
    "panelUrl",
    "scanIntervalMinutes",
  ]);
  if (panelUrl) panelUrlEl.value = panelUrl;
  if (scanIntervalMinutes) intervalEl.value = scanIntervalMinutes;
}

async function save() {
  const panelUrl = panelUrlEl.value.trim();
  const scanIntervalMinutes = Number(intervalEl.value) || 0;

  if (panelUrl) {
    try {
      new URL(panelUrl);
    } catch (e) {
      testResultEl.className = "fail";
      testResultEl.textContent = "That doesn't look like a valid URL.";
      return;
    }
  }

  await chrome.storage.local.set({ panelUrl, scanIntervalMinutes });
  savedNote.style.display = "inline";
  setTimeout(() => (savedNote.style.display = "none"), 1500);
}

async function test() {
  const panelUrl = panelUrlEl.value.trim();
  if (!panelUrl) {
    testResultEl.className = "fail";
    testResultEl.textContent = "Enter a panel URL first.";
    return;
  }
  testResultEl.className = "";
  testResultEl.textContent = "Testing...";
  const res = await chrome.runtime.sendMessage({ type: "TEST_PANEL_URL", panelUrl });
  if (res && res.ok) {
    testResultEl.className = "ok";
    const captions = (res.frames || []).map((f) => f.caption).filter(Boolean).slice(0, 5);
    testResultEl.textContent =
      `Found ${res.frameCount} server frame(s).` +
      (captions.length ? "\nFirst few: " + captions.join(", ") : "");
  } else {
    testResultEl.className = "fail";
    testResultEl.textContent = "Failed: " + (res && res.error ? res.error : "unknown error");
  }
}
