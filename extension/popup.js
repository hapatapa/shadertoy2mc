// shadertoy2mc bridge — popup UI logic.

const $serverDot = document.getElementById("serverDot");
const $serverStatus = document.getElementById("serverStatus");
const $serverUrl = document.getElementById("serverUrl");
const $shaderId = document.getElementById("shaderId");
const $optNamespace = document.getElementById("optNamespace");
const $optTimeScale = document.getElementById("optTimeScale");
const $btnConvert = document.getElementById("btnConvert");
const $btnSaveServer = document.getElementById("btnSaveServer");
const $result = document.getElementById("result");

// ---- Server status ----
async function checkServer() {
  $serverDot.className = "dot loading";
  $serverStatus.textContent = "Checking server...";
  try {
    const resp = await browser.runtime.sendMessage({ type: "check-server" });
    if (resp.ok) {
      $serverDot.className = "dot ok";
      $serverStatus.textContent = `Server connected (v${resp.status?.version || "?"})`;
      updateConvertButton();
    } else {
      throw new Error();
    }
  } catch {
    $serverDot.className = "dot err";
    $serverStatus.textContent = "Server not running — start: node server.mjs";
    $btnConvert.disabled = true;
  }
}

// ---- Get shader ID from current tab ----
async function detectShader() {
  try {
    const resp = await browser.runtime.sendMessage({ type: "get-shader-id" });
    const id = resp.shaderId;
    if (id) {
      $shaderId.value = id;
      updateConvertButton();
    } else {
      $shaderId.value = "";
      $shaderId.placeholder = "Not on a ShaderToy shader page";
      $btnConvert.disabled = true;
    }
  } catch {
    $shaderId.placeholder = "Could not detect shader";
    $btnConvert.disabled = true;
  }
}

function updateConvertButton() {
  const hasShader = $shaderId.value.length > 0;
  const serverOk = $serverDot.classList.contains("ok");
  $btnConvert.disabled = !(hasShader && serverOk);
}

// ---- Save server URL ----
$btnSaveServer.addEventListener("click", async () => {
  const url = $serverUrl.value.replace(/\/+$/, "");
  await browser.runtime.sendMessage({ type: "update-server-url", serverUrl: url });
 $btnSaveServer.textContent = "Saved";
  setTimeout(() => ($btnSaveServer.textContent = "Save"), 1000);
  checkServer();
});

// ---- Convert ----
$btnConvert.addEventListener("click", async () => {
  const shaderId = $shaderId.value.trim();
  if (!shaderId) return;

  $btnConvert.disabled = true;
  $btnConvert.textContent = "Fetching from ShaderToy...";
  $result.className = "";
  $result.textContent = "";

  try {
    const options = {
      namespace: $optNamespace.value || undefined,
      timeScale: Number($optTimeScale.value) || 1200,
    };

    const resp = await browser.runtime.sendMessage({
      type: "fetch-and-convert",
      shaderId,
      options,
    });

    if (!resp.ok) {
      throw new Error(resp.error || "Unknown error");
    }

    // Success
    $result.className = "show ok";
    let html = `<div class="result-title">${resp.effectName}</div>`;
    html += `<div class="result-detail">`;
    html += `Shader: ${resp.shaderName || shaderId}\n`;
    html += `Tabs: ${resp.tabs?.join(", ") || "—"}\n`;
    html += `Passes: ${resp.passes}\n`;
    html += `Output: ${resp.outRoot}\n`;
    html += `</div>`;
    html += `<div class="cmd">/post-effect ${resp.effectName}</div>`;

    if (resp.warnings?.length) {
      html += `<div class="warn-list">`;
      for (const w of resp.warnings) {
        html += `<div class="warn-item">${escapeHtml(w)}</div>`;
      }
      html += `</div>`;
    }

    $result.innerHTML = html;

    // Show file list
    if (resp.files?.length) {
      let filesHtml = `<div class="result-detail" style="margin-top:8px;">Files:\n`;
      for (const f of resp.files) filesHtml += `  ${f}\n`;
      filesHtml += `</div>`;
      $result.innerHTML += filesHtml;
    }

  } catch (e) {
    $result.className = "show err";
    $result.innerHTML = `<div class="result-title">Error</div><div class="result-detail">${escapeHtml(e.message)}</div>`;
  }

  $btnConvert.textContent = "Send to shadertoy2mc";
  $btnConvert.disabled = false;
});

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- Init ----
(async () => {
  const { serverUrl } = await browser.runtime.sendMessage({ type: "get-server-url" });
  if (serverUrl) $serverUrl.value = serverUrl;
  await checkServer();
  await detectShader();
})();
