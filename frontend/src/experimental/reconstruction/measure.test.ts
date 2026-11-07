// The measurement engine on a fine reference mesh of the SYNTHETIC capsule hand, and on simple shapes.
import { beforeAll, describe, expect, it } from "vitest";
import type { Mesh, Pt3 } from "../common";
import { extractMesh, meshArea, sdfToField, topologyReport } from "./meshing";
import { FINGER_NAMES, frameFromLandmarks, frameFromPca, measureHand, fingersFromLandmarks, sectionCircumference, sliceMesh } from "./measure";
import { makeCapsuleHand } from "./synthetic";

const hand = makeCapsuleHand();
let ref: Mesh;
beforeAll(() => {
  const b = hand.bounds;
  ref = extractMesh(sdfToField(hand.sdf, { min: [b.min[0] - 2, b.min[1] - 2, b.min[2] - 2], max: [b.max[0] + 2, b.max[1] + 2, b.max[2] + 2] }, 1.0), 0);
}, 60000);

const sphere = (r: number, voxel = 1): Mesh => extractMesh(sdfToField((x, y, z) => Math.hypot(x, y, z) - r, { min: [-r - 6, -r - 6, -r - 6], max: [r + 6, r + 6, r + 6] }, voxel), 0);

describe("slicing", () => {
  const s = sphere(20);

  it("cuts a sphere in one closed loop of length 2 pi r (within 1 %)", () => {
    const loops = sliceMesh(s, [0, 0, 5], [0, 0, 1]);
    expect(loops).toHaveLength(1);
    expect(loops[0].closed).toBe(true);
    const r = Math.sqrt(20 * 20 - 25);
    expect(loops[0].lengthMm).toBeGreaterThan(2 * Math.PI * r * 0.99);
    expect(loops[0].lengthMm).toBeLessThan(2 * Math.PI * r * 1.01);
  });

  it("a plane that misses the mesh gives a null circumference with a reason", () => {
    const c = sectionCircumference(s, [0, 0, 50], [0, 0, 1]);
    expect(c.value).toBeNull();
    expect(c.reason).toMatch(/does not cut/);
  });

  it("two separate loops (two pieces) give a null circumference that says so", () => {
    const a = sphere(8, 0.6);
    const shifted = a.vertices.map((v, i) => (i % 3 === 0 ? v + 30 : v));
    const both: Mesh = { vertices: Float32Array.from([...a.vertices, ...shifted]), indices: Uint32Array.from([...a.indices, ...Array.from(a.indices, (i) => i + a.vertices.length / 3)]) };
    const c = sectionCircumference(both, [15, 0, 0], [0, 0, 1]);
    expect(c.value).toBeNull();
    expect(c.loops).toBe(2);
    expect(c.reason).toMatch(/2 loops/);
  });

  it("a hole at the cut gives an open chain, hence no circumference", () => {
    const n = s.indices.length / 3;
    // drop the triangles near the +x side of the equator plane
    const keep: number[] = [];
    for (let t = 0; t < n; t++) {
      const a = s.indices[t * 3], b = s.indices[t * 3 + 1], c = s.indices[t * 3 + 2];
      const cx = (s.vertices[a * 3] + s.vertices[b * 3] + s.vertices[c * 3]) / 3;
      const cz = (s.vertices[a * 3 + 2] + s.vertices[b * 3 + 2] + s.vertices[c * 3 + 2]) / 3;
      if (!(cx > 14 && Math.abs(cz) < 4)) keep.push(a, b, c);
    }
    const open: Mesh = { vertices: s.vertices, indices: Uint32Array.from(keep) };
    const c = sectionCircumference(open, [0, 0, 0], [0, 0, 1]);
    expect(c.value).toBeNull();
    expect(c.reason).toMatch(/not a closed loop|loops/);
  });
});

