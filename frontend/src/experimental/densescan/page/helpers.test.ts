// The page's pure helpers, on SYNTHETIC data (mathematics only).
import { describe, expect, it } from "vitest";
import type { BinaryMask } from "../../common";
import { captionFor, containScale, liveGuidance, displayStride, displaySubset, READABLE_PITCH_CSS, maskRowsSource, meshToViewerSpace, pointsOutsideMask, rejectBreakdown, revealedCounts, scanQuality, toViewerSpace } from "./helpers";

const pt = (y: number, accepted: boolean) => ({ y, accepted });

describe("counters from the real list", () => {
  it("counts only what the line has passed, and accepted + rejected = generated", () => {
    const pts = [pt(10, true), pt(20, false), pt(30, true), pt(40, true)];
    expect(revealedCounts(pts, 25)).toEqual({ generated: 2, accepted: 1, rejected: 1 });
    const all = revealedCounts(pts, 1e9);
    expect(all.accepted + all.rejected).toBe(all.generated);
    expect(revealedCounts(null, 100)).toEqual({ generated: 0, accepted: 0, rejected: 0 });
  });

  it("grades quality from the accepted share; a rejected segmentation is poor; nothing yet is unknown", () => {
    expect(scanQuality({ generated: 100, accepted: 90, rejected: 10 }, true)).toBe("good");
    expect(scanQuality({ generated: 100, accepted: 70, rejected: 30 }, true)).toBe("fair");
    expect(scanQuality({ generated: 100, accepted: 20, rejected: 80 }, true)).toBe("poor");
    expect(scanQuality({ generated: 100, accepted: 100, rejected: 0 }, false)).toBe("poor");
    expect(scanQuality({ generated: 0, accepted: 0, rejected: 0 }, true)).toBe("unknown");
  });

  it("lists rejections by reason, largest first, in words", () => {
    const b = rejectBreakdown({ counts: { generated: 10, accepted: 4, rejected: 6, byReason: { near_edge: 4, blurred: 2, outside_mask: 0, overexposed: 0, underexposed: 0, isolated: 0, duplicate: 0 } } });
    expect(b.map((r) => r.reason)).toEqual(["near_edge", "blurred"]);
    expect(b[0].words).toBe("too near the hand's edge");
  });
});

describe("the honest 3D caption", () => {
  it("never says measured unless the depth is measured", () => {
    expect(captionFor("points", null, false)).toBe("Flat 2D surface-point map (no depth).");
    expect(captionFor("points", "relative", false)).toBe("Estimated relative depth (MediaPipe), not a measured 3D scan.");
    expect(captionFor("mesh", "relative", false)).toMatch(/^Flat 2D surface-point map \(no depth\)/);
    for (const c of [captionFor("points", null, false), captionFor("points", "relative", false), captionFor("mesh", null, false)]) expect(c).not.toMatch(/measured depth/);
    expect(captionFor("points", "mm", false)).toMatch(/measured depth/);
  });
});

describe("geometry into the viewer's space", () => {
  it("centres, flips y, scales x/y and z separately, and keeps distances", () => {
    const src = new Float32Array([0, 0, 0, 10, 0, 2, 0, 20, 4]);
    const v = toViewerSpace(src, 0.5, 0.5);
    const c = [0, 1, 2].reduce((s, i) => s + v[i * 3 + 1], 0);
    expect(c).toBeCloseTo(0, 6); // centred
    expect(v[3] - v[0]).toBeCloseTo(5, 6); // 10 px * 0.5
    expect(v[7] - v[1]).toBeCloseTo(-10, 6); // y flipped
    expect(v[5] - v[2]).toBeCloseTo(-1, 6); // z flipped and scaled
  });

  it("keeps the triangle winding counter-clockwise after the y flip", () => {
    const mesh = { vertices: new Float32Array([0, 0, 0, 0, 10, 0, 10, 0, 0]), indices: new Uint32Array([0, 1, 2]) };
    const m = meshToViewerSpace(mesh);
    const [a, b, c] = [m.indices[0], m.indices[1], m.indices[2]].map((i) => [m.vertices[i * 3], m.vertices[i * 3 + 1]]);
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const [A, B, C] = [0, 1, 2].map((i) => [mesh.vertices[i * 3], mesh.vertices[i * 3 + 1]]);
    const crossImg = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
    expect(Math.sign(cross)).not.toBe(0);
    expect(Math.sign(cross)).toBe(Math.sign(crossImg)); // a y flip plus an index swap keeps the orientation sign
  });
});

