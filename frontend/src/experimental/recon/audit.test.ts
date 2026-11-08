// AUDIT of the reconstruction outputs (Task 1 of the physical-validation phase), on SIMULATED photos from pixels only.
// Each test checks one property a physical validation relies on. Passing says the code does what it claims on clean
// renders of a synthetic hand; it says nothing about real accuracy.
import { describe, expect, it } from "vitest";
import { boardRig, makeBoardScene, projectLandmarks, renderView, SKIN_TONES } from "../multiview/scene";
import { reconstructFromImages, type ChainResult, type ImageView } from "./chain";

const scene = makeBoardScene();
const cameras = boardRig(scene, { width: 1280, height: 720, hfovDeg: 64, k1: -0.06, k2: 0.02, lowCount: 16, highCount: 0 });
const views: ImageView[] = cameras.map((c, i) => ({
  id: c.id,
  image: renderView(scene, c.intrinsics, c.pose, { skin: SKIN_TONES.medium, seed: i + 1 }).image,
  landmarks: projectLandmarks(scene.landmarks, c.intrinsics, c.pose, { noisePx: 2, seed: 100 + i }),
}));
let cached: ChainResult | null = null;
const result = () => (cached ??= reconstructFromImages(views, { reconstruct: { voxelMm: 1.5 } }));

describe("AUDIT (SIMULATED): what the reconstruction outputs are", () => {
  it("vertices are metric board millimetres: the mesh spans the hand's true extent, above the board", () => {
    const rec = result().reconstruction!;
    const V = rec.mesh!.vertices;
    let minZ = Infinity, maxZ = -Infinity, minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < V.length; i += 3) {
      minX = Math.min(minX, V[i]);
      maxX = Math.max(maxX, V[i]);
      minZ = Math.min(minZ, V[i + 2]);
      maxZ = Math.max(maxZ, V[i + 2]);
    }
    expect(minZ).toBeGreaterThanOrEqual(-1.5); // nothing below the board plane (one voxel of smoothing)
    // the fingertips' x in board mm, from the scene truth (landmark 12 = middle tip; the tip sphere adds its radius)
    const tipX = Math.max(...[4, 8, 12, 16, 20].map((i) => scene.landmarks[i].x));
    expect(maxX).toBeGreaterThan(tipX);
    expect(maxX).toBeLessThan(tipX + 15);
    // the tallest point (wrist stub of the synthetic hand) is a few centimetres, not metres or pixels
    expect(maxZ).toBeGreaterThan(20);
    expect(maxZ).toBeLessThan(60);
  }, 900_000);

  it("every camera pose comes from marker observations, with a reprojection error per view and for the calibration", () => {
    const cam = result().cameras!;
    expect(cam.calibration.assumed).toBe(false);
    if (!cam.calibration.assumed) expect(cam.calibration.rmsPx).toBeGreaterThan(0);
    for (const v of cam.views) {
      if (!v.pose) {
        expect(v.rejected).toBeTruthy(); // a view without a pose says why
        continue;
      }
      expect(v.markers).toBeGreaterThanOrEqual(3);
      expect(Number.isFinite(v.poseRmsPx)).toBe(true);
    }
  }, 900_000);

  it("thickness is bounded by observed low views (lowest view within 20 degrees of the board), not by the search box", () => {
    const q = result().reconstruction!.quality!;
    expect(q.metrics.lowestElevationDeg).toBeLessThanOrEqual(20);
    expect(q.reasons).not.toContain("sides_not_observed");
    expect(q.reasons).not.toContain("hull_truncated_by_volume");
  }, 900_000);

  it("surfaces bounded by the board are labelled apart from observed ones, and lie on the board plane", () => {
    const rec = result().reconstruction!;
    const V = rec.mesh!.vertices;
    const sup = rec.support!;
    let onBoard = 0, boardHigh = 0, observed = 0;
    for (let i = 0; i < sup.length; i++) {
      if (sup[i] === 2) {
        onBoard++;
        if (V[i * 3 + 2] > 3) boardHigh++;
      }
      if (sup[i] === 0) observed++;
    }
    expect(onBoard).toBeGreaterThan(0);
    expect(observed).toBeGreaterThan(onBoard);
    expect(boardHigh).toBe(0); // every "bounded by the board" vertex is at the board plane
    expect(rec.supportLabels[2]).toBe("support_plane");
  }, 900_000);

  it("model estimates are separated from direct geometry: landmark-dependent values are 'model'", () => {
    const m = result().reconstruction!.measurements!;
    for (const q of [m.handLength, m.palmBreadth, m.palmThickness, ...Object.values(m.fingerLengths)]) if (q.value !== null) expect(q.basis).toBe("model");
  }, 900_000);

  it("circumference is reported only as an upper bound, and no hand surface area is claimed from a board capture", () => {
    const rec = result().reconstruction!;
    const m = rec.measurements!;
    if (m.circumferenceKnuckle.value !== null) {
      expect(m.circumferenceKnuckle.basis).toBe("model");
      expect(m.circumferenceKnuckle.note).toMatch(/^UPPER BOUND/);
    }
    expect(m.surfaceArea.value).toBeNull();
    expect(m.surfaceArea.basis).toBe("none");
    expect(m.surfaceArea.note).toMatch(/palm side/);
    expect(rec.freeSurfaceAreaMm2).toBeGreaterThan(0); // the back-and-sides hull area, reported separately
  }, 900_000);
});
