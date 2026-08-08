// shadertoy2mc — popup UI.

const $shaderInfo = document.getElementById("shaderInfo");
const $optionsPane = document.getElementById("optionsPane");
const $optNamespace = document.getElementById("optNamespace");
const $optTimeScale = document.getElementById("optTimeScale");
const $btnDownload = document.getElementById("btnDownload");
const $result = document.getElementById("result");

let currentShaderId = null;

async function detectShader() {
  try {
    const resp = await browser.runtime.sendMessage({ type: "get-shader-id" });
    currentShaderId = resp.shaderId;
    if (currentShaderId) {
      $shaderInfo.innerHTML = `Shader: <span class="id">${escapeHtml(currentShaderId)}</span>`;
      $optionsPane.style.display = "";
      $btnDownload.disabled = false;
    } else {
      $shaderInfo.innerHTML = `<span class="no-shader">Navigate to a ShaderToy shader page</span>`;
      $optionsPane.style.display = "none";
      $btnDownload.disabled = true;
    }
  } catch {
    $shaderInfo.innerHTML = `<span class="no-shader">Could not detect shader</span>`;
    $optionsPane.style.display = "none";
    $btnDownload.disabled = true;
  }
}

$btnDownload.addEventListener("click", async () => {
  if (!currentShaderId) return;

  $btnDownload.disabled = true;
  $btnDownload.textContent = "Reading shader...";
  $result.className = "";
  $result.innerHTML = "";

  try {
    const resp = await browser.runtime.sendMessage({
      type: "download-from-page",
      options: {
        namespace: $optNamespace.value || undefined,
        timeScale: Number($optTimeScale.value) || 1200,
      },
    });

    if (!resp.ok) throw new Error(resp.error || "Unknown error");

    $result.className = "show ok";
    let html = `<div class="result-title">${escapeHtml(resp.effectName)}.zip downloaded</div>`;
    html += `<div class="result-detail">`;
    html += `Shader: ${escapeHtml(resp.shaderName || currentShaderId)}\n`;
    html += `Tabs: ${resp.tabs?.join(", ") || "—"}\n`;
    html += `Passes: ${resp.passes}\n`;
    html += `</div>`;
    html += `<div class="cmd">/post-effect ${escapeHtml(resp.effectName)}</div>`;

    if (resp.files?.length) {
      html += `<div class="result-detail" style="margin-top:8px;">Files:\n`;
      for (const f of resp.files) html += `  ${escapeHtml(f)}\n`;
      html += `</div>`;
    }

    if (resp.warnings?.length) {
      html += `<div class="warn-list">`;
      for (const w of resp.warnings) html += `<div class="warn-item">${escapeHtml(w)}</div>`;
      html += `</div>`;
    }

    $result.innerHTML = html;
  } catch (e) {
    $result.className = "show err";
    $result.innerHTML = `<div class="result-title">Error</div><div class="result-detail">${escapeHtml(e.message)}</div>`;
  }

  $btnDownload.textContent = "Download Resource Pack ZIP";
  $btnDownload.disabled = false;
});

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

detectShader();
