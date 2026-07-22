// Minimal ZIP writer (STORE / no compression). No dependencies, works in the
// browser and in Node. Enough to bundle a handful of small text files into a
// valid .zip that any unzip tool (and Minecraft) can open.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(arrs) {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

const u16 = (v) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
const u32 = (v) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

// entries: [{ name: string, data: Uint8Array }]  ->  array of Uint8Array chunks.
export function zipChunks(entries) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const data = e.data;
    const crc = crc32(data);
    const size = data.length;

    const local = concat([
      u32(0x04034b50),
      u16(20), u16(0), u16(0), u16(0), u16(0), // version, flags, method(store), time, date
      u32(crc), u32(size), u32(size),
      u16(nameBytes.length), u16(0),
      nameBytes,
    ]);
    chunks.push(local, data);

    central.push(
      concat([
        u32(0x02014b50),
        u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(size), u32(size),
        u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(offset),
        nameBytes,
      ])
    );
    offset += local.length + data.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) {
    chunks.push(c);
    centralSize += c.length;
  }
  chunks.push(
    concat([
      u32(0x06054b50),
      u16(0), u16(0),
      u16(entries.length), u16(entries.length),
      u32(centralSize), u32(centralStart),
      u16(0),
    ])
  );

  return chunks;
}

// Browser convenience: a Blob ready for download.
export function zipBlob(entries) {
  return new Blob(zipChunks(entries), { type: "application/zip" });
}
