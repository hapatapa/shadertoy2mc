#!/usr/bin/env node
// shadertoy2mc — convert a ShaderToy shader into a Minecraft post-effect.
//
// It does NOT parse GLSL. Instead it emits a ShaderToy compatibility shim,
// pastes your Common + tab code verbatim, and appends a main() that calls
// mainImage(). That is the same wrapper technique the ShaderToy player uses,
// so almost any 2D image/buffer shader "just works".
//
// Usage:
//   node shadertoy2mc.mjs <inputDir> [options]
//
// Options:
//   --out <dir>         Resource-pack root to write into (default: ".")
//   --name <name>       Effect name (default: sanitized input dir name)
//   --namespace <ns>    Asset namespace (default: "minecraft")
//   --time-scale <n>    Seconds that GameTime's 0..1 cycle maps to (default: 1200)
//   --bindings <file>   JSON mapping iChannels -> targets (see README). If a
//                       bindings.json exists in <inputDir> it is used by default.
//   --dry-run           Print what would be written without touching disk.
//
// Input dir should contain tab files named like ShaderToy tabs:
//   Image.txt (required), Common.txt, Buffer A.txt .. Buffer D.txt
//   (extensions .txt/.glsl/.frag/.fsh/.fs are all accepted)
//
// No external dependencies. Node 16+.

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (key === "dry-run") args.dryRun = true;
      else args[key] = argv[++i];
    } else {
      args._.push(a);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args._.length === 0) {
  console.error("usage: node shadertoy2mc.mjs <inputDir> [--out dir] [--name n] [--namespace ns] [--time-scale 1200] [--bindings file] [--dry-run]");
  process.exit(1);
}

const inputDir = args._[0];
const outRoot = args.out || ".";
const namespace = args.namespace || "minecraft";
const timeScale = Number(args["time-scale"] || 1200);
const dryRun = !!args.dryRun;
const effectName = sanitizeName(args.name || path.basename(path.resolve(inputDir)));

// ---------------------------------------------------------------------------
// Tab discovery
// ---------------------------------------------------------------------------
const BUFFER_LETTERS = ["a", "b", "c", "d"];
// order index drives pass ordering + previous-frame detection
const ORDER = { a: 0, b: 1, c: 2, d: 3, image: 4 };

function sanitizeName(s) {
  return s.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "shadertoy";
}

function classifyTab(filename) {
  const base = filename.replace(/\.[^.]+$/, "").toLowerCase().replace(/\s+/g, " ").trim();
  if (base === "image") return "image";
  if (base === "common") return "common";
  const m = base.match(/^(?:buffer|buf)\s*([a-d])$/) || base.match(/^([a-d])$/);
  if (m) return m[1];
  return null;
}

const ACCEPT_EXT = new Set([".txt", ".glsl", ".frag", ".fsh", ".fs"]);

function readTabs(dir) {
  const tabs = {}; // key -> source
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    console.error(`error: cannot read input dir "${dir}": ${e.message}`);
    process.exit(1);
  }
  for (const f of entries) {
    if (!ACCEPT_EXT.has(path.extname(f).toLowerCase())) continue;
    const kind = classifyTab(f);
    if (!kind) continue;
    tabs[kind] = fs.readFileSync(path.join(dir, f), "utf8");
  }
  return tabs;
}

const tabs = readTabs(inputDir);
if (!tabs.image) {
  console.error(`error: no "Image" tab found in ${inputDir} (need Image.txt / Image.glsl / ...)`);
  process.exit(1);
}

const common = tabs.common || "";
const buffers = BUFFER_LETTERS.filter((l) => tabs[l] != null); // present buffers in order
// pass list: buffers first (a..d), then image
const passKeys = [...buffers, "image"];

// ---------------------------------------------------------------------------
// Channel + feature analysis
// ---------------------------------------------------------------------------
function channelsUsed(src) {
  const set = new Set();
  const re = /iChannel([0-3])/g;
  let m;
  while ((m = re.exec(src))) set.add(Number(m[1]));
  return [...set].sort();
}

// effective source for a tab = common + tab (common is prepended to every pass)
function effectiveSource(key) {
  return common + "\n" + tabs[key];
}

const usedChannels = {}; // key -> [ids]
for (const key of passKeys) usedChannels[key] = channelsUsed(effectiveSource(key));

// ---------------------------------------------------------------------------
// Bindings: iChannel<n> of a tab -> a target
// A target is one of: "buf_a".."buf_d", "main", or "unbound".
// ---------------------------------------------------------------------------
function loadBindings() {
  const explicitPath = args.bindings || path.join(inputDir, "bindings.json");
  if (fs.existsSync(explicitPath)) {
    try {
      return JSON.parse(fs.readFileSync(explicitPath, "utf8"));
    } catch (e) {
      console.error(`error: bindings file ${explicitPath} is not valid JSON: ${e.message}`);
      process.exit(1);
    }
  }
  return null;
}

function bufTarget(letter) {
  return "buf_" + letter;
}

// Guess: iChannel<n> -> the n-th existing buffer (a=0,b=1,...). Leftovers ->
// "main" for the Image pass (a passthrough of the game view), else "unbound".
function guessBinding(passKey, chan) {
  const letter = BUFFER_LETTERS[chan];
  if (letter && tabs[letter] != null) return bufTarget(letter);
  return passKey === "image" ? "main" : "unbound";
}

const explicitBindings = loadBindings();
const bindings = {}; // passKey -> { chan: target }
const warnings = [];

