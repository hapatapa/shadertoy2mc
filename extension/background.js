// shadertoy2mc bridge — background service worker.
//
// Fetches the ShaderToy API from the browser context (bypasses Cloudflare),
// then POSTs the shader JSON to the local companion server.

const DEFAULT_SERVER = "http://localhost:3141";

// ---- Get server URL from storage ----
async function getServerUrl() {
  const { serverUrl } = await browser.storage.local.get("serverUrl");
  return (serverUrl || DEFAULT_SERVER).replace(/\/+$/, "");
}

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

// ---- Extract shader source from the page itself (fallback) ----
// ShaderToy loads the source into a global variable. We can grab it from the page.
async function fetchShaderFromPage(tabId) {
  const results = await browser.scripting.executeScript({
    target: { tabId },
    func: () => {
      // ShaderToy stores compiled/rendered shader data globally.
      // The page has a function getShaderData() or similar, but the
      // most reliable approach is to read from the Shadertoy React state.
      //
      // Try the global gShaderData first, then fall back to the
      // visible source editor.
      if (window.gShaderData) {
        return window.gShaderData;
      }
      // Try the React internal state
      const root = document.getElementById("root") || document.getElementById("app");
      if (root && root._reactRootContainer) {
        // React 16
        const fiber = root._reactRootContainer?._internalRoot?.current;
        // This is fragile, prefer the API approach
      }
      // Try parsing from page HTML — ShaderToy embeds shader info in a
      // <script> tag or as data attributes.
      //
      // Last resort: return null to signal we need the API.
      return null;
    },
  });
  return results?.[0]?.result || null;
}

// ---- Send to companion server ----
async function sendToServer(shader, options = {}) {
  const serverUrl = await getServerUrl();
  const resp = await fetch(`${serverUrl}/convert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shader, options }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: `Server returned ${resp.status}` }));
    throw new Error(err.error || `Server error ${resp.status}`);
  }
  return await resp.json();
}

// ---- Check if server is alive ----
async function checkServer() {
  const serverUrl = await getServerUrl();
  try {
    const resp = await fetch(`${serverUrl}/status`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) return await resp.json();
    return null;
  } catch {
    return null;
  }
}

// ---- Handle messages from popup ----
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "check-server") {
    checkServer().then((status) => sendResponse({ ok: !!status, status }));
    return true; // async
  }

  if (message.type === "get-shader-id") {
    // Use the active tab to get the URL
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const id = extractShaderId(tabs[0]?.url || "");
      sendResponse({ shaderId: id });
    });
    return true;
  }

  if (message.type === "fetch-and-convert") {
    const { shaderId, options } = message;
    (async () => {
      try {
        // Fetch shader from API (browser context bypasses Cloudflare)
        const shader = await fetchShaderFromAPI(shaderId);
        const result = await sendToServer(shader, options);
        sendResponse({ ok: true, ...result });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // async
  }

  if (message.type === "update-server-url") {
    browser.storage.local.set({ serverUrl: message.serverUrl });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "get-server-url") {
    getServerUrl().then((url) => sendResponse({ serverUrl: url }));
    return true;
  }
});
