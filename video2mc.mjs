#!/usr/bin/env node
// video2mc — convert a video into a Minecraft 26.3+ post-effect that loops.
//
// Embeds every frame's pixels as packed RGB floats in a const float[] array
// inside the shader. The shader indexes into the array based on GameTime.
//
// SPIR-V has hard limits on constant pool size, so the tool auto-scales
// resolution and frame count to fit within --max-pixels (default 100000).
// Post effects cannot bind custom textures, so const arrays are the only option.
//
// Usage:
//   node video2mc.mjs <video> [options]
//
// Options:
//   --out <dir>         Resource-pack root (default: ".")
//   --name <name>       Effect name (default: sanitized video filename)
//   --namespace <ns>    Asset namespace (default: "minecraft")
//   --width <n>         Target width in pixels (default: 48)
//   --height <n>        Target height in pixels (default: auto, preserves aspect)
//   --fps <n>           Frame rate to extract (default: 10)
//   --duration <s>      Max duration to extract (default: full video)
//   --time-scale <n>    Multiplier for GameTime (default: 1.0)
//   --loop <s>          Loop period in GameTime-scaled seconds (default: video duration)
//   --blend <mode>      Blend mode: replace | overlay | multiply | add (default: replace)
//   --max-pixels <n>    Max total pixels across all frames (default: 100000)
//   --dry-run           Print stats without writing files
//
// Requires: ffmpeg on PATH (system package, e.g. `apt install ffmpeg`)

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ---- Helpers ----
function sanitizeName(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "") || "video";
}

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

// ---- Get video info via ffprobe ----
function ffprobe(file) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", file],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error("ffprobe exited " + code));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

