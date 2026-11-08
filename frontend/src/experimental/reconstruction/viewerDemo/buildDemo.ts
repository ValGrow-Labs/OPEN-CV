// SIMULATED data for the viewer demo page: the synthetic capsule hand (not anyone's hand) resting palm-down on a board,
// seen by simulated cameras on the board's side only (a low ring all round plus one from straight above, the capture
// design captureGeometry.test.ts chose), carved into a visual hull and meshed by the experimental pipeline, then labelled
// per vertex (observed / implied / bounded by the board / cut at the forearm / truncated). Returned in the BOARD frame
// the viewer expects: millimetres, +z up out of the board, +x along the fingers, board plane z = 0.
//
// It is a picture of the mathematics on perfect synthetic inputs. It is not a real scan and must never be called one.
import type { Mesh } from "../../common";
import type { CarveView } from "../carving";
import { intrinsicsFor, lookAtPose, type Vec3 } from "../linalg";
import { reconstructHand } from "../pipeline";
import { vertexSupport } from "../quality";
import { DEFAULT_HAND_PARAMS, makeCapsuleHand, renderSilhouette, type CapsuleHand } from "../synthetic";

export const DEMO_LABEL = "SIMULATED: synthetic capsule hand, not a real scan";

export interface DemoOptions {
  voxelMm?: number;
  /** Cameras in the low ring (plus one from above). */
  ringViews?: number;
  ringElevationDeg?: number;
  maskPx?: number;
  cloudPoints?: number;
}

export interface DemoData {
  mesh: Mesh;
  confidence: Float32Array;
  support: Uint8Array;
  points: Float32Array;
  pointLabels: Uint8Array;
  pointColors: Float32Array;
  landmarks: Float32Array;
  handFrame: { origin: number[]; x: number[]; y: number[]; z: number[] };
  info: { views: number; voxelMm: number; maskPx: number; ringElevationDeg: number; ms: { render: number; reconstruct: number; total: number }; accepted: boolean; reasons: string[] };
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Hand frame (palm normal +z) to board frame (+z up, palm-down): board = (hand y, hand x, palmPlane - hand z). A proper
 *  rotation (determinant +1), so triangle winding is kept. */
function toBoard(hx: number, hy: number, hz: number, palmPlane: number, out: Float32Array, o: number): void {
  out[o] = hy;
  out[o + 1] = hx;
  out[o + 2] = palmPlane - hz;
}

/** 21 MediaPipe-topology landmarks on the synthetic hand's finger axes (what a perfect detector might give), hand frame. */
function syntheticLandmarks(hand: CapsuleHand): Vec3[] {
  const p = hand.params;
  const at = (a: Vec3, d: Vec3, t: number): Vec3 => [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
  const lm: Vec3[] = [[0, 0, 0]];
  for (const f of hand.fingerAxes) {
    const spec = f.name === "thumb" ? p.thumb : p.fingers[f.name];
    const L = spec.length;
    const fr = f.name === "thumb" ? [0, 0.38, 0.7] : [0, 0.45, 0.75];
    lm.push(at(f.base, f.dir, fr[0] * L), at(f.base, f.dir, fr[1] * L), at(f.base, f.dir, fr[2] * L), at(f.base, f.dir, L + spec.radius * 0.5));
  }
  return lm; // order: wrist, thumb 1-4, index 5-8, middle 9-12, ring 13-16, little 17-20 (fingerAxes is thumb first)
}

/** Points sampled on the mesh surface, area-weighted (seeded), each with its triangle's first vertex label. */
function sampleSurface(mesh: Mesh, labels: Uint8Array, n: number, seed = 7): { points: Float32Array; labels: Uint8Array } {
  const V = mesh.vertices, I = mesh.indices;
  const nt = I.length / 3;
  const cdf = new Float64Array(nt);
  let total = 0;
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
    const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
    total += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    cdf[t] = total;
  }
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const points = new Float32Array(n * 3);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = rnd() * total;
    let lo = 0, hi = nt - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    let u = rnd(), v = rnd();
    if (u + v > 1) (u = 1 - u), (v = 1 - v);
    const a = I[lo * 3] * 3, b = I[lo * 3 + 1] * 3, c = I[lo * 3 + 2] * 3;
    for (let k = 0; k < 3; k++) points[i * 3 + k] = V[a + k] + u * (V[b + k] - V[a + k]) + v * (V[c + k] - V[a + k]);
    out[i] = labels[I[lo * 3]];
  }
  return { points, labels: out };
}

