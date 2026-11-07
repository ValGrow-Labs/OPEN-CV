// The synthetic hand, its rig and its noise (SYNTHETIC by construction).
import { describe, expect, it } from "vitest";
import { carveVisualHull } from "./carving";
import { cameraCenter, norm, rotationAngleDeg, sub } from "./linalg";
import { boundaryDistance } from "./quality";
import { referenceSurfaceArea } from "./experiment";
import { sliceMesh } from "./measure";
import { extractMesh, sdfToField } from "./meshing";
import { DEFAULT_HAND_PARAMS, EIGHT_VIEWS, jitterMask, makeCapsuleHand, perturbPose, renderCaptures, renderSilhouette, rigPoses, scaleFocal } from "./synthetic";

const hand = makeCapsuleHand(DEFAULT_HAND_PARAMS);

describe("the capsule hand", () => {
  it("is inside at the palm centre, outside far away, and its truth is what the parameters say", () => {
    expect(hand.sdf(0, 50, 0)).toBeLessThan(-8);
    expect(hand.sdf(0, 50, 80)).toBeGreaterThan(50);
    expect(hand.truth.palmBreadthMm).toBe(85);
    expect(hand.truth.handLengthMm).toBeCloseTo(100 + (68 + 9.5) * Math.cos((-1 * Math.PI) / 180), 6);
    expect(hand.truth.fingerLengthsMm.index).toBe(62 + 9);
    expect(hand.truth.circumferenceMm).toBeCloseTo(2 * (85 - 16) + 2 * (24 - 16) + 2 * Math.PI * 8, 6);
  });

  it("the middle finger is the longest, so the farthest point along the hand axis is its tip", () => {
    const tips = (["index", "middle", "ring", "little"] as const).map((n) => hand.truth.fingerLengthsMm[n]);
    expect(Math.max(...tips)).toBe(hand.truth.fingerLengthsMm.middle);
  });

  it("the analytic circumference of the palm section matches slicing a fine mesh of the SDF (within 0.5 %)", () => {
    const b = hand.bounds;
    const mesh = extractMesh(sdfToField(hand.sdf, { min: [b.min[0], b.min[1], b.min[2]], max: [b.max[0], b.max[1], b.max[2]] }, 0.8), 0);
    const loops = sliceMesh(mesh, [0, hand.truth.circumferencePlaneYMm, 0], [0, 1, 0]);
    expect(loops).toHaveLength(1);
    expect(Math.abs(loops[0].lengthMm - hand.truth.circumferenceMm) / hand.truth.circumferenceMm).toBeLessThan(0.005);
  }, 60000);

  it("the reference surface area converges as the reference grid gets finer (within 1 %)", () => {
    const coarse = referenceSurfaceArea(hand, 1.2);
    const fine = referenceSurfaceArea(hand, 0.8);
    expect(Math.abs(coarse - fine) / fine).toBeLessThan(0.01);
    expect(fine).toBeGreaterThan(40000);
    expect(fine).toBeLessThan(80000);
  }, 120000);
});

