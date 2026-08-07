# shadertoy2mc

Converts a ShaderToy shader into a Minecraft **post-effect** (Java, the
`post_effect` pipeline introduced in **26.3-snapshot-3**). Zero dependencies, Node 16+.

Use it two ways — both run the exact same conversion (`core.mjs`):

- **CLI** — `node shadertoy2mc.mjs <inputDir> [options]` (writes into a pack root)
- **Web** — open `index.html`; drop a file or folder, download a `.zip` resource pack.
  Everything runs client-side, so it hosts as static files (e.g. Cloudflare Pages).

```bash
node shadertoy2mc.mjs <inputDir> [options]
```

<img width="720" height="913" alt="screenshot" src="https://github.com/user-attachments/assets/93852ae6-efda-46ba-911b-cb359f76c9e9" />

## How it works

It does **not** parse GLSL. It emits a ShaderToy compatibility shim (`iResolution`,
`iTime`, `iChannel0..3`, …), pastes your `Common` + tab code verbatim, and appends a
`main()` that calls `mainImage()`. This is the same wrapper the ShaderToy player uses,
so most 2D image/buffer shaders port without edits.

## Input layout

Point it at a folder of ShaderToy "tab" files (any of `.txt .glsl .frag .fsh .fs`):

```
myshader/
  Image.txt        (required)
  Common.txt       (optional — shared code, prepended to every pass)
  Buffer A.txt     (optional)  ... up to Buffer D.txt
  bindings.json    (optional — see below)
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--out <dir>` | `.` | Resource-pack root to write into |
| `--name <name>` | input dir name | Effect name (`/post-effect <name>`) |
| `--namespace <ns>` | `minecraft` | Asset namespace for outputs |
| `--time-scale <n>` | `1200` | Seconds that GameTime's 0→1 cycle maps to |
| `--bindings <file>` | `<inputDir>/bindings.json` | iChannel → target map |
| `--dry-run` | | Print output instead of writing files |

## Output

```
assets/<ns>/post_effect/<name>.json
assets/<ns>/shaders/post/<name>.fsh          (Image)
assets/<ns>/shaders/post/<name>_a.fsh         (Buffer A) …
```

Then in game: `/post-effect <name>`.

## Web app

`index.html` + `app.js` + `core.mjs` + `zip.js` are a complete static site — no build
step, no dependencies, nothing uploaded. Drop a single shader file (treated as the
**Image** tab) or a whole folder (with `Common`, `Buffer A–D`, `bindings.json`) and it
returns a ready-to-drop-in `.zip` resource pack, including a generated `pack.mcmeta`.

The page also compiles your **Image** tab into a live WebGL background using the same
shim technique the pack uses, so you get a preview before you download. Multi-pass or
channel-sampling shaders can't be previewed live (they still convert fine).

**Deploy on Cloudflare Pages** (or any static host): point it at the repo root with no
build command. `.mjs`/`.js` are served as ES modules; there's nothing to compile.

> `pack.mcmeta` is written with `min_format`/`max_format` `[92, 0]` (26.3-snapshot-3+).
> On a different snapshot, edit those in the downloaded `pack.mcmeta`.

## Channel bindings

Each `iChannelN` a tab samples becomes a Minecraft input sampler. By default the tool
guesses `iChannel0→Buffer A`, `iChannel1→Buffer B`, …, and (for the Image tab) binds
any leftover channel to `minecraft:main` (the live game view). Override with a
`bindings.json`:

```json
{
  "image": { "0": "buffer_a", "1": "main" },
  "a":     { "0": "buffer_a" }
}
```

Values may be `"buffer_a"`/`"a"`/`"buf_a"`, or `"main"`. Texture / cubemap / keyboard /
audio channels are **not** supported.

## Known limitations (Minecraft, not the tool)

- **8-bit targets.** MC post targets are RGBA8, clamped 0..1. Buffers that store
  distances, positions, or HDR data (not final colors) will band or clip. Such
  "data buffers" usually need to be hand-**inlined** into the reading pass instead —
  the tool flags this but can't do it for you (inlining requires understanding the code).
- **Feedback buffers** (a buffer reading itself / a later buffer) are marked
  `persistent`, but reading+writing one target in a pass is driver-dependent. Verify
  visually; you may need a manual ping-pong between two targets.
- **iMouse** → fixed `(0,0,0,0)` (no mouse in post-effects).
- **iFrame / iDate / iSampleRate / audio / cubemaps** → faked or unsupported.
- **GameTime wraps** every ~20 min, so animation jumps once per cycle. Raise or lower
  `--time-scale` to trade animation speed against how often it wraps.
