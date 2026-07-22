// shadertoy2mc core — environment-agnostic conversion logic.
//
// No Node or browser APIs: this is pure string manipulation so the CLI
// (shadertoy2mc.mjs) and the web frontend (app.js) share one source of truth.
//
// It does NOT parse GLSL. It emits a ShaderToy compatibility shim, pastes the
// Common + tab code verbatim, and appends a main() that calls mainImage() — the
// same wrapper technique the ShaderToy player uses, so most 2D image/buffer
// shaders "just work".

// ---------------------------------------------------------------------------
// Tab discovery helpers (shared with the uploaders)
// ---------------------------------------------------------------------------
export const BUFFER_LETTERS = ["a", "b", "c", "d"];
// order index drives pass ordering + previous-frame detection
export const ORDER = { a: 0, b: 1, c: 2, d: 3, image: 4 };
export const ACCEPT_EXT = new Set([".txt", ".glsl", ".frag", ".fsh", ".fs"]);

export function sanitizeName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "shadertoy";
}

// Map a ShaderToy-style tab filename to a tab key, or null if it's not a tab.
export function classifyTab(filename) {
  const base = filename.replace(/\.[^.]+$/, "").toLowerCase().replace(/\s+/g, " ").trim();
  if (base === "image") return "image";
  if (base === "common") return "common";
  const m = base.match(/^(?:buffer|buf)\s*([a-d])$/) || base.match(/^([a-d])$/);
  if (m) return m[1];
  return null;
}