describe("measurements of the reference capsule hand with the exact frame (SYNTHETIC)", () => {
  it("the reference mesh itself is a clean closed surface", () => {
    const t = topologyReport(ref);
    expect(t.watertight).toBe(true);
    expect(t.components).toBe(1);
  });

  it("reads hand length, palm breadth, thickness, circumference and the five finger lengths close to the analytic truth", () => {
    const m = measureHand(ref, hand.frame, { fingers: hand.fingerAxes, accepted: true });
    const tr = hand.truth;
    expect(Math.abs(m.handLength.value! - tr.handLengthMm)).toBeLessThan(0.5);
    expect(Math.abs(m.palmBreadth.value! - tr.palmBreadthMm)).toBeLessThan(0.8);
    expect(Math.abs(m.palmThickness.value! - tr.palmThicknessMm)).toBeLessThan(1.0);
    expect(Math.abs(m.circumferenceKnuckle.value! - tr.circumferenceMm) / tr.circumferenceMm).toBeLessThan(0.01);
    for (const f of FINGER_NAMES) expect(Math.abs(m.fingerLengths[f].value! - tr.fingerLengthsMm[f])).toBeLessThan(0.7);
  });

  it("calls them 'direct' for a supplied frame, with a note, and withholds nothing it was allowed to report", () => {
    const m = measureHand(ref, hand.frame, { fingers: hand.fingerAxes, accepted: true });
    expect(m.frameSource).toBe("given");
    for (const q of [m.handLength, m.palmBreadth, m.palmThickness, m.circumferenceKnuckle, m.surfaceArea, ...Object.values(m.fingerLengths)]) {
      expect(q.basis).toBe("direct");
      expect(q.value).not.toBeNull();
      expect(q.note.length).toBeGreaterThan(10);
    }
    expect(m.surfaceArea.value).toBeCloseTo(meshArea(ref), 3);
    expect(m.notes.join(" ")).toMatch(/unvalidated/i);
  });

  it("withholds the surface area unless the reconstruction passed its gates (or research mode says otherwise)", () => {
    const gated = measureHand(ref, hand.frame, {});
    expect(gated.surfaceArea.value).toBeNull();
    expect(gated.surfaceArea.basis).toBe("none");
    expect(gated.surfaceArea.note).toMatch(/gates/);
    expect(measureHand(ref, hand.frame, { accepted: false }).surfaceArea.value).toBeNull();
    const research = measureHand(ref, hand.frame, { ignoreGate: true });
    expect(research.surfaceArea.value).not.toBeNull();
    expect(research.surfaceArea.note).toMatch(/WITHOUT/);
  });

  it("gives null with a reason for finger lengths when no finger axes were supplied", () => {
    const m = measureHand(ref, hand.frame, { accepted: true });
    for (const f of FINGER_NAMES) {
      expect(m.fingerLengths[f].value).toBeNull();
      expect(m.fingerLengths[f].basis).toBe("none");
      expect(m.fingerLengths[f].note).toMatch(/landmarks/);
    }
  });
});

/** The 21 MediaPipe landmarks of the synthetic hand (joint centres; a perfect detector would put them here). */
function landmarksOf(): Pt3[] {
  const lm: Pt3[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  const tip = (f: (typeof hand.fingerAxes)[number], len: number): Pt3 => ({ x: f.base[0] + f.dir[0] * len, y: f.base[1] + f.dir[1] * len, z: f.base[2] + f.dir[2] * len });
  const p = hand.params;
  const ids: [string, number, number, number][] = [
    ["thumb", 2, 4, p.thumb.length],
    ["index", 5, 8, p.fingers.index.length],
    ["middle", 9, 12, p.fingers.middle.length],
    ["ring", 13, 16, p.fingers.ring.length],
    ["little", 17, 20, p.fingers.little.length],
  ];
  for (const [name, a, b, len] of ids) {
    const f = hand.fingerAxes.find((x) => x.name === name)!;
    lm[a] = { x: f.base[0], y: f.base[1], z: f.base[2] };
    lm[b] = tip(f, len);
  }
  return lm;
}

describe("frames from landmarks and from the shape of the mesh (SYNTHETIC)", () => {
  it("a frame from landmarks is a model estimate: results are labelled 'model' and stay close", () => {
    const lm = landmarksOf();
    const frame = frameFromLandmarks(lm)!;
    expect(frame.source).toBe("landmarks");
    expect(frame.knuckleYMm).toBeGreaterThan(95);
    const fingers = fingersFromLandmarks(lm);
    const m = measureHand(ref, frame, { fingers, accepted: true });
    expect(m.handLength.basis).toBe("model");
    expect(m.palmBreadth.basis).toBe("model");
    expect(Math.abs(m.handLength.value! - hand.truth.handLengthMm)).toBeLessThan(2);
    expect(Math.abs(m.palmBreadth.value! - hand.truth.palmBreadthMm)).toBeLessThan(3);
    expect(m.notes.join(" ")).toMatch(/landmarks/);
    // finger lengths from the landmark axes: close, though the axes are only as good as the landmarks
    for (const f of FINGER_NAMES) expect(Math.abs(m.fingerLengths[f].value! - hand.truth.fingerLengthsMm[f])).toBeLessThan(3);
  });

  it("returns no frame for fewer than 21 landmarks", () => {
    expect(frameFromLandmarks(landmarksOf().slice(0, 10))).toBeNull();
    expect(fingersFromLandmarks(landmarksOf().slice(0, 10))).toEqual([]);
  });

  it("the shape-only frame finds the hand axis but cannot give a hand length", () => {
    const frame = frameFromPca(ref);
    expect(frame.source).toBe("pca");
    expect(Math.abs(frame.axisY[1])).toBeGreaterThan(0.97); // along the hand
    expect(frame.axisY[1]).toBeGreaterThan(0); // toward the fingers (the wider end)
    const m = measureHand(ref, frame, { accepted: true });
    expect(m.handLength.value).toBeNull();
    expect(m.handLength.basis).toBe("none");
    expect(m.handLength.note).toMatch(/wrist plane/);
  });
});
