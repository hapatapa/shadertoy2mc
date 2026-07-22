#!/usr/bin/env node
// shadertoy2mc — convert a ShaderToy shader into a Minecraft post-effect.
//
// It does NOT parse GLSL. Instead it emits a ShaderToy compatibility shim,
// pastes your Common + tab code verbatim, and appends a main() that calls
// mainImage(). That is the same wrapper technique the ShaderToy player uses,
// so almost any 2D image/buffer shader "just works".
//
// The conversion itself lives in core.mjs (shared with the web frontend). This
// file is just the CLI: it reads a folder of tabs off disk and writes the
// generated files into a resource-pack root.
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
import { convert, classifyTab, hasAcceptedExt } from "./core.mjs";

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
const timeScale = Number(args["time-scale"] || 1200);
const dryRun = !!args.dryRun;

// ---------------------------------------------------------------------------
// Read tabs off disk
// ---------------------------------------------------------------------------
function readTabs(dir) {
  const tabs = {};
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    console.error(`error: cannot read input dir "${dir}": ${e.message}`);
    process.exit(1);
  }
  for (const f of entries) {
    if (!hasAcceptedExt(f)) continue;
    const kind = classifyTab(f);
    if (!kind) continue;
    tabs[kind] = fs.readFileSync(path.join(dir, f), "utf8");
  }
  return tabs;
}

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

const tabs = readTabs(inputDir);
if (!tabs.image) {
  console.error(`error: no "Image" tab found in ${inputDir} (need Image.txt / Image.glsl / ...)`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Convert
// ---------------------------------------------------------------------------
let result;
try {
  result = convert(tabs, {
    name: args.name,
    defaultName: path.basename(path.resolve(inputDir)),
    namespace: args.namespace,
    timeScale,
    bindings: loadBindings(),
  });
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}

const { effectName, passKeys, buffers, common, warnings, outputs, passReport } = result;

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------
if (dryRun) {
  for (const o of outputs) {
    console.log(`\n===== ${o.path} =====`);
    console.log(o.content);
  }
} else {
  for (const o of outputs) {
    const full = path.join(outRoot, o.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, o.content);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log(`\nshadertoy2mc: "${effectName}"  (${passKeys.length} pass${passKeys.length > 1 ? "es" : ""})`);
console.log(`  input:  ${inputDir}`);
console.log(`  tabs:   ${["common", ...buffers.map((b) => "Buffer " + b.toUpperCase()), "Image"].filter((t) => t !== "common" || common).join(", ")}`);
console.log("  passes:");
for (const p of passReport) {
  console.log(`    ${p.label.padEnd(9)} -> ${p.output.padEnd(14)}  [${p.inputs.join(", ")}]`);
}
console.log("  files:");
for (const o of outputs) console.log(`    ${dryRun ? "(dry) " : ""}${path.join(outRoot, o.path)}`);

if (warnings.length) {
  console.log(`\n  ⚠ ${warnings.length} warning${warnings.length > 1 ? "s" : ""}:`);
  for (const w of warnings) console.log(`    - ${w}`);
  console.log("\n  Note: Minecraft post targets are 8-bit RGBA (0..1). Buffers that store");
  console.log("  data outside that range (distances, positions, HDR) will band or clip.");
  console.log("  Enable in-game with:  /post-effect " + effectName);
} else {
  console.log(`\n  ✔ no warnings. Enable in-game with:  /post-effect ${effectName}`);
}
