// The optional `known` mask of reconstruction/carving.ts and quality.ts: unknown pixels never carve, contours next to
// them are not "observed", and the reprojection IoU leaves them out. Without `known` nothing changes.
import { describe, expect, it } from "vitest";
import type { BinaryMask } from "../common";
import { carveVisualHull, type CarveView } from "../reconstruction/carving";
import { intrinsicsFor, lookAtPose, type Vec3 } from "../reconstruction/linalg";
import { silhouetteIoU, vertexConfidence } from "../reconstruction/quality";
import { DEFAULT_HAND_PARAMS, makeCapsuleHand, renderSilhouette } from "../reconstruction/synthetic";

const hand = makeCapsuleHand(DEFAULT_HAND_PARAMS);
const K = intrinsicsFor(96, 96, 42);
const c: Vec3 = [0, 50, 0];
const poses = [lookAtPose([0, 50, 400], c, [0, 1, 0]), lookAtPose([400, 50, 0], c, [0, 1, 0]), lookAtPose([0, 50, -400], c, [0, 1, 0]), lookAtPose([-400, 50, 0], c, [0, 1, 0])];
const views: CarveView[] = poses.map((pose) => ({ mask: renderSilhouette(hand, K, pose), intrinsics: K, pose }));
const bounds = hand.bounds;
const all = (v = 255): BinaryMask => ({ width: 96, height: 96, data: new Uint8Array(96 * 96).fill(v) });

describe("unknown pixels in carving and quality", () => {
  it("an all-known mask gives exactly the same hull as no mask", () => {
    const a = carveVisualHull(views, bounds, { voxelMm: 4 });
    const b = carveVisualHull(views.map((v) => ({ ...v, known: all() })), bounds, { voxelMm: 4 });
    expect(Array.from(b.occupancy)).toEqual(Array.from(a.occupancy));
    expect(a.abstained).toBeUndefined();
    expect(b.abstained).toBeDefined();
  });

  it("a view whose pixels are all unknown carves nothing (its voxels are kept by it)", () => {
    const without = carveVisualHull(views.slice(1), bounds, { voxelMm: 4 });
    const abstaining = carveVisualHull([{ ...views[0], known: all(0) }, ...views.slice(1)], bounds, { voxelMm: 4 });
    expect(Array.from(abstaining.occupancy)).toEqual(Array.from(without.occupancy));
    // and an empty mask with all pixels unknown also carves nothing
    const emptyUnknown = carveVisualHull([{ ...views[0], mask: all(0), known: all(0) }, ...views.slice(1)], bounds, { voxelMm: 4 });
    expect(Array.from(emptyUnknown.occupancy)).toEqual(Array.from(without.occupancy));
  });

  it("an empty mask that is KNOWN carves everything (the known background is evidence)", () => {
    const h = carveVisualHull([{ ...views[0], mask: all(0), known: all() }, ...views.slice(1)], bounds, { voxelMm: 4 });
    expect(h.occupancy.reduce((s, x) => s + x, 0)).toBe(0);
  });

  it("vertexConfidence ignores contours in unknown areas; silhouetteIoU skips unknown pixels", () => {
    const mesh = { vertices: new Float32Array([0, 50, 12, 40, 50, 0, 0, 120, 0]), indices: new Uint32Array([0, 1, 2]) };
    const base = vertexConfidence(mesh, views);
    const blind = vertexConfidence(mesh, views.map((v) => ({ ...v, known: all(0) })));
    expect(Array.from(blind).every((x) => x === 0)).toBe(true);
    expect(Array.from(vertexConfidence(mesh, views.map((v) => ({ ...v, known: all() }))))).toEqual(Array.from(base));
    const m = views[0].mask;
    const shifted: BinaryMask = { width: 96, height: 96, data: new Uint8Array(96 * 96) };
    for (let y = 0; y < 96; y++) for (let x = 1; x < 96; x++) shifted.data[y * 96 + x] = m.data[y * 96 + x - 1];
    const known = all();
    for (let y = 0; y < 96; y++) for (let x = 48; x < 96; x++) known.data[y * 96 + x] = 0;
    expect(silhouetteIoU(m, m, known)).toBe(1);
    expect(silhouetteIoU(m, shifted)).toBeLessThan(1);
    expect(silhouetteIoU(m, shifted, all())).toBe(silhouetteIoU(m, shifted));
    // fewer than minKnownPx known hand pixels: uncheckable, not held against the reconstruction
    expect(silhouetteIoU(m, all(0), all(0))).toBe(1);
  });
});