// ---- Extract frames as raw RGB24 via ffmpeg ----
function extractFrames(file, opts) {
  return new Promise((resolve, reject) => {
    const args = [
      "-i", file,
      "-vf", "scale=" + opts.width + ":" + opts.height + ",fps=" + opts.fps,
      "-pix_fmt", "rgb24",
      "-f", "rawvideo",
    ];
    if (opts.duration) args.push("-t", String(opts.duration));
    args.push("pipe:1");
    const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    proc.stdout.on("data", (c) => chunks.push(c));
    let stderr = "";
    proc.stderr.on("data", (c) => (stderr += c));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error("ffmpeg exited " + code + ": " + stderr.slice(-300)));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

// ---- Pack RGB bytes into a float (3 bytes -> 1 float) ----
function packRGB(r, g, b) {
  return r * 65536 + g * 256 + b;
}

// ---- Auto-scale resolution and frame count to fit maxPixels ----
function autoScale(srcWidth, srcHeight, srcDuration, fps, maxPixels) {
  let width = srcWidth;
  let height = srcHeight;
  let duration = srcDuration;
  let frameCount = Math.ceil(duration * fps);
  let totalPixels = width * height * frameCount;
  const minDim = 4; // don't go below 4x4
  const warnings = [];

  if (totalPixels <= maxPixels) return { width, height, duration, frameCount, totalPixels, warnings };

  // Phase 1: reduce resolution while keeping all frames
  const aspect = srcHeight / srcWidth;
  let bestW = width;
  let bestH = height;
  for (let w = srcWidth; w >= minDim; w -= 2) {
    const h = Math.max(minDim, Math.round(aspect * w) & ~1);
    const px = w * h * frameCount;
    if (px <= maxPixels) { bestW = w; bestH = h; break; }
  }
  if (bestW * bestH * frameCount <= maxPixels) {
    width = bestW; height = bestH;
    totalPixels = width * height * frameCount;
    warnings.push("Resolution reduced to " + width + "x" + height + " to fit SPIR-V constant limit");
    return { width, height, duration, frameCount, totalPixels, warnings };
  }

  // Phase 2: at minimum resolution, reduce frame count
  width = minDim;
  height = Math.max(minDim, Math.round(aspect * minDim) & ~1);
  const maxFrames = Math.floor(maxPixels / (width * height));
  if (maxFrames < 1) {
    process.stderr.write("error: video too large even at " + width + "x" + height + " (need at least 1 frame, max " + maxPixels + " pixels)\n");
    process.exit(1);
  }
  frameCount = maxFrames;
  duration = frameCount / fps;
  totalPixels = width * height * frameCount;
  warnings.push("Resolution reduced to " + width + "x" + height + " and duration truncated to " + duration.toFixed(1) + "s (" + frameCount + " frames) to fit SPIR-V constant limit");
  return { width, height, duration, frameCount, totalPixels, warnings };
}

// ---- Generate GLSL shader ----
function genShader(opts) {
  const { width, height, frameCount, fps, loopDuration, timeScale, blendMode, frameData } = opts;
  const totalPixels = width * height * frameCount;
  const lines = [];

  lines.push("#version 330");
  lines.push("#extension GL_ARB_separate_shader_objects : require");
  lines.push("");
  lines.push("// Generated by video2mc — video embedded as packed RGB float array.");
  lines.push("// " + width + "x" + height + ", " + fps + " fps, " + frameCount + " frames, " + loopDuration.toFixed(2) + "s loop");
  lines.push("// Total: " + totalPixels + " pixels (" + ((totalPixels * 4) / 1024).toFixed(0) + " KB SPIR-V constant data)");
  lines.push("");
  lines.push("#include <minecraft:globals.glsl>");
  lines.push("");
  if (blendMode !== "replace") {
    lines.push("uniform sampler2D iChan0Sampler;");
    lines.push("#define iChannel0 iChan0Sampler");
    lines.push("");
  }
  lines.push("layout(location = 0) in vec2 texCoord;");
  lines.push("layout(location = 0) out vec4 fragColor;");
  lines.push("");

  // Emit the packed frame data
  lines.push("const float FRAME_DATA[" + totalPixels + "] = float[" + totalPixels + "](");
  for (let i = 0; i < frameData.length; i += 16) {
    const row = frameData.slice(i, Math.min(i + 16, frameData.length));
    const comma = i + 16 < frameData.length ? "," : "";
    lines.push("    " + row.join(", ") + comma);
  }
  lines.push(");");
  lines.push("");

  // Constants
  lines.push("const int FW = " + width + ";");
  lines.push("const int FH = " + height + ";");
  lines.push("const float FRAME_COUNT = " + frameCount + ".0;");
  lines.push("const float VIDEO_FPS = " + fps + ".0;");
  lines.push("const float LOOP_DUR = " + loopDuration.toFixed(4) + ";");
  lines.push("");

  // Unpack helper
  lines.push("vec3 unpackRGB(float v) {");
  lines.push("    float r = floor(v / 65536.0) / 255.0;");
  lines.push("    float g = floor(mod(v, 65536.0) / 256.0) / 255.0;");
  lines.push("    float b = mod(v, 256.0) / 255.0;");
  lines.push("    return vec3(r, g, b);");
  lines.push("}");
  lines.push("");

  // Main
  lines.push("void main() {");
  lines.push("    float elapsed = GameTime * " + timeScale.toFixed(4) + ";");
  lines.push("    float videoTime = mod(elapsed, LOOP_DUR);");
  lines.push("    float frameF = floor(videoTime * VIDEO_FPS);");
  lines.push("    frameF = clamp(frameF, 0.0, FRAME_COUNT - 1.0);");
  lines.push("");
  lines.push("    int px = int(texCoord.x * float(FW));");
  lines.push("    int py = int(texCoord.y * float(FH));");
  lines.push("    px = clamp(px, 0, FW - 1);");
  lines.push("    py = clamp(py, 0, FH - 1);");
  lines.push("    py = FH - 1 - py; // flip Y");
  lines.push("");
  lines.push("    int fidx = int(frameF);");
  lines.push("    int offset = fidx * FW * FH;");
  lines.push("    int idx = offset + py * FW + px;");
  lines.push("    vec3 videoColor = unpackRGB(FRAME_DATA[idx]);");
  lines.push("");

  // Blend with game
  if (blendMode === "replace") {
    lines.push("    fragColor = vec4(videoColor, 1.0);");
  } else if (blendMode === "overlay") {
    lines.push("    vec3 sc = texture(iChannel0, texCoord).rgb;");
    // Standard overlay: base < 0.5 ? 2*base*blend : 1 - 2*(1-base)*(1-blend)
    lines.push("    vec3 ov = vec3(");
    lines.push("        sc.r < 0.5 ? 2.0 * sc.r * videoColor.r : 1.0 - 2.0 * (1.0 - sc.r) * (1.0 - videoColor.r),");
    lines.push("        sc.g < 0.5 ? 2.0 * sc.g * videoColor.g : 1.0 - 2.0 * (1.0 - sc.g) * (1.0 - videoColor.g),");
    lines.push("        sc.b < 0.5 ? 2.0 * sc.b * videoColor.b : 1.0 - 2.0 * (1.0 - sc.b) * (1.0 - videoColor.b)");
    lines.push("    );");
    lines.push("    fragColor = vec4(clamp(ov, 0.0, 1.0), 1.0);");
  } else if (blendMode === "multiply") {
    lines.push("    vec3 sc = texture(iChannel0, texCoord).rgb;");
    lines.push("    fragColor = vec4(sc * videoColor, 1.0);");
  } else if (blendMode === "add") {
    lines.push("    vec3 sc = texture(iChannel0, texCoord).rgb;");
    lines.push("    fragColor = vec4(clamp(sc + videoColor, 0.0, 1.0), 1.0);");
  } else {
    lines.push("    fragColor = vec4(videoColor, 1.0);");
  }

  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// ---- Generate post_effect JSON ----
function genPostEffectJson(effectName, namespace, blendMode) {
  const inputs = [];
  if (blendMode !== "replace") {
    inputs.push({ sampler_name: "iChan0", target: "minecraft:main" });
  }
  const json = {
    passes: [{
      vertex_shader: "minecraft:core/screenquad",
      fragment_shader: namespace + ":post/" + effectName,
      inputs: inputs,
      output: "minecraft:main",
    }],
  };
  return JSON.stringify(json, null, 4) + "\n";
}

// ---- Main ----
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const videoFile = args._[0];
  if (!videoFile) {
    process.stderr.write(
      "usage: node video2mc.mjs <video> [--out dir] [--name n] [--width 48] [--height auto] " +
      "[--fps 10] [--duration s] [--time-scale 1.0] [--loop s] " +
      "[--blend replace|overlay|multiply|add] [--max-pixels 100000] [--dry-run]\n",
    );
    process.exit(1);
  }
  if (!fs.existsSync(videoFile)) {
    process.stderr.write("error: file not found: " + videoFile + "\n");
    process.exit(1);
  }

  const outRoot = args.out || ".";
  const namespace = sanitizeName(args.namespace || "minecraft");
  const targetWidth = Number(args.width || 48);
  const targetHeight = args.height === "auto" ? -1 : Number(args.height || -1);
  const fps = Number(args.fps || 10);
  const maxDuration = args.duration ? Number(args.duration) : null;
  const timeScale = Number(args["time-scale"] || 1.0);
  const dryRun = !!args["dry-run"];
  const blendMode = args.blend || "replace";
  const maxPixels = Number(args["max-pixels"] || 100000);

  // Get video info
  process.stderr.write("Probing " + videoFile + "... ");
  let info;
  try {
    info = await ffprobe(videoFile);
  } catch (e) {
    process.stderr.write("\nerror: ffprobe failed: " + e.message + "\n");
    process.exit(1);
  }
  const videoStream = info.streams.find((s) => s.codec_type === "video");
  if (!videoStream) {
    process.stderr.write("\nerror: no video stream found\n");
    process.exit(1);
  }
  const srcWidth = videoStream.width;
  const srcHeight = videoStream.height;
  const srcDuration = Number(info.format.duration);
  const srcFps = eval(videoStream.r_frame_rate) || 30;

  // Compute initial target dimensions
  let width = targetWidth;
  let height = targetHeight;
  if (height <= 0) {
    height = Math.round((srcHeight / srcWidth) * width);
  }
  width = width & ~1;
  height = height & ~1;

  const duration = maxDuration ? Math.min(maxDuration, srcDuration) : srcDuration;
  const loopDuration = Number(args.loop) || duration;

  // Auto-scale to fit SPIR-V constant pool limit
  const scaled = autoScale(width, height, duration, fps, maxPixels);
  if (scaled.warnings.length) {
    for (const w of scaled.warnings) {
      process.stderr.write("WARNING: " + w + "\n");
    }
  }

  const { width: finalW, height: finalH, duration: finalDur, frameCount, totalPixels } = scaled;

  process.stderr.write("ok\n");
  process.stderr.write("  Source:   " + srcWidth + "x" + srcHeight + " @ " + srcFps.toFixed(1) + "fps, " + srcDuration.toFixed(1) + "s\n");
  process.stderr.write("  Target:   " + finalW + "x" + finalH + " @ " + fps + " fps, " + finalDur.toFixed(1) + "s, " + frameCount + " frames\n");
  process.stderr.write("  Pixels:   " + totalPixels + " (" + ((totalPixels * 4) / 1024).toFixed(0) + " KB SPIR-V const data, limit " + maxPixels + ")\n");
  process.stderr.write("  Loop:     every " + loopDuration.toFixed(1) + "s (GameTime-scaled)\n");
  process.stderr.write("  Blend:    " + blendMode + "\n");
  process.stderr.write("Extracting frames... ");

  // Extract frames (use final scaled dimensions, and limit duration if needed)
  let raw;
  try {
    raw = await extractFrames(videoFile, { width: finalW, height: finalH, fps, duration: finalDur });
  } catch (e) {
    process.stderr.write("\nerror: ffmpeg failed: " + e.message + "\n");
    process.exit(1);
  }

  const actualFrames = Math.floor(raw.length / (finalW * finalH * 3));
  process.stderr.write("ok (" + actualFrames + " frames)\n");

  // Pack pixels
  process.stderr.write("Packing pixels... ");
  const pixelCount = finalW * finalH * actualFrames;
  const frameData = new Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const off = i * 3;
    frameData[i] = packRGB(raw[off], raw[off + 1], raw[off + 2]);
  }
  process.stderr.write("ok\n");

  // Generate
  const effectName = sanitizeName(args.name || path.basename(videoFile, path.extname(videoFile)));
  const shaderSource = genShader({
    width: finalW, height: finalH, frameCount: actualFrames, fps,
    loopDuration, timeScale, blendMode, frameData,
  });

  const postJson = genPostEffectJson(effectName, namespace, blendMode);

  const fshPath = "assets/" + namespace + "/shaders/post/" + effectName + ".fsh";
  const jsonPath = "assets/" + namespace + "/post_effect/" + effectName + ".json";
  const outputs = [
    { path: fshPath, content: shaderSource, size: shaderSource.length },
    { path: jsonPath, content: postJson, size: postJson.length },
  ];

  // Write
  if (dryRun) {
    console.log("\n[Dry run] Would write " + outputs.length + " files to " + path.resolve(outRoot) + ":");
    for (const o of outputs) {
      console.log("  " + o.path + "  (" + (o.size / 1024).toFixed(0) + " KB)");
    }
  } else {
    for (const o of outputs) {
      const full = path.join(outRoot, o.path);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, o.content, "utf8");
    }
  }

  // Report
  console.log("\nvideo2mc: \"" + effectName + "\"");
  console.log("  source:  " + videoFile);
  console.log("  target:  " + finalW + "x" + finalH + ", " + fps + " fps, " + actualFrames + " frames, " + loopDuration.toFixed(1) + "s loop");
  console.log("  pixels:  " + (finalW * finalH * actualFrames) + " (" + ((finalW * finalH * actualFrames * 4) / 1024).toFixed(0) + " KB)");
  console.log("  blend:   " + blendMode);
  console.log("  files:");
  for (const o of outputs) {
    console.log("    " + (dryRun ? "(dry) " : "") + path.join(outRoot, o.path) + "  (" + (o.size / 1024).toFixed(0) + " KB)");
  }
  console.log("");
  console.log("  Enable: /post-effect " + effectName);
}

main();
