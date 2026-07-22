// shadertoy2mc web frontend. Runs the shared core.mjs entirely client-side:
// ingest files -> convert() -> build a .zip resource pack -> download.
// As a bonus, it compiles the uploaded Image tab into the background WebGL
// preview using the same shim technique, so the whole page becomes your shader.

import { convert, classifyTab, hasAcceptedExt, sanitizeName } from "./core.mjs";
import { zipBlob } from "./zip.js";

// Pack format for the target version. The post_effect pipeline landed in
// 26.3-snapshot-3, whose packs use the [major, minor] min_format/max_format
// schema (this is what sibling packs on 26.3 declare). Bump for newer versions.
const PACK_FORMAT = [92, 0];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentTabs = null; // { image, common?, a?..d? }
let currentBindings = null;
let defaultName = "shadertoy";

const $ = (id) => document.getElementById(id);
const els = {
  drop: $("drop"),
  fileInput: $("file-input"),
  dirInput: $("dir-input"),
  pickFiles: $("pick-files"),
  pickDir: $("pick-dir"),
  name: $("opt-name"),
  namespace: $("opt-namespace"),
  timescale: $("opt-timescale"),
  err: $("err"),
  report: $("report"),
  reportBody: $("report-body"),
  reportName: $("report-name"),
  statusDot: $("status-dot"),
  download: $("download"),
  previewNote: $("preview-note"),
};

// ---------------------------------------------------------------------------
// File ingestion
// ---------------------------------------------------------------------------
// Collect { name, text } from a plain FileList / File[].
async function readFileList(files) {
  const out = [];
  for (const f of files) {
    const rel = f.webkitRelativePath || f.name;
    out.push({ name: rel.split("/").pop(), text: await f.text() });
  }
  return out;
}

// Recursively walk a drag-and-drop directory entry.
function readEntry(entry) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file) => resolve([{ name: file.name, file }]), () => resolve([]));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const acc = [];
      const readBatch = () => {
        reader.readEntries(async (batch) => {
          if (!batch.length) {
            const nested = await Promise.all(acc.map(readEntry));
            resolve(nested.flat());
            return;
          }
          acc.push(...batch);
          readBatch();
        }, () => resolve([]));
      };
      readBatch();
    } else {
      resolve([]);
    }
  });
}

async function readDataTransfer(dt) {
  const items = dt.items ? [...dt.items] : [];
  const entries = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
  if (entries.length) {
    const nested = await Promise.all(entries.map(readEntry));
    const flat = nested.flat();
    return Promise.all(
      flat.map(async (e) => ({ name: e.name, text: await e.file.text() }))
    );
  }
  return readFileList([...dt.files]);
}

// Turn a list of { name, text } into tabs + bindings.
function buildTabs(files, sourceLabel) {
  const tabs = {};
  let bindings = null;
  let bindingsError = null;
  const unclassified = [];

  for (const f of files) {
    if (f.name.toLowerCase() === "bindings.json") {
      try {
        bindings = JSON.parse(f.text);
      } catch (e) {
        bindingsError = e.message;
      }
      continue;
    }
    if (!hasAcceptedExt(f.name)) continue;
    const kind = classifyTab(f.name);
    if (kind) tabs[kind] = f.text;
    else unclassified.push(f);
  }

  // A lone, unrecognised shader file is treated as the Image tab.
  if (tabs.image == null && unclassified.length === 1) {
    tabs.image = unclassified[0].text;
    defaultName = unclassified[0].name.replace(/\.[^.]+$/, "");
  } else if (sourceLabel) {
    defaultName = sourceLabel;
  }

  return { tabs, bindings, bindingsError };
}

async function ingest(files, sourceLabel) {
  clearError();
  const built = buildTabs(files, sourceLabel);
  if (built.tabs.image == null) {
    currentTabs = null;
    showError(
      "No <b>Image</b> tab found. Upload a single shader file, or a folder containing " +
        "<code>Image.txt</code> (extensions .txt/.glsl/.frag/.fsh/.fs are all fine)."
    );
    return;
  }
  if (built.bindingsError) {
    showError(`Found a <code>bindings.json</code> but it isn't valid JSON: <code>${escapeHtml(built.bindingsError)}</code>. Ignoring it.`);
  }
  currentTabs = built.tabs;
  currentBindings = built.bindings;
  if (!els.name.value.trim()) els.name.placeholder = `auto → ${sanitizeName(defaultName)}`;
  runConversion();
  updatePreview(currentTabs);
}