export function hasAcceptedExt(filename) {
  const i = filename.lastIndexOf(".");
  if (i < 0) return false;
  return ACCEPT_EXT.has(filename.slice(i).toLowerCase());
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------
function channelsUsed(src) {
  const set = new Set();
  const re = /iChannel([0-3])/g;
  let m;
  while ((m = re.exec(src))) set.add(Number(m[1]));
  return [...set].sort();
}

function bufTarget(letter) {
  return "buf_" + letter;
}

// ---------------------------------------------------------------------------
// convert — the whole pipeline as a pure function.
//
//   tabs:  { image, common?, a?, b?, c?, d? }  (values are GLSL source strings)
//   opts:  { name?, defaultName?, namespace?, timeScale?, bindings? }
//
// Returns { effectName, namespace, timeScale, passKeys, buffers, common,
//           usedChannels, bindings, persistent, warnings, outputs, passReport }
// where outputs is [{ path, content }] with POSIX pack-relative paths.
// Throws Error("no-image") if no Image tab is present.
// ---------------------------------------------------------------------------
export function convert(tabs, opts = {}) {
  if (!tabs || tabs.image == null) {
    throw new Error("no-image");
  }

  const namespace = opts.namespace ? sanitizeName(opts.namespace) : "minecraft";
  const timeScale = Number(opts.timeScale ?? 1200);
  const effectName = sanitizeName(opts.name || opts.defaultName || "shadertoy");
  const explicitBindings = opts.bindings || null;

  const common = tabs.common || "";
  const buffers = BUFFER_LETTERS.filter((l) => tabs[l] != null); // present buffers, in order
  const passKeys = [...buffers, "image"];

  const effectiveSource = (key) => common + "\n" + tabs[key];

  const usedChannels = {};
  for (const key of passKeys) usedChannels[key] = channelsUsed(effectiveSource(key));

  // --- bindings: iChannel<n> of a tab -> "buf_a".."buf_d" | "main" | "unbound"
  const warnings = [];

  const guessBinding = (passKey, chan) => {
    const letter = BUFFER_LETTERS[chan];
    if (letter && tabs[letter] != null) return bufTarget(letter);
    return passKey === "image" ? "main" : "unbound";
  };

  const bindings = {};
  for (const key of passKeys) {
    bindings[key] = {};
    for (const chan of usedChannels[key]) {
      let target;
      if (explicitBindings && explicitBindings[key] && explicitBindings[key][String(chan)] != null) {
        const v = explicitBindings[key][String(chan)];
        const lm = String(v).toLowerCase();
        if (lm === "main" || lm === "minecraft:main") target = "main";
        else if (/^(?:buffer|buf)?\s*_?([a-d])$/.test(lm)) target = bufTarget(lm.match(/([a-d])$/)[1]);
        else {
          target = "unbound";
          warnings.push(`bindings: ${key}.iChannel${chan} = "${v}" is not a buffer or "main"; textures/keyboard/audio channels are not supported.`);
        }
      } else {
        target = guessBinding(key, chan);
      }
      bindings[key][chan] = target;
      if (target === "unbound") {
        warnings.push(`${key}.iChannel${chan}: no matching buffer to bind to — the sampler will be black. Add a bindings.json entry.`);
      }
    }
  }

  // --- persistence: a pass reading a buffer whose pass runs now-or-later needs
  //     last frame's contents.
  const persistent = new Set();
  for (const key of passKeys) {
    for (const chan of usedChannels[key]) {
      const t = bindings[key][chan];
      if (!t.startsWith("buf_")) continue;
      const letter = t.slice(4);
      if (ORDER[letter] >= ORDER[key]) {
        persistent.add(t);
        warnings.push(`${key}.iChannel${chan} reads ${t} which is a feedback/previous-frame buffer. Marked persistent, but MC post targets are 8-bit and reading+writing one target in a pass is driver-dependent — verify visually or split into a manual ping-pong.`);
      }
    }
  }

  // --- feature warnings (things with no faithful post-effect equivalent)
  const noteFeature = (re, msg) => {
    for (const key of passKeys) {
      if (re.test(effectiveSource(key))) {
        warnings.push(msg);
        return;
      }
    }
  };
  noteFeature(/\biMouse\b/, "Uses iMouse: post-effects have no mouse. iMouse is fixed at (0,0,0,0) — interactive bits will be static. Wire it to time in the generated shader if you want motion.");
  noteFeature(/\biFrame\b/, "Uses iFrame: no real frame counter exists. It is approximated from GameTime and will jump when GameTime wraps (~every 20 min).");
  noteFeature(/\biDate\b/, "Uses iDate: not available; fixed at 0.");
  noteFeature(/\biSampleRate\b|iChannelTime|fft\b/, "Uses audio inputs: ShaderToy sound/FFT channels are not available in Minecraft.");
  noteFeature(/samplerCube|textureCube/, "Uses cubemap channels: not supported by this converter.");

  // --- fragment shader generation
  const genFragmentShader = (passKey) => {
    const chans = usedChannels[passKey];
    const isImage = passKey === "image";
    const lines = [];
    lines.push("#version 330");
    lines.push("");
    lines.push("// Generated by shadertoy2mc — do not edit by hand; edit the ShaderToy source instead.");
    lines.push(`// Pass: ${isImage ? "Image" : "Buffer " + passKey.toUpperCase()}`);
    lines.push("");
    lines.push("#moj_import <minecraft:globals.glsl>");
    lines.push("");
    if (chans.length > 0) {
      for (const n of chans) {
        lines.push(`uniform sampler2D iChan${n}Sampler;`);
        lines.push(`#define iChannel${n} iChan${n}Sampler`);
      }
    } else {
      lines.push("uniform sampler2D InSampler; // unused; keeps the pass valid");
    }
    lines.push("");
    lines.push("in vec2 texCoord;");
    lines.push("out vec4 fragColor;");
    lines.push("");
    lines.push("// ---- ShaderToy uniform shim ----");
    lines.push("vec3  iResolution;");
    lines.push("float iTime;");
    lines.push("float iTimeDelta;");
    lines.push("float iFrameRate;");
    lines.push("int   iFrame;");
    lines.push("vec4  iMouse;");
    lines.push("vec4  iDate;");
    lines.push("float iSampleRate;");
    lines.push("float iChannelTime[4];");
    lines.push("vec3  iChannelResolution[4];");
    lines.push("#define texture2D texture   // old ShaderToy compatibility");
    lines.push("");
    if (common.trim()) {
      lines.push("// ---- Common tab ----");
      lines.push(common.trim());
      lines.push("");
    }
    lines.push(`// ---- ${isImage ? "Image" : "Buffer " + passKey.toUpperCase()} tab ----`);
    lines.push(tabs[passKey].trim());
    lines.push("");
    lines.push("// ---- entry point ----");
    lines.push("void main() {");
    lines.push("    iResolution = vec3(ScreenSize, 1.0);");
    lines.push(`    iTime = GameTime * ${timeScale.toFixed(1)};`);
    lines.push("    iTimeDelta = 0.05;");
    lines.push("    iFrameRate = 20.0;");
    lines.push("    iFrame = int(iTime * 20.0);");
    lines.push("    iMouse = vec4(0.0);");
    lines.push("    iDate = vec4(0.0);");
    lines.push("    iSampleRate = 44100.0;");
    lines.push("    for (int i = 0; i < 4; i++) { iChannelTime[i] = iTime; iChannelResolution[i] = iResolution; }");
    lines.push("");
    lines.push("    vec2 fragCoord = texCoord * iResolution.xy;");
    lines.push("    mainImage(fragColor, fragCoord);");
    lines.push("}");
    lines.push("");
    return lines.join("\n");
  };

  // --- post_effect JSON generation
  // The main screen framebuffer is a built-in target and is ALWAYS
  // "minecraft:main", regardless of the pack's asset namespace. Namespacing it
  // (e.g. "sugoroku:main") points at a target that doesn't exist, so the whole
  // post chain fails to load.
  const MAIN = "minecraft:main";
  const targetJsonName = (passKey) => (passKey === "image" ? MAIN : bufTarget(passKey));

  const inputsForPass = (passKey) => {
    const chans = usedChannels[passKey];
    if (chans.length === 0) {
      return [{ sampler_name: "In", target: MAIN }];
    }
    return chans.map((n) => {
      const t = bindings[passKey][n];
      const target = t === "main" ? MAIN : t === "unbound" ? MAIN : t;
      return { sampler_name: `iChan${n}`, target };
    });
  };

  const genPostEffectJson = () => {
    const targets = {};
    for (const l of buffers) {
      const t = bufTarget(l);
      targets[t] = persistent.has(t) ? { persistent: true } : {};
    }
    const passes = passKeys.map((key) => ({
      vertex_shader: "minecraft:core/screenquad",
      fragment_shader: `${namespace}:post/${effectName}${key === "image" ? "" : "_" + key}`,
      inputs: inputsForPass(key),
      output: targetJsonName(key),
    }));
    return JSON.stringify({ targets, passes }, null, 4) + "\n";
  };

  // --- assemble outputs (POSIX, pack-relative)
  const fshDir = `assets/${namespace}/shaders/post`;
  const postDir = `assets/${namespace}/post_effect`;
  const outputs = [];
  for (const key of passKeys) {
    const fname = `${effectName}${key === "image" ? "" : "_" + key}.fsh`;
    outputs.push({ path: `${fshDir}/${fname}`, content: genFragmentShader(key) });
  }
  outputs.push({ path: `${postDir}/${effectName}.json`, content: genPostEffectJson() });

  // --- human-readable per-pass report (for CLI + UI)
  const passReport = passKeys.map((key) => ({
    key,
    label: key === "image" ? "Image" : "Buffer " + key.toUpperCase(),
    output: targetJsonName(key),
    inputs: inputsForPass(key).map((i) => `${i.sampler_name}<-${i.target}`),
  }));

  return {
    effectName,
    namespace,
    timeScale,
    passKeys,
    buffers,
    common,
    usedChannels,
    bindings,
    persistent,
    warnings: [...new Set(warnings)],
    outputs,
    passReport,
  };
}
