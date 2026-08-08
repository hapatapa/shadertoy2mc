#!/usr/bin/env node
// video2mc — convert a video into a Minecraft 26.3+ post-effect that loops.
//
// Stores all video frames in a texture atlas (PNG) and generates a GLSL shader
// that samples from it based on GameTime. No SPIR-V constant pool limits.
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
//   --smooth            Use linear filtering instead of nearest-neighbor
//   --dry-run           Print stats without writing files
//
// Requires: ffmpeg on PATH (system package, e.g. `apt install ffmpeg`)

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

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
      if (key === "dry-run" || key === "smooth") args[key] = true;
      else args[key] = argv[++i];
    } else {
      args._.push(a);
    }
  }
  return args;
}

// ---- Minimal PNG encoder (zero dependencies, uses node:zlib) ----
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (~crc) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, "ascii");
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])), 0);
  return Buffer.concat([len, typeB, data, crcB]);
}

function encodePNG(width, height, rgba) {
  // rgba: Uint8Array of length width * height * 4
  const stride = 1 + width * 4; // 1 filter byte + RGBA pixels
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const si = y * width * 4;
    const di = y * stride;
    raw[di] = 0; // filter: None
    raw.set(rgba.subarray(si, si + width * 4), di + 1);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
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
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ---- Extract frames as raw RGB24 via ffmpeg ----
function extractFrames(file, opts) {
  return new Promise((resolve, reject) => {
    const args = [
      "-i",
      file,
      "-vf",
      "scale=" + opts.width + ":" + opts.height + ",fps=" + opts.fps,
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
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

// ---- Build texture atlas from raw frames ----
function buildAtlas(raw, frameW, frameH, frameCount) {
  const ATLAS_MAX = 4096;
  const cols = Math.min(frameCount, Math.floor(ATLAS_MAX / frameW));
  const rows = Math.ceil(frameCount / cols);
  const atlasW = cols * frameW;
  const atlasH = rows * frameH;
  const atlas = new Uint8Array(atlasW * atlasH * 4); // RGBA, zero-initialized

  for (let f = 0; f < frameCount; f++) {
    const col = f % cols;
    const row = Math.floor(f / cols);
    const frameStart = f * frameW * frameH * 3;

    for (let y = 0; y < frameH; y++) {
      for (let x = 0; x < frameW; x++) {
        const si = frameStart + (y * frameW + x) * 3;
        const di = ((row * frameH + y) * atlasW + col * frameW + x) * 4;
        atlas[di] = raw[si]; // R
        atlas[di + 1] = raw[si + 1]; // G
        atlas[di + 2] = raw[si + 2]; // B
        atlas[di + 3] = 255; // A
      }
    }
  }

  return { atlas, atlasW, atlasH, cols, rows };
}

// ---- Generate GLSL shader ----
function genShader(opts) {
  const {
    width: fw,
    height: fh,
    frameCount,
    fps,
    loopDuration,
    timeScale,
    blendMode,
    atlasW,
    atlasH,
    cols,
    rows,
  } = opts;
  const lines = [];

  lines.push("#version 330");
  lines.push("#extension GL_ARB_separate_shader_objects : require");
  lines.push("");
  lines.push(
    "// Generated by video2mc — video frames stored in texture atlas.",
  );
  lines.push(
    "// " + fw + "x" + fh + ", " + fps + " fps, " + frameCount + " frames, " + loopDuration.toFixed(2) + "s loop",
  );
  lines.push(
    "// Atlas: " + atlasW + "x" + atlasH + " (" + cols + " cols x " + rows + " rows)",
  );
  lines.push("");
  lines.push("#include <minecraft:globals.glsl>");
  lines.push("");
  lines.push("uniform sampler2D iFrameAtlas;");
  if (blendMode !== "replace") {
    lines.push("uniform sampler2D iChan0Sampler;");
    lines.push("#define iChannel0 iChan0Sampler");
  }
  lines.push("");
  lines.push("layout(location = 0) in vec2 texCoord;");
  lines.push("layout(location = 0) out vec4 fragColor;");
  lines.push("");

  // Constants
  lines.push("const int FW = " + fw + ";");
  lines.push("const int FH = " + fh + ";");
  lines.push("const int COLS = " + cols + ";");
  lines.push("const int ROWS = " + rows + ";");
  lines.push("const float FRAME_COUNT = " + frameCount + ".0;");
  lines.push("const float VIDEO_FPS = " + fps + ".0;");
  lines.push("const float LOOP_DUR = " + loopDuration.toFixed(4) + ";");
  lines.push("const float ATLAS_W = " + atlasW + ".0;");
  lines.push("const float ATLAS_H = " + atlasH + ".0;");
  lines.push("");

  lines.push("void main() {");
  lines.push("    float elapsed = GameTime * " + timeScale.toFixed(4) + ";");
  lines.push("    float videoTime = mod(elapsed, LOOP_DUR);");
  lines.push("    float frameF = floor(videoTime * VIDEO_FPS);");
  lines.push("    frameF = clamp(frameF, 0.0, FRAME_COUNT - 1.0);");
  lines.push("");
  lines.push("    int fidx = int(frameF);");
  // GLSL integer division truncates toward zero for positives, same as floor
  lines.push("    int col = fidx - (fidx / COLS) * COLS;");
  lines.push("    int row = fidx / COLS;");
  lines.push("");
  // texCoord: (0,0) = screen top-left, (1,1) = screen bottom-right
  // OpenGL texture: (0,0) = bottom-left, (0,1) = top-left
  // PNG/atlas: row 0 = top, which OpenGL loads at high V
  // So we flip Y: screen top (y=0) -> high V (top of frame in atlas)
  lines.push("    float lu = texCoord.x;");
  lines.push("    float lv = 1.0 - texCoord.y;");
  lines.push("");
  // Map to atlas UV
  lines.push("    float u = (float(col) + lu) * float(FW) / ATLAS_W;");
  lines.push("    float v = (float(row) + lv) * float(FH) / ATLAS_H;");
  lines.push("");
  lines.push("    vec3 videoColor = texture(iFrameAtlas, vec2(u, v)).rgb;");
  lines.push("");

  // Blend with game render
  if (blendMode === "replace") {
    lines.push("    fragColor = vec4(videoColor, 1.0);");
  } else if (blendMode === "overlay") {
    lines.push("    vec3 sc = texture(iChannel0, texCoord).rgb;");
    // Standard overlay blend: base < 0.5 ? 2*base*blend : 1 - 2*(1-base)*(1-blend)
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
  const inputs = [
    {
      sampler_name: "iFrameAtlas",
      target: namespace + ":post/" + effectName + "_atlas",
    },
  ];
  if (blendMode !== "replace") {
    inputs.push({ sampler_name: "iChan0", target: "minecraft:main" });
  }
  const json = {
    passes: [
      {
        vertex_shader: "minecraft:core/screenquad",
        fragment_shader: namespace + ":post/" + effectName,
        inputs: inputs,
        output: "minecraft:main",
      },
    ],
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
      "[--blend replace|overlay|multiply|add] [--smooth] [--dry-run]\n",
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
  const smooth = !!args.smooth;
  const blendMode = args.blend || "replace";

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

  // Compute target dimensions
  let width = targetWidth;
  let height = targetHeight;
  if (height <= 0) {
    height = Math.round((srcHeight / srcWidth) * width);
  }
  width = width & ~1;
  height = height & ~1;

  const duration = maxDuration ? Math.min(maxDuration, srcDuration) : srcDuration;
  const loopDuration = Number(args.loop) || duration;
  const frameCount = Math.ceil(duration * fps);

  process.stderr.write("ok\n");
  process.stderr.write("  Source:   " + srcWidth + "x" + srcHeight + " @ " + srcFps.toFixed(1) + "fps, " + srcDuration.toFixed(1) + "s\n");
  process.stderr.write("  Target:   " + width + "x" + height + " @ " + fps + " fps, " + duration.toFixed(1) + "s, " + frameCount + " frames\n");
  process.stderr.write("  Loop:     every " + loopDuration.toFixed(1) + "s (GameTime-scaled)\n");
  process.stderr.write("  Blend:    " + blendMode + "\n");
  process.stderr.write("Extracting frames... ");

  // Extract frames
  let raw;
  try {
    raw = await extractFrames(videoFile, { width, height, fps, duration: maxDuration });
  } catch (e) {
    process.stderr.write("\nerror: ffmpeg failed: " + e.message + "\n");
    process.exit(1);
  }

  const actualFrames = Math.floor(raw.length / (width * height * 3));
  process.stderr.write("ok (" + actualFrames + " frames)\n");

  // Build texture atlas
  process.stderr.write("Building texture atlas... ");
  const { atlas, atlasW, atlasH, cols, rows } = buildAtlas(raw, width, height, actualFrames);
  process.stderr.write("ok (" + atlasW + "x" + atlasH + ", " + cols + " cols x " + rows + " rows)\n");

  // Encode PNG
  process.stderr.write("Encoding atlas PNG... ");
  const pngBuffer = encodePNG(atlasW, atlasH, atlas);
  process.stderr.write("ok (" + (pngBuffer.length / 1024).toFixed(0) + " KB)\n");

  // Generate shader
  const effectName = sanitizeName(args.name || path.basename(videoFile, path.extname(videoFile)));
  const shaderSource = genShader({
    width, height, frameCount: actualFrames, fps,
    loopDuration, timeScale, blendMode,
    atlasW, atlasH, cols, rows,
  });

  const postJson = genPostEffectJson(effectName, namespace, blendMode);

  // .mcmeta for filtering (blur:false = GL_NEAREST = crisp pixels)
  const mcmeta = JSON.stringify({ texture: { blur: !smooth } }, null, 2) + "\n";

  const fshPath = "assets/" + namespace + "/shaders/post/" + effectName + ".fsh";
  const jsonPath = "assets/" + namespace + "/post_effect/" + effectName + ".json";
  const texPath = "assets/" + namespace + "/textures/post/" + effectName + "_atlas.png";
  const mcmetaPath = texPath + ".mcmeta";
  const outputs = [
    { path: fshPath, content: shaderSource, size: shaderSource.length, desc: "GLSL shader" },
    { path: jsonPath, content: postJson, size: postJson.length, desc: "post_effect JSON" },
    { path: texPath, content: pngBuffer, size: pngBuffer.length, desc: "Atlas texture" },
    { path: mcmetaPath, content: mcmeta, size: mcmeta.length, desc: "Texture metadata" },
  ];

  // Write
  if (dryRun) {
    console.log("\n[Dry run] Would write " + outputs.length + " files to " + path.resolve(outRoot) + ":");
    for (const o of outputs) {
      console.log("  " + o.path + "  (" + (o.size / 1024).toFixed(0) + " KB)  " + o.desc);
    }
  } else {
    for (const o of outputs) {
      const full = path.join(outRoot, o.path);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      if (Buffer.isBuffer(o.content)) {
        fs.writeFileSync(full, o.content);
      } else {
        fs.writeFileSync(full, o.content, "utf8");
      }
    }
  }

  // Report
  console.log("\nvideo2mc: \"" + effectName + "\"");
  console.log("  source:  " + videoFile);
  console.log("  target:  " + width + "x" + height + ", " + fps + " fps, " + actualFrames + " frames, " + loopDuration.toFixed(1) + "s loop");
  console.log("  atlas:   " + atlasW + "x" + atlasH + " (" + (pngBuffer.length / 1024).toFixed(0) + " KB)");
  console.log("  blend:   " + blendMode);
  console.log("  filter:  " + (smooth ? "linear (smooth)" : "nearest (crisp)"));
  console.log("  files:");
  for (const o of outputs) {
    console.log(
      "    " + (dryRun ? "(dry) " : "") + path.join(outRoot, o.path) +
      "  (" + (o.size / 1024).toFixed(0) + " KB)  " + o.desc,
    );
  }
  console.log("");
  console.log("  Enable: /post-effect " + effectName);
}

main();