describe("adaptive display (drawing only)", () => {
  it("keeps every dot when the on-screen pitch is readable, thins the drawing when it is not", () => {
    expect(displayStride(4, 1.5)).toBe(1); // 6 CSS px apart
    expect(displayStride(4, 0.27)).toBe(5); // 1.08 CSS px apart -> every 5th: 5.4 px
    expect(4 * 0.27 * displayStride(4, 0.27)).toBeGreaterThanOrEqual(READABLE_PITCH_CSS);
    expect(displayStride(4, 0)).toBe(1);
  });

  it("chooses a coarser lattice of the same points without changing the array", () => {
    const pts: { gx: number; gy: number }[] = [];
    for (let gy = -3; gy < 6; gy++) for (let gx = 0; gx < 9; gx++) pts.push({ gx, gy });
    const copy = JSON.stringify(pts);
    const k3 = displaySubset(pts, 3);
    expect(k3.every((i) => pts[i].gx % 3 === 0 && ((pts[i].gy % 3) + 3) % 3 === 0)).toBe(true);
    expect(k3.length).toBe(3 * 3);
    expect(displaySubset(pts, 1).length).toBe(pts.length);
    expect(JSON.stringify(pts)).toBe(copy);
  });

  it("scales a frame into its box like object-fit: contain, in portrait and landscape", () => {
    expect(containScale(1280, 720, 344, 194)).toBeCloseTo(344 / 1280, 6);
    expect(containScale(720, 1280, 324, 533)).toBeCloseTo(533 / 1280, 6);
  });
});

describe("mask helpers", () => {
  const w = 10;
  const h = 8;
  const data = new Uint8Array(w * h);
  for (let y = 2; y < 6; y++) for (let x = 3; x < 7; x++) data[y * w + x] = 255;
  const mask: BinaryMask = { width: w, height: h, data };

  it("finds the hand's top and bottom rows in source pixels", () => {
    expect(maskRowsSource(mask, 2)).toEqual({ top: 4, bottom: 12 });
    expect(maskRowsSource({ width: 2, height: 2, data: new Uint8Array(4) }, 1)).toBeNull();
  });

  it("counts accepted points that are off the mask (should be none)", () => {
    const set = {
      mask,
      scaleToSource: 1,
      points: [
        { x: 4, y: 3, accepted: true },
        { x: 0, y: 0, accepted: true },
        { x: 0, y: 0, accepted: false },
      ],
    };
    expect(pointsOutsideMask(set as never)).toBe(1);
  });
});

describe("liveGuidance: names the first failing check", () => {
  const ok = { coin: { found: true, accepted: true }, steady: { steady: true, jitter: 0.004 }, sharpness: { sharp: true } };
  it("asks for the coin first, by name, and never offers a scan without it", () => {
    const missing = liveGuidance({ ...ok, coin: { found: false, accepted: false } }, 0, 8, "Indian 2-rupee coin");
    const rejected = liveGuidance({ ...ok, coin: { found: true, accepted: false } }, 0, 8, "US quarter");
    expect(missing).toBe("Put the Indian 2-rupee coin flat in the middle of your palm");
    expect(rejected).toBe("Coin seen but not accepted: lay the US quarter flat in the middle of your palm, fully visible");
    for (const s of [missing, rejected]) expect(s).not.toMatch(/scan|without/i);
  });
  it("then steadiness, then sharpness, then the count of good frames", () => {
    expect(liveGuidance({ ...ok, steady: { steady: false, jitter: 0.05 } }, 0, 8, "coin")).toBe("Hold your hand still");
    expect(liveGuidance({ ...ok, sharpness: { sharp: false } }, 0, 8, "coin")).toBe("Hold the phone steady so the picture is sharp");
    expect(liveGuidance(ok, 3, 8, "coin")).toBe("Hold still: 3 / 8 good frames");
    expect(liveGuidance(null, 0, 8, null)).toBe("Show your open hand with the coin on the palm");
  });
});
