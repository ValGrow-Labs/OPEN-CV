// A tiny ZIP writer (stored, no compression, no dependency) and reader, for the capture bundle. PNG and JPEG are already
// compressed, so storing them loses little. The reader exists so tests and the self-check can open what the writer made.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE 802.3, the one ZIP uses). `crc32(new TextEncoder().encode("123456789"))` is 0xCBF43926. */
export function crc32(bytes: Uint8Array, previous = 0): number {
  let c = ~previous >>> 0;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

export interface ZipEntry {
  /** Path inside the archive, forward slashes, no leading slash. */
  name: string;
  data: Uint8Array;
  /** Modification time (default: now). */
  date?: Date;
}

const u16 = (v: DataView, o: number, x: number) => v.setUint16(o, x, true);
const u32 = (v: DataView, o: number, x: number) => v.setUint32(o, x >>> 0, true);

/** MS-DOS time and date words. */
export function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Build a ZIP archive (method 0, "stored") of the entries, in order. */
export function makeZip(entries: readonly ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const prepared = entries.map((e) => {
    if (e.name.startsWith("/") || e.name.includes("\\") || e.name.includes("..")) throw new Error(`bad entry name: ${e.name}`);
    return { ...e, nameBytes: enc.encode(e.name), crc: crc32(e.data), dos: dosDateTime(e.date ?? new Date()) };
  });
  if (prepared.length > 0xffff) throw new Error("too many entries");
  let size = 22;
  for (const p of prepared) size += 30 + p.nameBytes.length + p.data.length + 46 + p.nameBytes.length;
  if (size > 0xffffffff) throw new Error("archive too large for the classic ZIP format");
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  const offsets: number[] = [];
  let o = 0;
  for (const p of prepared) {
    offsets.push(o);
    u32(dv, o, 0x04034b50);
    u16(dv, o + 4, 20); // version needed
    u16(dv, o + 6, 0x0800); // UTF-8 names
    u16(dv, o + 8, 0); // stored
    u16(dv, o + 10, p.dos.time);
    u16(dv, o + 12, p.dos.date);
    u32(dv, o + 14, p.crc);
    u32(dv, o + 18, p.data.length);
    u32(dv, o + 22, p.data.length);
    u16(dv, o + 26, p.nameBytes.length);
    u16(dv, o + 28, 0);
    out.set(p.nameBytes, o + 30);
    out.set(p.data, o + 30 + p.nameBytes.length);
    o += 30 + p.nameBytes.length + p.data.length;
  }
  const centralStart = o;
  prepared.forEach((p, i) => {
    u32(dv, o, 0x02014b50);
    u16(dv, o + 4, 20); // version made by
    u16(dv, o + 6, 20); // version needed
    u16(dv, o + 8, 0x0800);
    u16(dv, o + 10, 0);
    u16(dv, o + 12, p.dos.time);
    u16(dv, o + 14, p.dos.date);
    u32(dv, o + 16, p.crc);
    u32(dv, o + 20, p.data.length);
    u32(dv, o + 24, p.data.length);
    u16(dv, o + 28, p.nameBytes.length);
    u16(dv, o + 30, 0); // extra
    u16(dv, o + 32, 0); // comment
    u16(dv, o + 34, 0); // disk
    u16(dv, o + 36, 0); // internal attributes
    u32(dv, o + 38, 0); // external attributes
    u32(dv, o + 42, offsets[i]);
    out.set(p.nameBytes, o + 46);
    o += 46 + p.nameBytes.length;
  });
  const centralSize = o - centralStart;
  u32(dv, o, 0x06054b50);
  u16(dv, o + 4, 0);
  u16(dv, o + 6, 0);
  u16(dv, o + 8, prepared.length);
  u16(dv, o + 10, prepared.length);
  u32(dv, o + 12, centralSize);
  u32(dv, o + 16, centralStart);
  u16(dv, o + 20, 0);
  return out;
}

export interface ZipListing {
  name: string;
  size: number;
  crc: number;
  /** The entry's bytes (stored entries only). */
  data: Uint8Array;
  /** True when the CRC-32 of `data` matches the directory. */
  crcOk: boolean;
}

/** Read the central directory of an archive made by `makeZip` (stored entries only) and verify every CRC. */
export function readZip(bytes: Uint8Array): ZipListing[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP archive (no end-of-central-directory record)");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: ZipListing[] = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (method !== 0) throw new Error(`entry ${name} is compressed (method ${method}); only stored entries are supported`);
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    out.push({ name, size, crc, data, crcOk: crc32(data) === crc });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
