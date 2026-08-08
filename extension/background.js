// shadertoy2mc — background service worker.
//
// Reads shader source directly from the ShaderToy page DOM (CodeMirror),
// converts it with core.mjs, zips with zip.js, and triggers a download.
// No API calls, no server, no Cloudflare.

import { convert } from "./core.mjs";
import { zipBlob } from "./zip.js";

// ---- Injected into the ShaderToy page to scrape all tab sources from CodeMirror ----
// This runs in the page's MAIN world so it can access the CodeMirror instance.
function scrapeTabsFromPage() {
  // Find the CodeMirror editor
  const cmEl = document.querySelector(".CodeMirror");
  if (!cmEl || !cmEl.CodeMirror) {
    return { error: "No CodeMirror editor found. Make sure you're on a shader page with the original editor (not Monaco)." };
  }
  const cm = cmEl.CodeMirror;

  // Build tab map from passManager
  const tabEls = document.querySelectorAll("#passManager .tab");
  const tabMap = [];
  for (const el of tabEls) {
    const label = (el.querySelector("label") || {}).textContent?.trim();
    if (!label) continue;
    if (label === "Common") tabMap.push({ el, key: "common" });
    else if (label === "Image") tabMap.push({ el, key: "image" });
    else if (label.startsWith("Buffer")) {
      const letter = label.replace("Buffer ", "").trim().toLowerCase();
      if (/^[a-d]$/.test(letter)) tabMap.push({ el, key: letter });
    }
  }

  if (tabMap.length === 0) {
    return { error: "No shader tabs found on this page." };
  }

  // Remember which tab is currently selected so we can restore it
  const origSelected = document.querySelector("#passManager .tab.selected");

  const tabs = {};

  // Switch to each tab, wait for CodeMirror to update, read the source
  for (const { el, key } of tabMap) {
    el.click();
    // ShaderToy swaps editor content on click — give it a moment
  }

  // Read after all clicks have been dispatched.
  // We do one final pass: click each tab and read immediately after.
  // The issue is that tab switching is async, so we use a simple polling approach.
  return new Promise((resolve) => {
    let idx = 0;
    const delay = 150; // ms between tab switches

    function nextTab() {
      if (idx >= tabMap.length) {
        // Restore original tab
        if (origSelected) origSelected.click();

        // Get shader name from page title
        const shaderName = document.title.replace(/\s*[-–—]\s*Shadertoy.*$/i, "").trim();

        resolve({ tabs, shaderName });
        return;
      }

      const { el, key } = tabMap[idx];
      el.click();

      setTimeout(() => {
        const code = cm.getValue();
        if (code && code.trim().length > 0) {
          tabs[key] = code;
        }
        idx++;
        nextTab();
      }, delay);
    }

    nextTab();
  });
}

// ---- Main pipeline: scrape → convert → zip → download ----
async function downloadFromPage(tabId, options = {}) {
  // Inject scraper into the page's MAIN world to access CodeMirror
  const results = await browser.scripting.executeScript({
    target: { tabId },
    func: scrapeTabsFromPage,
    world: "MAIN",
  });

  const scraped = results?.[0]?.result;
  if (!scraped) throw new Error("Failed to read shader from page.");
  if (scraped.error) throw new Error(scraped.error);

  const { tabs, shaderName } = scraped;
  if (!tabs.image) throw new Error("No Image pass found.");

  // Convert
  const enc = new TextEncoder();
  const result = convert(tabs, {
    defaultName: shaderName || "shadertoy",
    namespace: options.namespace || undefined,
    timeScale: options.timeScale || 1200,
  });

  // Zip and download
  const zipEntries = result.outputs.map((o) => ({
    name: o.path,
    data: enc.encode(o.content),
  }));

  const blob = zipBlob(zipEntries);
  const filename = `${result.effectName}.zip`;
  const url = URL.createObjectURL(blob);

  await browser.downloads.download({ url, filename, saveAs: true });
  setTimeout(() => URL.revokeObjectURL(url), 30000);

  return {
    effectName: result.effectName,
    shaderName,
    tabs: Object.keys(tabs).map((k) =>
      k === "image" ? "Image" : k === "common" ? "Common" : "Buffer " + k.toUpperCase()
    ),
    passes: result.passKeys.length,
    files: result.outputs.map((o) => o.path),
    warnings: result.warnings,
    enableCommand: `/post-effect ${result.effectName}`,
  };
}

// ---- Message handler ----
browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "get-shader-id") {
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
 const m = tabs[0]?.url?.match(/shadertoy\.com\/(?:view|new)\/([A-Za-z0-9]+)/i);
      sendResponse({ shaderId: m ? m[1] : null });
    });
    return true;
  }

  if (message.type === "download-from-page") {
    const { options } = message;
    (async () => {
      try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error("No active tab");
        const result = await downloadFromPage(tab.id, options);
        sendResponse({ ok: true, ...result });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
});
