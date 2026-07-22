# shadertoy2mc

Converts a ShaderToy shader into a Minecraft **post-effect** (Java, 1.21.9+ / 26.x
post-effect pipeline). Zero dependencies, single file, Node 16+.

```bash
node shadertoy2mc.mjs <inputDir> [options]
```

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