export function buildDemo(opts: DemoOptions = {}): DemoData {
  const t0 = now();
  const voxelMm = opts.voxelMm ?? 2;
  const ringViews = opts.ringViews ?? 12;
  const elev = opts.ringElevationDeg ?? 12;
  const maskPx = opts.maskPx ?? 224;
  const hand = makeCapsuleHand(DEFAULT_HAND_PARAMS);
  const palmPlane = DEFAULT_HAND_PARAMS.palmThickness / 2; // hand frame: the palm face; the board is here
  // The hand resting on the board: nothing exists beyond the board plane (the thumb's lift and the thick wrist stub are cut).
  const resting: CapsuleHand = { ...hand, sdf: (x, y, z) => Math.max(hand.sdf(x, y, z), z - palmPlane) };
  const b = hand.bounds;
  const center: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const K = intrinsicsFor(maskPx, maskPx, 42);
  const views: CarveView[] = [];
  const add = (dir: Vec3, up: Vec3) => {
    const eye: Vec3 = [center[0] + dir[0] * 380, center[1] + dir[1] * 380, center[2] + dir[2] * 380];
    const pose = lookAtPose(eye, center, up);
    views.push({ mask: renderSilhouette(resting, K, pose), intrinsics: K, pose });
  };
  const e = (elev * Math.PI) / 180;
  for (let k = 0; k < ringViews; k++) {
    const a = (2 * Math.PI * k) / ringViews;
    add([Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), -Math.sin(e)], [0, 0, -1]);
  }
  add([0, 0, -1], [0, 1, 0]);
  const t1 = now();
  // Search volume: room around the hand; its +z face is the board, its -y face cuts the forearm (wrist stub) at -45 mm.
  const PAD = 15;
  const bounds = { min: [b.min[0] - PAD, -45, b.min[2] - PAD] as Vec3, max: [b.max[0] + PAD, b.max[1] + PAD, palmPlane] as Vec3 };
  const r = reconstructHand(views, bounds, { voxelMm, frame: hand.frame, fingers: hand.fingerAxes, ignoreGate: true, cutFaces: ["+z", "-y"], planeNormal: [0, 0, 1] });
  const t2 = now();
  if (!r.mesh || !r.confidence) throw new Error(`the synthetic reconstruction failed: ${r.failure ?? "no mesh"}`);
  const support = vertexSupport(r.mesh, r.confidence, bounds, { supportFace: "+z", cutFaces: ["-y"], tolMm: voxelMm * 0.75 });

  // into the board frame
  const nv = r.mesh.vertices.length / 3;
  const vertices = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) toBoard(r.mesh.vertices[i * 3], r.mesh.vertices[i * 3 + 1], r.mesh.vertices[i * 3 + 2], palmPlane, vertices, i * 3);
  const mesh: Mesh = { vertices, indices: r.mesh.indices };
  const lmHand = syntheticLandmarks(hand);
  const landmarks = new Float32Array(63);
  lmHand.forEach((p, i) => toBoard(p[0], p[1], p[2], palmPlane, landmarks, i * 3));
  const sampled = sampleSurface(mesh, support, opts.cloudPoints ?? 60_000);
  // per-point colour: height above the board, pale to deep blue (a demo of per-point colour, not a photo colour)
  const np = sampled.labels.length;
  const pointColors = new Float32Array(np * 3);
  let zMax = 1e-6;
  for (let i = 0; i < np; i++) zMax = Math.max(zMax, sampled.points[i * 3 + 2]);
  for (let i = 0; i < np; i++) {
    const t = Math.max(0, Math.min(1, sampled.points[i * 3 + 2] / zMax));
    pointColors[i * 3] = 0.78 - 0.66 * t;
    pointColors[i * 3 + 1] = 0.85 - 0.48 * t;
    pointColors[i * 3 + 2] = 0.98 - 0.1 * t;
  }
  return {
    mesh,
    confidence: r.confidence,
    support,
    points: sampled.points,
    pointLabels: sampled.labels,
    pointColors,
    landmarks,
    // hand frame (origin at the wrist plane centre; x little finger, y fingers, z out of the palm) in board coordinates
    handFrame: { origin: [0, 0, palmPlane], x: [0, 1, 0], y: [1, 0, 0], z: [0, 0, -1] },
    info: { views: views.length, voxelMm, maskPx, ringElevationDeg: elev, ms: { render: t1 - t0, reconstruct: t2 - t1, total: now() - t0 }, accepted: r.quality?.accepted ?? false, reasons: r.quality?.reasons ?? [] },
  };
}

/** A procedural stress set for the performance check: a bumpy closed surface of about `triangles` triangles and a cloud
 *  of `points` points on it, in the board frame (resting on z = 0). Not a hand. */
export function buildStress(triangles = 500_000, points = 200_000): { mesh: Mesh; points: Float32Array; pointLabels: Uint8Array } {
  const rows = Math.round(Math.sqrt(triangles / 4));
  const cols = rows * 2;
  const nv = (rows + 1) * cols;
  const V = new Float32Array(nv * 3);
  const shape = (th: number, ph: number): [number, number, number] => {
    const bump = 1 + 0.06 * Math.sin(7 * th) * Math.sin(5 * ph);
    return [110 * Math.sin(th) * Math.cos(ph) * bump, 45 * Math.sin(th) * Math.sin(ph) * bump, 22 * (1 - Math.cos(th)) * bump];
  };
  for (let i = 0; i <= rows; i++)
    for (let j = 0; j < cols; j++) {
      const p = shape((Math.PI * i) / rows, (2 * Math.PI * j) / cols);
      V.set(p, (i * cols + j) * 3);
    }
  const I = new Uint32Array(rows * cols * 6);
  let k = 0;
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) {
      const a = i * cols + j, b = i * cols + ((j + 1) % cols), c = a + cols, d = b + cols;
      I[k++] = a; I[k++] = c; I[k++] = b;
      I[k++] = b; I[k++] = c; I[k++] = d;
    } // fmt: skip
  const P = new Float32Array(points * 3);
  const L = new Uint8Array(points);
  let s = 11;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let n = 0; n < points; n++) {
    const th = Math.acos(1 - 2 * rnd()), ph = 2 * Math.PI * rnd();
    P.set(shape(th, ph), n * 3);
    L[n] = th < 0.35 ? 2 : th > 2.7 ? 1 : 0;
  }
  return { mesh: { vertices: V, indices: I }, points: P, pointLabels: L };
}
