// shadertoy2mc — background service worker.
//
// Fetches the ShaderToy API from the browser context (bypasses Cloudflare),
// runs the conversion pipeline inline (core.mjs), zips the result (zip.js),
// and triggers a download. No server needed.

import { convert } from "./core.mjs";
import { zipBlob } from "./zip.js";

// ---- Extract shader ID from a tab URL ----
function extractShaderId(tabUrl) {
  const m = tabUrl.match(/shadertoy\.com\/(?:view|new)\/([A-Za-z0-9]+)/i);
  return m ? m[1] : null;
}

// ---- Fetch shader from ShaderToy API (browser context = no CF block) ----
async function fetchShaderFromAPI(shaderId) {
  const resp = await fetch(`https://www.shadertoy.com/api/v1/shaders/${shaderId}`);
  if (!resp.ok) {
    throw new Error(`ShaderToy API returned ${resp.status}`);
  }
  const data = await resp.json();
  if (!data.Shader) {
    throw new Error("ShaderToy API returned unexpected response (no Shader key)");
  }
  return data.Shader;
}

// ---- Parse ShaderToy API response into tabs ----
function tabsFromShaderToy(shader) {
  const tabs = {};
  for (const pass of shader.renderpass) {
    const name = (pass.name || "").trim();
    const type = (pass.type || "").toLowerCase();
    const code = pass.code || "";
    if (type === "common" || name.toLowerCase() === "common") {
      tabs.common = code;
    } else if (type === "image" || name.toLowerCase() === "image") {
      tabs.image = code;
    } else if (type === "buffer" || type === "cfm") {
      const letter = name.replace(/\s*buffer\s*/i, "").trim().toLowerCase();
      if (/^[a-d]$/.test(letter)) tabs[letter] = code;
    }
  }
  return { tabs, shaderName: shader.info?.name || null };
}

// ---- Main: fetch → convert → zip → download ----
async function fetchConvertDownload(shaderId, options = {}) {
  const shader = await fetchShaderFromAPI(shaderId);
  const { tabs, shaderName } = tabsFromShaderToy(shader);

  if (!tabs.image) {
    throw new Error("Shader has no Image pass");
  }

  const enc = new TextEncoder();
  const result = convert(tabs, {
    name: options.name || undefined,
    defaultName: shaderName || shaderId,
    namespace: options.namespace || undefined,
    timeScale: options.timeScale || 1200,
    bindings: null,
  });

  const zipEntries = result.outputs.map((o) => ({
    name: o.path,
    data: enc.encode(o.content),
  }));

  const blob = zipBlob(zipEntries);
  const filename = `${result.effectName}.zip`;

  const url = URL.createObjectURL(blob);
  await browser.downloads.download({
    url,
    filename,
    saveAs: true,
  });
  // Revoke after a delay so the download can start
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

// ---- Handle messages from popup ----
browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "get-shader-id") {
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      sendResponse({ shaderId: extractShaderId(tabs[0]?.url || "") });
    });
    return true;
  }

  if (message.type === "fetch-convert-download") {
    const { shaderId, options } = message;
    (async () => {
      try {
        const result = await fetchConvertDownload(shaderId, options);
        sendResponse({ ok: true, ...result });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
});
