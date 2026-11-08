// Reading the page's stored ZIPs (TEST FIXTURES only).
import { describe, expect, it } from "vitest";
import { makeZip } from "../capture/zip";
import { readStoredZip, text, ZipReadError } from "./zipRead";

const enc = new TextEncoder();
const zip = () => makeZip([{ name: "a.txt", data: enc.encode("hello") }, { name: "dir/b.json", data: enc.encode('{"x":1}') }]);

describe("readStoredZip", () => {
  it("reads every stored entry of a ZIP made by the page's writer", () => {
    const z = readStoredZip(zip());
    expect(z.names).toEqual(["a.txt", "dir/b.json"]);
    expect(text(z.files.get("a.txt")!)).toBe("hello");
  });

  it("refuses a compressed entry with a message saying what to do", () => {
    const b = zip();
    const dv = new DataView(b.buffer);
    // set the method of the first central-directory entry to 8 (deflate)
    const eocd = b.length - 22;
    const central = dv.getUint32(eocd + 16, true);
    dv.setUint16(central + 10, 8, true);
    expect(() => readStoredZip(b, "x.zip")).toThrow(ZipReadError);
    expect(() => readStoredZip(b, "x.zip")).toThrow(/compressed.*re-packed with compression.*extracted folder/);
  });

  it("refuses a damaged entry (CRC) and something that is not a ZIP", () => {
    const b = zip();
    b[30 + "a.txt".length] ^= 0xff; // first byte of a.txt's data
    expect(() => readStoredZip(b)).toThrow(/CRC/);
    expect(() => readStoredZip(enc.encode("not a zip at all, just text"))).toThrow(/not a ZIP/);
  });
});
