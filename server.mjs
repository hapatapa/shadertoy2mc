#!/usr/bin/env node
// shadertoy2mc companion server
//
// Receives shader data from the Firefox extension (which fetches ShaderToy's
// API from a real browser context, bypassing Cloudflare), runs the conversion
// pipeline, and writes the resource pack files to disk.
//
// Usage:
//   node server.mjs [--port 3141] [--out ./output]
//
// Then install the Firefox extension, browse to a ShaderToy shader, and
// click the extension icon to send it here.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { convert } from "./core.mjs";

// ---- Config ----
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const i = args.indexOf("--" + name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback;
}
const PORT = Number(getArg("port", 3141));
const OUT_ROOT = getArg("out", "./output");

// ---- CORS helper ----
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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

// ---- JSON response helper ----
function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ---- Request body reader ----
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// ---- Server ----
const server = http.createServer(async (req, res) => {
  setCORS(res);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ---- GET /status ----
  if (req.method === "GET" && url.pathname === "/status") {
    json(res, 200, { status: "ok", version: "1.0.0", outRoot: path.resolve(OUT_ROOT) });
    return;
  }

  // ---- POST /convert ----
  if (req.method === "POST" && url.pathname === "/convert") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const { shader, options } = body;
    if (!shader || !shader.renderpass || !Array.isArray(shader.renderpass)) {
      json(res, 400, { error: "Missing or invalid 'shader' object (need { renderpass: [...] })" });
      return;
    }

    const { tabs, shaderName } = tabsFromShaderToy(shader);
    if (!tabs.image) {
      json(res, 400, { error: "Shader has no Image pass" });
      return;
    }

    try {
      const result = convert(tabs, {
        name: options?.name,
        defaultName: shaderName || "shadertoy",
        namespace: options?.namespace,
        timeScale: options?.timeScale,
        bindings: options?.bindings || null,
      });

      // Write files
      for (const o of result.outputs) {
        const full = path.join(OUT_ROOT, o.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, o.content);
      }

      const tabList = Object.keys(tabs).map((k) =>
        k === "image" ? "Image" : k === "common" ? "Common" : "Buffer " + k.toUpperCase()
      );

      json(res, 200, {
        effectName: result.effectName,
        shaderName,
        tabs: tabList,
        passes: result.passKeys.length,
        files: result.outputs.map((o) => o.path),
        outRoot: path.resolve(OUT_ROOT),
        warnings: result.warnings,
        enableCommand: `/post-effect ${result.effectName}`,
      });

      console.log(`[convert] "${result.effectName}" (${result.passKeys.length} passes) -> ${OUT_ROOT}`);
      if (result.warnings.length) {
        for (const w of result.warnings) console.log(`  warn: ${w}`);
      }
    } catch (e) {
      console.error(`[convert] error: ${e.message}`);
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ---- POST /convert-tabs (raw tabs, no ShaderToy parsing) ----
  if (req.method === "POST" && url.pathname === "/convert-tabs") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      json(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const { tabs, options } = body;
    if (!tabs || !tabs.image) {
      json(res, 400, { error: "Missing 'tabs.image'" });
      return;
    }

    try {
      const result = convert(tabs, {
        name: options?.name,
        defaultName: options?.defaultName || "shadertoy",
        namespace: options?.namespace,
        timeScale: options?.timeScale,
        bindings: options?.bindings || null,
      });

      for (const o of result.outputs) {
        const full = path.join(OUT_ROOT, o.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, o.content);
      }

      json(res, 200, {
        effectName: result.effectName,
        passes: result.passKeys.length,
        files: result.outputs.map((o) => o.path),
        outRoot: path.resolve(OUT_ROOT),
        warnings: result.warnings,
        enableCommand: `/post-effect ${result.effectName}`,
      });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return;
  }

  // ---- 404 ----
  json(res, 404, { error: `Unknown route: ${req.method} ${url.pathname}` });
});

server.listen(PORT, () => {
  console.log(`shadertoy2mc server listening on http://localhost:${PORT}`);
  console.log(`  output dir: ${path.resolve(OUT_ROOT)}`);
  console.log(`  endpoints:`);
  console.log(`    GET  /status       — health check`);
  console.log(`    POST /convert      — convert ShaderToy API JSON -> resource pack`);
  console.log(`    POST /convert-tabs — convert raw tabs -> resource pack`);
  console.log(``);
  console.log(`Install the Firefox extension and browse to a ShaderToy shader.`);
});