for (const key of passKeys) {
  bindings[key] = {};
  for (const chan of usedChannels[key]) {
    let target;
    if (explicitBindings && explicitBindings[key] && explicitBindings[key][String(chan)] != null) {
      const v = explicitBindings[key][String(chan)];
      // accept "buffer_a"/"a"/"buf_a"/"main"
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

// mark targets that must survive between frames (a pass reads a buffer whose
// pass runs at the same time or later => it needs last frame's contents).
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

// ---------------------------------------------------------------------------
// Feature warnings (things with no faithful post-effect equivalent)
// ---------------------------------------------------------------------------
function noteFeature(re, msg) {
  for (const key of passKeys) {
    if (re.test(effectiveSource(key))) {
      warnings.push(msg);
      return;
    }
  }
}
noteFeature(/\biMouse\b/, "Uses iMouse: post-effects have no mouse. iMouse is fixed at (0,0,0,0) — interactive bits will be static. Wire it to time in the generated shader if you want motion.");
noteFeature(/\biFrame\b/, "Uses iFrame: no real frame counter exists. It is approximated from GameTime and will jump when GameTime wraps (~every 20 min).");
noteFeature(/\biDate\b/, "Uses iDate: not available; fixed at 0.");
noteFeature(/\biSampleRate\b|iChannelTime|fft\b/, "Uses audio inputs: ShaderToy sound/FFT channels are not available in Minecraft.");
noteFeature(/samplerCube|textureCube/, "Uses cubemap channels: not supported by this converter.");

// ---------------------------------------------------------------------------
// Shader (fsh) generation
// ---------------------------------------------------------------------------
function genFragmentShader(passKey) {
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

  // Channel samplers. sampler_name "iChanN" -> uniform iChanNSampler in MC.
  if (chans.length > 0) {
    for (const n of chans) {
      lines.push(`uniform sampler2D iChan${n}Sampler;`);
      lines.push(`#define iChannel${n} iChan${n}Sampler`);
    }
  } else {
    // MC passes want at least one input; declare an unused one bound to main.
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
}

// ---------------------------------------------------------------------------
// post_effect JSON generation
// ---------------------------------------------------------------------------
function targetJsonName(passKey) {
  return passKey === "image" ? namespace + ":main" : bufTarget(passKey);
}

function inputsForPass(passKey) {
  const chans = usedChannels[passKey];
  if (chans.length === 0) {
    return [{ sampler_name: "In", target: namespace + ":main" }];
  }
  return chans.map((n) => {
    const t = bindings[passKey][n];
    const target = t === "main" ? namespace + ":main" : t === "unbound" ? namespace + ":main" : t;
    return { sampler_name: `iChan${n}`, target };
  });
}

function genPostEffectJson() {
  const targets = {};
  for (const l of buffers) {
    const t = bufTarget(l);
    targets[t] = persistent.has(t) ? { persistent: true } : {};
  }
  const passes = passKeys.map((key) => ({
    vertex_shader: "minecraft:core/screenquad", // builtin, always minecraft namespace
    fragment_shader: `${namespace}:post/${effectName}${key === "image" ? "" : "_" + key}`,
    inputs: inputsForPass(key),
    output: targetJsonName(key),
  }));
  return JSON.stringify({ targets, passes }, null, 4) + "\n";
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------
const fshDir = path.join(outRoot, "assets", namespace, "shaders", "post");
const postDir = path.join(outRoot, "assets", namespace, "post_effect");

const outputs = [];
for (const key of passKeys) {
  const fname = `${effectName}${key === "image" ? "" : "_" + key}.fsh`;
  outputs.push({ path: path.join(fshDir, fname), content: genFragmentShader(key) });
}
outputs.push({ path: path.join(postDir, `${effectName}.json`), content: genPostEffectJson() });

if (dryRun) {
  for (const o of outputs) {
    console.log(`\n===== ${o.path} =====`);
    console.log(o.content);
  }
} else {
  fs.mkdirSync(fshDir, { recursive: true });
  fs.mkdirSync(postDir, { recursive: true });
  for (const o of outputs) fs.writeFileSync(o.path, o.content);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log(`\nshadertoy2mc: "${effectName}"  (${passKeys.length} pass${passKeys.length > 1 ? "es" : ""})`);
console.log(`  input:  ${inputDir}`);
console.log(`  tabs:   ${["common", ...buffers.map((b) => "Buffer " + b.toUpperCase()), "Image"].filter((t) => t !== "common" || common).join(", ")}`);
console.log("  passes:");
for (const key of passKeys) {
  const label = key === "image" ? "Image" : "Buffer " + key.toUpperCase();
  const inp = inputsForPass(key).map((i) => `${i.sampler_name}<-${i.target}`).join(", ");
  console.log(`    ${label.padEnd(9)} -> ${targetJsonName(key).padEnd(14)}  [${inp}]`);
}
console.log("  files:");
for (const o of outputs) console.log(`    ${dryRun ? "(dry) " : ""}${o.path}`);

if (warnings.length) {
  console.log(`\n  ⚠ ${warnings.length} warning${warnings.length > 1 ? "s" : ""}:`);
  for (const w of [...new Set(warnings)]) console.log(`    - ${w}`);
  console.log("\n  Note: Minecraft post targets are 8-bit RGBA (0..1). Buffers that store");
  console.log("  data outside that range (distances, positions, HDR) will band or clip.");
  console.log("  Enable in-game with:  /post-effect " + effectName);
} else {
  console.log(`\n  ✔ no warnings. Enable in-game with:  /post-effect ${effectName}`);
}