// ---------------------------------------------------------------------------
// Conversion + report
// ---------------------------------------------------------------------------
function currentOptions() {
  return {
    name: els.name.value.trim() || undefined,
    defaultName,
    namespace: els.namespace.value.trim() || "minecraft",
    timeScale: Number(els.timescale.value) || 1200,
    bindings: currentBindings,
  };
}

function runConversion() {
  if (!currentTabs) return;
  let result;
  try {
    result = convert(currentTabs, currentOptions());
  } catch (e) {
    showError(e.message === "no-image" ? "No Image tab found." : escapeHtml(e.message));
    return;
  }
  renderReport(result);
  wireDownload(result);
}

function renderReport(r) {
  els.report.hidden = false;
  const warn = r.warnings.length > 0;
  els.statusDot.className = "dot" + (warn ? " warn" : "");
  els.reportName.textContent = `${r.effectName}  ·  ${r.passKeys.length} pass${r.passKeys.length > 1 ? "es" : ""}`;

  const rows = r.passReport
    .map(
      (p) =>
        `<tr><td>${escapeHtml(p.label)}</td><td class="arrow">→</td><td>${escapeHtml(p.output)}</td><td>${escapeHtml(
          p.inputs.join(", ")
        )}</td></tr>`
    )
    .join("");

  const files = r.outputs.map((o) => `<div>${escapeHtml(o.path)}</div>`).join("") + `<div>pack.mcmeta</div>`;

  let warnHtml = "";
  if (warn) {
    warnHtml =
      `<div class="warnings"><h3>⚠ ${r.warnings.length} warning${r.warnings.length > 1 ? "s" : ""}</h3><ul>` +
      r.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("") +
      `</ul></div>`;
  }

  els.reportBody.innerHTML =
    `<table><thead><tr><th>Pass</th><th></th><th>Output</th><th>Inputs</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<div class="file-list">${files}</div>` +
    warnHtml +
    `<div class="enable">Enable in-game: <code>/post-effect ${escapeHtml(r.effectName)}</code></div>`;
}

// ---------------------------------------------------------------------------
// Zip + download
// ---------------------------------------------------------------------------
function packMcmeta(effectName) {
  return (
    JSON.stringify(
      {
        pack: {
          description: `shadertoy2mc: ${effectName}`,
          min_format: PACK_FORMAT,
          max_format: PACK_FORMAT,
        },
      },
      null,
      4
    ) + "\n"
  );
}

function wireDownload(r) {
  els.download.onclick = () => {
    const entries = r.outputs.map((o) => ({ name: o.path, data: strBytes(o.content) }));
    entries.push({ name: "pack.mcmeta", data: strBytes(packMcmeta(r.effectName)) });
    const blob = zipBlob(entries);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${r.effectName}-resourcepack.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
}

function strBytes(s) {
  return new TextEncoder().encode(s);
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function showError(html) {
  els.err.innerHTML = html;
  els.err.hidden = false;
}
function clearError() {
  els.err.hidden = true;
  els.err.innerHTML = "";
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
els.pickFiles.addEventListener("click", (e) => {
  e.stopPropagation();
  els.fileInput.click();
});
els.pickDir.addEventListener("click", (e) => {
  e.stopPropagation();
  els.dirInput.click();
});
els.drop.addEventListener("click", () => els.fileInput.click());
els.drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    els.fileInput.click();
  }
});

els.fileInput.addEventListener("change", async () => {
  if (els.fileInput.files.length) await ingest(await readFileList(els.fileInput.files), null);
  els.fileInput.value = "";
});
els.dirInput.addEventListener("change", async () => {
  const files = [...els.dirInput.files];
  const label = files[0]?.webkitRelativePath?.split("/")[0] || null;
  if (files.length) await ingest(await readFileList(files), label);
  els.dirInput.value = "";
});

["dragenter", "dragover"].forEach((ev) =>
  els.drop.addEventListener(ev, (e) => {
    e.preventDefault();
    els.drop.classList.add("drag");
  })
);
["dragleave", "dragend", "drop"].forEach((ev) =>
  els.drop.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev !== "dragover") els.drop.classList.remove("drag");
  })
);
els.drop.addEventListener("drop", async (e) => {
  const files = await readDataTransfer(e.dataTransfer);
  const label = [...(e.dataTransfer.items || [])]
    .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .find((en) => en && en.isDirectory)?.name || null;
  if (files.length) await ingest(files, label);
});