describe("rendered silhouettes", () => {
  const caps = renderCaptures(hand, ["palm", "thumb"], { width: 192, height: 192 });
  const palm = caps[0];

  it("have the hand in the middle and background at the corners", () => {
    const { width: w, height: h, data } = palm.mask;
    expect(data[(h >> 1) * w + (w >> 1)]).toBe(255);
    expect(data[0]).toBe(0);
    expect(data[w * h - 1]).toBe(0);
    let area = 0;
    for (const v of data) if (v) area++;
    expect(area).toBeGreaterThan(w * h * 0.1);
    expect(area).toBeLessThan(w * h * 0.5);
  });

  it("show the gaps between the fingers in the palm view (a row across the fingertips crosses the background)", () => {
    // project a world row at y = 160 (the finger region) and count hand/background runs across x
    const { width: w, data } = palm.mask;
    const cam = rigPoses(["palm"], { width: 192, height: 192 }, hand)[0];
    const y = 150;
    const row: number[] = [];
    for (let x = -50; x <= 50; x += 0.5) {
      const X = [x, y, 0];
      const R = cam.pose.R, t = cam.pose.t;
      const xc = R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + t[0];
      const yc = R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + t[1];
      const zc = R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + t[2];
      const u = Math.floor(cam.intrinsics.fx * (xc / zc) + cam.intrinsics.cx);
      const v = Math.floor(cam.intrinsics.fy * (yc / zc) + cam.intrinsics.cy);
      row.push(data[v * w + u] ? 1 : 0);
    }
    let runs = 0;
    for (let i = 1; i < row.length; i++) if (row[i] === 1 && row[i - 1] === 0) runs++;
    expect(runs + (row[0] === 1 ? 1 : 0)).toBeGreaterThanOrEqual(4); // index, middle, ring, little
  });

  it("are cached per hand and rig, and different views differ", () => {
    expect(renderCaptures(hand, ["palm", "thumb"], { width: 192, height: 192 })).toBe(caps);
    let diff = 0;
    for (let i = 0; i < caps[0].mask.data.length; i++) if (caps[0].mask.data[i] !== caps[1].mask.data[i]) diff++;
    expect(diff).toBeGreaterThan(500);
  });

  it("the visual hull of the eight exact silhouettes contains the deep inside of the hand", () => {
    const eight = renderCaptures(hand, EIGHT_VIEWS, { width: 192, height: 192 });
    const occ = carveVisualHull(eight, hand.bounds, { voxelMm: 2 });
    const [nx, ny] = occ.dims;
    let checked = 0, missing = 0;
    for (let k = 0; k < occ.dims[2]; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const x = occ.origin[0] + (i + 0.5) * 2, y = occ.origin[1] + (j + 0.5) * 2, z = occ.origin[2] + (k + 0.5) * 2;
          if (hand.sdf(x, y, z) < -2.5) {
            checked++;
            if (!occ.occupancy[i + nx * (j + ny * k)]) missing++;
          }
        }
    expect(checked).toBeGreaterThan(1000);
    expect(missing / checked).toBeLessThan(0.002);
  });

  it("render the same thing twice", () => {
    const k = palm.intrinsics, p = palm.pose;
    expect(renderSilhouette(hand, k, p).data).toEqual(palm.mask.data);
  });
});

describe("controlled noise", () => {
  const mask = renderCaptures(hand, ["palm"], { width: 160, height: 160 })[0].mask;

  it("mask jitter moves the boundary by at most about the amplitude, and is repeatable", () => {
    const j = jitterMask(mask, 2, 7);
    const dist = boundaryDistance(mask);
    let changed = 0, far = 0;
    for (let i = 0; i < mask.data.length; i++)
      if (mask.data[i] !== j.data[i]) {
        changed++;
        // a changed pixel is within ~amplitude of the original boundary (hand pixels at the boundary have dist 0; the outside neighbour is 1 away)
        const near = Math.min(dist[i], (i % mask.width > 0 ? dist[i - 1] : 99) + 1, (i % mask.width < mask.width - 1 ? dist[i + 1] : 99) + 1, (i >= mask.width ? dist[i - mask.width] : 99) + 1, (i < mask.data.length - mask.width ? dist[i + mask.width] : 99) + 1);
        if (near > 3.5) far++;
      }
    expect(changed).toBeGreaterThan(20);
    expect(far).toBe(0);
    expect(jitterMask(mask, 2, 7).data).toEqual(j.data);
    expect(jitterMask(mask, 2, 8).data).not.toEqual(j.data);
    expect(jitterMask(mask, 0, 7)).toBe(mask);
  });

  it("a pose perturbation turns the camera by the requested angle and moves its centre by the requested distance", () => {
    const pose = rigPoses(["palm"], {}, hand)[0].pose;
    const p2 = perturbPose(pose, 2, 5, 11);
    // relative rotation: R2 R^T
    const R = pose.R, R2 = p2.R;
    const rel = [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => [0, 1, 2].reduce((s, k) => s + R2[i * 3 + k] * R[j * 3 + k], 0)));
    expect(rotationAngleDeg(rel)).toBeCloseTo(2, 3);
    expect(norm(sub(cameraCenter(p2), cameraCenter(pose)))).toBeCloseTo(5, 4);
    expect(perturbPose(pose, 0, 0, 1).R.map((x, i) => Math.abs(x - pose.R[i])).every((d) => d < 1e-12)).toBe(true);
  });

  it("scaleFocal scales both focal lengths and nothing else", () => {
    const k = rigPoses(["palm"], {}, hand)[0].intrinsics;
    const s = scaleFocal(k, 1.02);
    expect(s.fx).toBeCloseTo(k.fx * 1.02, 9);
    expect(s.fy).toBeCloseTo(k.fy * 1.02, 9);
    expect([s.cx, s.cy, s.width, s.height]).toEqual([k.cx, k.cy, k.width, k.height]);
  });
});
