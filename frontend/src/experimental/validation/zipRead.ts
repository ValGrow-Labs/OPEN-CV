// Read the capture page's export ZIPs (EXPERIMENTAL validation tooling). The page writes STORED (uncompressed) archives
// with capture/zip.ts; this reader accepts only those. A ZIP re-packed by an archive tool (Windows "Send to compressed
// folder", 7-Zip defaults) is DEFLATE-compressed: it is refused with a message saying what to do, never guessed at.
// Works in Node and in the browser (Uint8Array in, no Node API).
import { readZip } from "../capture/zip";

export interface ZipFiles {
  /** Entry name (forward slashes) to bytes. */
  files: Map<string, Uint8Array>;
  names: string[];
}

export class ZipReadError extends Error {}

/** Read every entry of a stored ZIP and verify its CRC. Throws ZipReadError with a plain message on anything else. */
export function readStoredZip(bytes: Uint8Array, label = "the archive"): ZipFiles {
  let listing;
  try {
    listing = readZip(bytes);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/compressed/.test(msg))
      throw new ZipReadError(
        `${label}: ${msg}. The capture page writes uncompressed (stored) ZIPs; this one was re-packed with compression. ` +
          `Use the ZIP exactly as the page saved it, or extract it and point the tool at the extracted folder.`,
      );
    throw new ZipReadError(`${label}: ${msg}`);
  }
  const files = new Map<string, Uint8Array>();
  for (const e of listing) {
    if (!e.crcOk) throw new ZipReadError(`${label}: entry ${e.name} fails its CRC check (the file is damaged); it is not read.`);
    if (e.data.length !== e.size) throw new ZipReadError(`${label}: entry ${e.name} is truncated.`);
    if (files.has(e.name)) throw new ZipReadError(`${label}: entry ${e.name} appears twice.`);
    files.set(e.name, e.data);
  }
  return { files, names: listing.map((e) => e.name) };
}

const dec = new TextDecoder();
export const text = (b: Uint8Array): string => dec.decode(b);
