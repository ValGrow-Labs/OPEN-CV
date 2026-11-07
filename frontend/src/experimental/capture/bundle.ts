// Builds the local capture bundle (an uncompressed ZIP) from the views captured in this page. Built in the browser, handed to
// the person as a download; never uploaded. Layout:
//   manifest.json      everything about the capture except the pixels (see manifest.ts)
//   README.txt         says the images are personal data
//   views/NN-<view>.png          the captured frame
//   masks/NN-<view>.png          the experimental hand mask (white = hand), when there is one
//   highres/NN-<view>.<ext>      the optional still from the browser's photo API
import type { DepthCapabilityReport } from "../depth";
import type { PoseConsistencyResult } from "../geometry";
import { BUNDLE_README, buildManifest, type ManifestInput } from "./manifest";
import { pixelsToPng } from "./render";
import type { CapturedView } from "./types";
import { makeZip, type ZipEntry } from "./zip";

export interface BundleContext {
  createdAt: Date;
  device: ManifestInput["device"];
  config: ManifestInput["config"];
  poseConsistency: PoseConsistencyResult | null;
  depth: DepthCapabilityReport | null;
}

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
const nn = (n: number) => String(n).padStart(2, "0");
const extOf = (mime: string) => (mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg");

export interface BuiltBundle {
  blob: Blob;
  bytes: Uint8Array;
  /** The file names inside the archive, in order. */
  names: string[];
  filename: string;
}

export async function buildBundle(views: readonly CapturedView[], ctx: BundleContext): Promise<BuiltBundle> {
  const entries: ZipEntry[] = [];
  const files: ManifestInput["files"] = {};
  for (const v of views) {
    const stem = `${nn(v.order)}-${v.def.short}`;
    const still = `views/${stem}.png`;
    entries.push({ name: still, data: await bytesOf(await pixelsToPng(v.still.pixels)) });
    let mask: string | null = null;
    if (v.maskPng) {
      mask = `masks/${stem}.png`;
      entries.push({ name: mask, data: await bytesOf(v.maskPng) });
    }
    let highRes: string | null = null;
    if (v.highRes) {
      highRes = `highres/${stem}.${extOf(v.highRes.mime)}`;
      entries.push({ name: highRes, data: await bytesOf(v.highRes.blob) });
    }
    files[v.def.id] = { still, mask, highRes };
  }
  const manifest = buildManifest({ ...ctx, views, files });
  const enc = new TextEncoder();
  const all: ZipEntry[] = [
    { name: "manifest.json", data: enc.encode(JSON.stringify(manifest, null, 2)) },
    { name: "README.txt", data: enc.encode(BUNDLE_README) },
    ...entries,
  ];
  const bytes = makeZip(all);
  const stamp = ctx.createdAt.toISOString().replace(/[:.]/g, "-");
  return { blob: new Blob([bytes as unknown as BlobPart], { type: "application/zip" }), bytes, names: all.map((e) => e.name), filename: `experimental-capture-${stamp}.zip` };
}
