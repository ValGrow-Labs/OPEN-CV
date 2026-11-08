// The page's staged run of the core must give exactly what the core's buildPointSet gives (SYNTHETIC data, maths only).
import { describe, expect, it } from "vitest";
import type { BinaryMask } from "../../common";
import { buildPointSet, type BuildPointSetInput } from "../core";
import { runProcess } from "./denseWorker";
import { gapProbes } from "./helpers";
import { stagedPointSet, summarise } from "./staged";

/** A synthetic "hand": a palm block with two fingers and a gap between them (working size 80 x 80, scale 2). */
function synthetic(): BuildPointSetInput {
  const w = 80;
  const h = 80;
  const data = new Uint8Array(w * h);
  for (let y = 40; y < 76; y++) for (let x = 10; x < 70; x++) data[y * w + x] = 255; // palm
  for (let y = 6; y < 40; y++) {
    for (let x = 14; x < 30; x++) data[y * w + x] = 255; // finger 1
    for (let x = 44; x < 60; x++) data[y * w + x] = 255; // finger 2 (gap x 30..43)
  }
  const mask: BinaryMask = { width: w, height: h, data };
  const fw = 160;
  const fh = 160;
  const img = new Uint8ClampedArray(fw * fh * 4);
  for (let i = 0; i < fw * fh; i++) {
    const x = i % fw;
    const y = Math.floor(i / fw);
    const v = 110 + ((x * 7 + y * 13) % 40); // texture, so the sharpness check has something to read
    img[i * 4] = v;
    img[i * 4 + 1] = v - 20;
    img[i * 4 + 2] = v - 40;
    img[i * 4 + 3] = 255;
  }
  const landmarks = Array.from({ length: 21 }, (_, i) => ({ x: 40 + (i % 5) * 20, y: 140 - Math.floor(i / 5) * 25, z: -i }));
  return {
    mask,
    scaleToSource: 2,
    frameWidth: fw,
    frameHeight: fh,
    image: { width: fw, height: fh, data: img },
    landmarks,
    landmarks3d: landmarks,
    scale: { mmPerPx: 0.25, relUncertainty: 0.03, source: "coin" },
    config: { spacingPx: 3, jitter: 0.2, seed: 7, edgeMarginPx: 2 },
  };
}

describe("stagedPointSet", () => {
  it("gives the same point set as the core's buildPointSet", () => {
    const input = synthetic();
    const a = buildPointSet(input);
    const b = stagedPointSet(input).set;
    expect(b.points.length).toBeGreaterThan(100);
    expect(b).toEqual(a);
  });

  it("reports a non-negative time for every stage", () => {
    let t = 0;
    const { timings } = stagedPointSet(synthetic(), () => (t += 1));
    for (const v of Object.values(timings)) expect(v).toBeGreaterThan(0);
  });
});

describe("the worker's processing step", () => {
  it("gives the core's point cloud, mesh and measurements for the set", () => {
    const set = buildPointSet(synthetic());
    const out = runProcess(set, synthetic().landmarks!, { mmPerPx: 0.25, relUncertainty: 0.03, source: "coin" });
    expect(out.cloud.count).toBe(set.counts.accepted);
    expect(out.mesh.triangles).toBeGreaterThan(0);
    expect(out.measurements.thickness_mm.basis).toBe("none");
    for (const v of Object.values(out.timings)) expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe("gap probes", () => {
  it("find the background between two fingers and no accepted point near it", () => {
    const input = synthetic();
    const set = buildPointSet(input);
    // place two "fingertip" landmarks on the two fingers so their midpoint falls in the gap (x = 37 working = 74 source)
    const lm = Array.from({ length: 21 }, () => ({ x: 0, y: 0 }));
    lm[8] = { x: 44, y: 40 };
    lm[12] = { x: 104, y: 40 };
    const probe = gapProbes(set, lm).find((p) => p.pair === "index-middle tips")!;
    expect(probe.gap).toBe(true);
    expect(probe.nearestAcceptedPx!).toBeGreaterThan(set.spacing.px / 2);
  });
});

describe("summarise", () => {
  it("gives the median, p95 and max", () => {
    const s = summarise([1, 2, 3, 4, 100]);
    expect(s).toMatchObject({ frames: 5, medianMs: 3, maxMs: 100 });
    expect(summarise([]).medianMs).toBeNull();
  });
});
