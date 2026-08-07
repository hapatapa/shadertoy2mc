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
//   node shadertoy2mc.mjs <inputDir|shadertoyUrl|shaderId> [options]
//
// Options:
//   --out <dir>         Resource-pack root to write into (default: ".")
//   --name <name>       Effect name (default: sanitized dir name or ShaderToy title)
//   --namespace <ns>    Asset namespace (default: "minecraft")
//   --time-scale <n>    Seconds that GameTime's 0..1 cycle maps to (default: 1200)
//   --bindings <file>   JSON mapping iChannels -> targets (see README). If a
//                       bindings.json exists in <inputDir> it is used by default.
//   --cookie <string>   Cookie string for ShaderToy (bypasses Cloudflare).
//                       Get cf_clearance from your browser's DevTools → Application
//                       → Cookies for shadertoy.com, then pass the full Cookie
//                       header value, e.g. "cf_clearance=abc...".
//   --dry-run           Print what would be written without touching disk.
//
// Input can be:
//   - A directory of tab files (Image.txt, Common.txt, Buffer A.txt .. D.txt)
//   - A ShaderToy URL (e.g. https://shadertoy.com/view/Ms2SD1)
//   - A bare ShaderToy shader ID (e.g. Ms2SD1)
//   (extensions .txt/.glsl/.frag/.fsh/.fs are all accepted)
//
// No external dependencies. Node 16+.

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { convert, classifyTab, hasAcceptedExt, sanitizeName } from "./core.mjs";

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
  console.error("usage: node shadertoy2mc.mjs <inputDir|shadertoyUrl|shaderId> [--out dir] [--name n] [--namespace ns] [--time-scale 1200] [--bindings file] [--cookie str] [--dry-run]");
  process.exit(1);
}

const input = args._[0];
const outRoot = args.out || ".";
const timeScale = Number(args["time-scale"] || 1200);
const dryRun = !!args.dryRun;

// ---------------------------------------------------------------------------
// ShaderToy URL / ID detection
// ---------------------------------------------------------------------------
const SHADERTOY_ID_RE = /^[A-Za-z0-9]{4,10}$/;
const SHADERTOY_URL_RE = /shadertoy\.com\/(?:view|new)\/([A-Za-z0-9]+)/i;

function extractShaderId(input) {
  // Bare ID like "Ms2SD1" — only if no local path matches
  if (SHADERTOY_ID_RE.test(input) && !fs.existsSync(input)) {
    return input;
  }
  // URL like https://shadertoy.com/view/Ms2SD1
  const m = input.match(SHADERTOY_URL_RE);
  if (m) return m[1];
  return null;
}

const shaderId = extractShaderId(input);
const isUrl = shaderId !== null;

// ---------------------------------------------------------------------------
// Fetch shader from ShaderToy API
// ---------------------------------------------------------------------------
function fetchShaderToy(id) {
  return new Promise((resolve, reject) => {
    const url = `https://www.shadertoy.com/api/v1/shaders/${id}`;
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: `https://www.shadertoy.com/view/${id}`,
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    };
    if (args.cookie) {
      headers["Cookie"] = args.cookie;
    }
    https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchShaderToy(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode === 403) {
        res.resume();
        // Collect response body for debugging
        reject(new Error("cf_403"));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`ShaderToy API returned ${res.statusCode} for shader "${id}"`));
        return;
      }
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          if (!json.Shader) {
            reject(new Error(`ShaderToy API returned unexpected response for shader "${id}"`));
            return;
          }
          resolve(json.Shader);
        } catch (e) {
          reject(new Error(`Failed to parse ShaderToy API response for shader "${id}": ${e.message}`));
        }
      });
    }).on("error", reject);
  });
}

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
      // "Buffer A" -> "a", "Buffer B" -> "b", etc.
      const letter = name.replace(/\s*buffer\s*/i, "").trim().toLowerCase();
      if (/^[a-d]$/.test(letter)) {
        tabs[letter] = code;
      }
    }
  }

  return { tabs, shaderName: shader.info?.name || null };
}

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

function loadBindings(inputDir) {
  const explicitPath = args.bindings || (inputDir && path.join(inputDir, "bindings.json"));
  if (explicitPath && fs.existsSync(explicitPath)) {
    try {
      return JSON.parse(fs.readFileSync(explicitPath, "utf8"));
    } catch (e) {
      console.error(`error: bindings file ${explicitPath} is not valid JSON: ${e.message}`);
      process.exit(1);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  let tabs;
  let defaultName;
  let inputLabel;

  if (isUrl) {
    // ---- ShaderToy URL / ID path ----
    inputLabel = `shadertoy:${shaderId}`;
    process.stderr.write(`Fetching shader ${shaderId} from ShaderToy... `);
    let shader;
    try {
      shader = await fetchShaderToy(shaderId);
    } catch (e) {
      if (e.message === "cf_403") {
        process.stderr.write("blocked by Cloudflare\n");
        console.error(`
error: ShaderToy returned 403 (Cloudflare block).

Options:
  1. Pass your browser cookie with --cookie:
     Open shadertoy.com in your browser → DevTools (F12) →
     Application → Cookies → copy the cf_clearance value, then:
       node shadertoy2mc.mjs ${shaderId} --cookie "cf_clearance=<value>"

  2. Save the shader locally and use the directory path:
     Save each tab (Image, Common, Buffer A-D) as .txt files in a
     folder, then point the tool at that folder.
`);
      } else {
        process.stderr.write("failed\n");
        console.error(`error: ${e.message}`);
      }
      process.exit(1);
    }
    process.stderr.write("ok\n");
    const parsed = tabsFromShaderToy(shader);
    tabs = parsed.tabs;
    defaultName = parsed.shaderName || shaderId;
    if (!tabs.image) {
      console.error(`error: shader "${shaderId}" has no Image pass`);
      process.exit(1);
    }
    const tabList = Object.keys(tabs).map((k) => k === "image" ? "Image" : k === "common" ? "Common" : "Buffer " + k.toUpperCase());
    process.stderr.write(`  tabs: ${tabList.join(", ")}\n`);
  } else {
    // ---- Local directory path ----
    inputLabel = input;
    tabs = readTabs(input);
    defaultName = path.basename(path.resolve(input));
    if (!tabs.image) {
      console.error(`error: no "Image" tab found in ${input} (need Image.txt / Image.glsl / ...)`);
      process.exit(1);
    }
  }

  // Convert
  let result;
  try {
    result = convert(tabs, {
      name: args.name,
      defaultName,
      namespace: args.namespace,
      timeScale,
      bindings: loadBindings(isUrl ? null : input),
    });
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }

  const { effectName, passKeys, buffers, common, warnings, outputs, passReport } = result;

  // Emit
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

  // Report
  console.log(`\nshadertoy2mc: "${effectName}"  (${passKeys.length} pass${passKeys.length > 1 ? "es" : ""})`);
  console.log(`  input:  ${inputLabel}`);
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
}

main();
