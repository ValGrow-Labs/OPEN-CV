import { describe, expect, it } from "vitest";
import { crc32, dosDateTime, makeZip, readZip } from "./zip";

const enc = (s: string) => new TextEncoder().encode(s);

describe("CRC-32", () => {
  it("matches the standard check value and known strings", () => {
    expect(crc32(enc("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(enc("a"))).toBe(0xe8b7be43);
    expect(crc32(enc("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });

  it("can be computed in pieces", () => {
    const whole = crc32(enc("hello world"));
    expect(crc32(enc(" world"), crc32(enc("hello")))).toBe(whole);
  });
});

describe("ZIP writer", () => {
  const entries = [
    { name: "manifest.json", data: enc('{"a":1}') },
    { name: "views/palm.png", data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 128]) },
    { name: "README.txt", data: enc("Ünïcode ✓ text") },
    { name: "empty.bin", data: new Uint8Array(0) },
  ];
  const zip = makeZip(entries.map((e) => ({ ...e, date: new Date(2026, 10, 7, 12, 30, 44) })));

  it("starts with a local header and ends with an end-of-central-directory record", () => {
    const dv = new DataView(zip.buffer);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    const eocd = zip.length - 22;
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
    expect(dv.getUint16(eocd + 8, true)).toBe(entries.length); // entries on this disk
    expect(dv.getUint16(eocd + 10, true)).toBe(entries.length); // entries in total
  });

  it("writes a central directory that points at the right local headers and sizes", () => {
    const dv = new DataView(zip.buffer);
    const eocd = zip.length - 22;
    const centralSize = dv.getUint32(eocd + 12, true);
    const centralStart = dv.getUint32(eocd + 16, true);
    expect(centralStart + centralSize).toBe(eocd);
    let p = centralStart;
    for (const e of entries) {
      expect(dv.getUint32(p, true)).toBe(0x02014b50);
      expect(dv.getUint32(p + 16, true)).toBe(crc32(e.data));
      expect(dv.getUint32(p + 20, true)).toBe(e.data.length); // compressed size = stored size
      expect(dv.getUint32(p + 24, true)).toBe(e.data.length);
      const local = dv.getUint32(p + 42, true);
      expect(dv.getUint32(local, true)).toBe(0x04034b50);
      p += 46 + dv.getUint16(p + 28, true);
    }
    expect(p).toBe(eocd);
  });

  it("round-trips every entry, byte for byte, with the CRC verified", () => {
    const read = readZip(zip);
    expect(read.map((r) => r.name)).toEqual(entries.map((e) => e.name));
    read.forEach((r, i) => {
      expect(r.crcOk).toBe(true);
      expect(Array.from(r.data)).toEqual(Array.from(entries[i].data));
    });
    expect(new TextDecoder().decode(read[2].data)).toBe("Ünïcode ✓ text");
  });

  it("detects a corrupted entry through its CRC", () => {
    const copy = zip.slice();
    const at = new TextEncoder().encode('{"a":1}');
    const start = 30 + "manifest.json".length;
    expect(Array.from(copy.subarray(start, start + at.length))).toEqual(Array.from(at));
    copy[start] ^= 0xff;
    expect(readZip(copy)[0].crcOk).toBe(false);
  });

  it("encodes the date as MS-DOS words", () => {
    const { time, date } = dosDateTime(new Date(2026, 10, 7, 12, 30, 44));
    expect(date).toBe(((2026 - 1980) << 9) | (11 << 5) | 7);
    expect(time).toBe((12 << 11) | (30 << 5) | 22);
  });

  it("refuses unsafe names and non-archives", () => {
    expect(() => makeZip([{ name: "../evil", data: enc("x") }])).toThrow(/bad entry name/);
    expect(() => makeZip([{ name: "/abs", data: enc("x") }])).toThrow(/bad entry name/);
    expect(() => makeZip([{ name: "a\\b", data: enc("x") }])).toThrow(/bad entry name/);
    expect(() => readZip(enc("this is not a zip file at all, just text"))).toThrow(/not a ZIP/);
  });

  it("makes a valid empty archive", () => {
    const empty = makeZip([]);
    expect(empty.length).toBe(22);
    expect(readZip(empty)).toEqual([]);
  });
});