// Re-run when options change (only if a shader is loaded).
[els.name, els.namespace, els.timescale].forEach((el) =>
  el.addEventListener("input", () => {
    if (currentTabs) runConversion();
  })
);

// ---------------------------------------------------------------------------
// WebGL background preview — the page becomes the shader.
// ---------------------------------------------------------------------------
const DEFAULT_IMAGE = `
void mainImage( out vec4 fragColor, in vec2 fragCoord ) {
    vec2 uv = fragCoord / iResolution.xy;
    float t = iTime * 0.4;
    vec3 col = vec3(uv, 0.5 + 0.5 * sin(t));
    // soft drifting bands to keep it alive
    col += 0.06 * sin(uv.x * 8.0 + t) * sin(uv.y * 8.0 - t);
    fragColor = vec4(col, 1.0);
}`;

const preview = (() => {
  const canvas = els.drop && $("stage");
  const gl = canvas.getContext("webgl2", { antialias: false, powerPreference: "low-power" });
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!gl) return { set: () => {} };

  const VERT = `#version 300 es\nin vec2 p;\nvoid main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

  // 1x1 black texture for any iChannel samplers the shader declares.
  const black = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, black);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

  let program = null;
  let uni = {};
  let raf = 0;
  const start = performance.now();

  function wrap(image, common) {
    return (
      `#version 300 es
precision highp float;
precision highp int;
uniform vec3 iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform float iFrameRate;
uniform int iFrame;
uniform vec4 iMouse;
uniform vec4 iDate;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform sampler2D iChannel3;
float iSampleRate = 44100.0;
float iChannelTime[4];
vec3 iChannelResolution[4];
#define texture2D texture
out vec4 st2mc_fragColor;
` +
      (common ? common + "\n" : "") +
      image +
      `
void main(){
  for (int i = 0; i < 4; i++){ iChannelTime[i] = iTime; iChannelResolution[i] = iResolution; }
  vec4 c = vec4(0.0, 0.0, 0.0, 1.0);
  mainImage(c, gl_FragCoord.xy);
  st2mc_fragColor = vec4(c.rgb, 1.0);
}`
    );
  }

  function compileShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  function build(image, common) {
    const fs = compileShader(gl.FRAGMENT_SHADER, wrap(image, common));
    if (!fs) return false;
    const vs = compileShader(gl.VERTEX_SHADER, VERT);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, "p");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      gl.deleteProgram(prog);
      return false;
    }
    if (program) gl.deleteProgram(program);
    program = prog;
    uni = {
      res: gl.getUniformLocation(prog, "iResolution"),
      time: gl.getUniformLocation(prog, "iTime"),
      frame: gl.getUniformLocation(prog, "iFrame"),
      mouse: gl.getUniformLocation(prog, "iMouse"),
      ch: [0, 1, 2, 3].map((i) => gl.getUniformLocation(prog, "iChannel" + i)),
    };
    return true;
  }

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function frame() {
    resize();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program);
    gl.enableVertexAttribArray(0);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const t = reduce ? 8.0 : (performance.now() - start) / 1000;
    gl.uniform3f(uni.res, canvas.width, canvas.height, 1);
    if (uni.time) gl.uniform1f(uni.time, t);
    if (uni.frame) gl.uniform1i(uni.frame, Math.floor(t * 20));
    if (uni.mouse) gl.uniform4f(uni.mouse, 0, 0, 0, 0);
    uni.ch.forEach((loc, i) => {
      if (loc) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, black);
        gl.uniform1i(loc, i);
      }
    });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!reduce) raf = requestAnimationFrame(frame);
  }

  function run() {
    cancelAnimationFrame(raf);
    if (reduce) frame();
    else raf = requestAnimationFrame(frame);
  }

  // Boot with the canonical ShaderToy gradient.
  build(DEFAULT_IMAGE, "");
  run();
  addEventListener("resize", () => reduce && run());

  return {
    // Try the uploaded Image tab; on any failure keep the current program.
    set(tabs) {
      const ok = build(tabs.image, tabs.common || "");
      if (ok) {
        els.previewNote.hidden = true;
        run();
      } else {
        els.previewNote.hidden = false;
        els.previewNote.textContent =
          "live preview unavailable for this shader (multi-pass or channel inputs) — the pack still converts fine";
      }
    },
  };
})();

function updatePreview(tabs) {
  preview.set(tabs);
}
