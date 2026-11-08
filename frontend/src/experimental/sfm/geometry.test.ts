// Unit tests of the EXPERIMENTAL sfm/ geometry and bundle adjustment on exact synthetic correspondences (no pictures).
import { describe, expect, it } from "vitest";
import { lookAtPose } from "../reconstruction/linalg";
import { gaussian, makeRng } from "../reconstruction/rng";
import { silhouettePoints } from "../coin/sceneScaleStudy";
import { fitCoinCircle3D } from "../coin/sceneScale";
import { bundleAdjust, type BAProblem } from "./bundle";
import { bougnouxFocal, decomposeHomography, fundamental8, homographyDLT, p3p, pnpRansac, poseFromEssential, projectEssential, projectPx, triangulate, undistort, type Cam } from "./geometry";
import { m3mul, m3T, m3v, rotDiffDeg, vnorm, vsub, vunit, type M3, type V3 } from "./mat";

const cam: Cam = { f: 1000, cx: 640, cy: 360, k1: -0.06, k2: 0.02 };

function ring(n: number, elevDeg: number, dist = 340): { R: M3; t: V3 }[] {
  const out: { R: M3; t: V3 }[] = [];
  const e = (elevDeg * Math.PI) / 180;
  for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * k) / n;
    const p = lookAtPose([dist * Math.cos(e) * Math.cos(a), dist * Math.cos(e) * Math.sin(a), dist * Math.sin(e) + 10], [0, 0, 10], [0, 0, 1]);
    out.push({ R: [...p.R], t: [p.t[0], p.t[1], p.t[2]] });
  }
  return out;
}

function points(n: number, planar: boolean, seed = 3): V3[] {
  const rng = makeRng(seed);
  return Array.from({ length: n }, () => [(rng() - 0.5) * 300, (rng() - 0.5) * 300, planar ? 0 : rng() * 40] as V3);
}

describe("sfm geometry (exact synthetic correspondences)", () => {
  it("undistort inverts projectPx's distortion", () => {
    const [x, y] = undistort(cam, 1200, 650);
    const q = projectPx(cam, [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0], [x, y, 1])!;
    expect(Math.hypot(q[0] - 1200, q[1] - 650)).toBeLessThan(1e-6);
  });

  it("8-point F and the essential-matrix pose recover the relative motion of a general scene; Bougnoux gives f", () => {
    const P = points(200, false);
    const [c1, c2] = ring(12, 30);
    const K0: Cam = { ...cam, k1: 0, k2: 0 };
    const a: [number, number][] = [], b: [number, number][] = [], pa: [number, number][] = [], pb: [number, number][] = [];
    for (const X of P) {
      const u = projectPx(K0, c1.R, c1.t, X), v = projectPx(K0, c2.R, c2.t, X);
      if (!u || !v) continue;
      pa.push(u);
      pb.push(v);
      a.push(undistort(K0, u[0], u[1]));
      b.push(undistort(K0, v[0], v[1]));
    }
    const E = projectEssential(fundamental8(a, b)!);
    const rel = poseFromEssential(E, a, b);
    const Rtrue = m3mul(c2.R, m3T(c1.R));
    expect(rotDiffDeg(rel.R, Rtrue)).toBeLessThan(1e-4);
    const ttrue = vsub(c2.t, m3v(Rtrue, c1.t));
    expect(1 - Math.abs(vunit(rel.t)[0] * vunit(ttrue)[0] + vunit(rel.t)[1] * vunit(ttrue)[1] + vunit(rel.t)[2] * vunit(ttrue)[2])).toBeLessThan(1e-8);
    // Bougnoux's formula is degenerate when the optical axes meet (every camera of the capture aims at the hand):
    const fMeet = bougnouxFocal(fundamental8(pa, pb)!, cam.cx, cam.cy);
    // with the second camera turned 8 degrees off the common point the axes no longer meet and it works
    const c2b = { R: m3mul([Math.cos(0.14), 0, Math.sin(0.14), 0, 1, 0, -Math.sin(0.14), 0, Math.cos(0.14)], c2.R), t: c2.t };
    const qa: [number, number][] = [], qb: [number, number][] = [];
    for (const X of P) {
      const u = projectPx(K0, c1.R, c1.t, X), v = projectPx(K0, c2b.R, c2b.t, X);
      if (u && v) (qa.push(u), qb.push(v));
    }
    const f = bougnouxFocal(fundamental8(qa, qb)!, cam.cx, cam.cy);
    console.log(`Bougnoux: axes meeting -> ${fMeet === null ? "no solution" : fMeet.toFixed(1)}; axes apart -> ${f?.toFixed(1)} (true 1000)`);
    expect(f).not.toBeNull();
    expect(Math.abs(f! - 1000)).toBeLessThan(5);
  });

  it("homography decomposition recovers the motion for a planar scene (one of the physical solutions)", () => {
    const P = points(200, true);
    const [c1, c2] = ring(12, 12);
    const K0: Cam = { ...cam, k1: 0, k2: 0 };
    const a: [number, number][] = [], b: [number, number][] = [];
    for (const X of P) {
      const u = projectPx(K0, c1.R, c1.t, X), v = projectPx(K0, c2.R, c2.t, X);
      if (!u || !v) continue;
      a.push(undistort(K0, u[0], u[1]));
      b.push(undistort(K0, v[0], v[1]));
    }
    const H = homographyDLT(a, b)!;
    const sols = decomposeHomography(H, a, b);
    const Rtrue = m3mul(c2.R, m3T(c1.R));
    expect(sols.length).toBeGreaterThanOrEqual(1);
    expect(Math.min(...sols.map((s) => rotDiffDeg(s.R, Rtrue)))).toBeLessThan(1e-3);
  });

  it("P3P and PnP-RANSAC recover a pose from planar points with outliers", () => {
    const P = points(100, true);
    const c = ring(8, 12)[3];
    const K0: Cam = { ...cam, k1: 0, k2: 0 };
    const x: [number, number][] = [], X: V3[] = [];
    const rng = makeRng(5);
    P.forEach((p, i) => {
      const u = projectPx(K0, c.R, c.t, p);
      if (!u) return;
      const n = undistort(K0, u[0], u[1]);
      x.push(i % 10 === 0 ? [n[0] + 0.05 * (rng() - 0.5), n[1] + 0.05] : n);
      X.push(p);
    });
    const sols = p3p([X[1], X[2], X[3]], [x[1], x[2], x[3]].map((q) => vunit([q[0], q[1], 1])));
    expect(Math.min(...sols.map((s) => rotDiffDeg(s.R, c.R)))).toBeLessThan(1e-6);
    const r = pnpRansac(X, x, 2 / 1000, rng)!;
    expect(rotDiffDeg(r.R, c.R)).toBeLessThan(1e-6);
    expect(r.inliers.length).toBeGreaterThanOrEqual(Math.floor(X.length * 0.85));
  });

  it("triangulates exactly", () => {
    const cs = ring(6, 20);
    const X: V3 = [12, -30, 7];
    const obs = cs.map((c) => {
      const q = m3v(c.R, X);
      return { R: c.R, t: c.t, x: (q[0] + c.t[0]) / (q[2] + c.t[2]), y: (q[1] + c.t[1]) / (q[2] + c.t[2]) };
    });
    expect(vnorm(vsub(triangulate(obs)!, X))).toBeLessThan(1e-8);
  });

  it("bundle adjustment recovers focal length and k1 from a ring + top view of a PLANAR scene, starting 8 % off", () => {
    const cams = [...ring(12, 12), ...ring(6, 35)];
    const top = lookAtPose([0, 0, 410], [0, 0, 10], [0, 1, 0]);
    cams.push({ R: [...top.R], t: [top.t[0], top.t[1], top.t[2]] });
    const P = points(1500, true, 9);
    const rng = makeRng(11);
    const obsCam: number[] = [], obsPt: number[] = [], obsU: number[] = [], obsV: number[] = [];
    P.forEach((X, pi) => {
      cams.forEach((c, ci) => {
        const q = projectPx(cam, c.R, c.t, X);
        if (!q || q[0] < 0 || q[1] < 0 || q[0] > 1280 || q[1] > 720) return;
        obsCam.push(ci);
        obsPt.push(pi);
        obsU.push(q[0] + 0.5 * gaussian(rng));
        obsV.push(q[1] + 0.5 * gaussian(rng));
      });
    });
    // perturbed start: focal 8 % long, no distortion, poses rotated ~1 degree, points jittered
    const prob: BAProblem = {
      cams: cams.map((c, i) => ({ R: m3mul([1, -0.01 * Math.sin(i), 0.01, 0.01 * Math.sin(i), 1, 0, -0.01, 0, 1], c.R), t: [c.t[0] + 2, c.t[1] - 1, c.t[2] + 3] })),
      cam: { ...cam, f: 1080, k1: 0, k2: 0 },
      points: Float64Array.from(P.flatMap((X) => [X[0] + 2 * gaussian(rng), X[1] + 2 * gaussian(rng), X[2] + 1 * gaussian(rng)])),
      obsCam: Int32Array.from(obsCam),
      obsPt: Int32Array.from(obsPt),
      obsU: Float64Array.from(obsU),
      obsV: Float64Array.from(obsV),
    };
    const t0 = performance.now();
    const r = bundleAdjust(prob, { refineFocal: true, refineK1: true, refineK2: true, iterations: 60 });
    const ms = performance.now() - t0;
    // the result is up to a similarity: compare relative rotations
    const relErr = cams.slice(1).map((c, i) => rotDiffDeg(m3mul(prob.cams[i + 1].R, m3T(prob.cams[0].R)), m3mul(c.R, m3T(cams[0].R))));
    console.log(`BA synthetic planar: ${obsCam.length} obs, rms ${r.initialRmsPx.toFixed(1)} -> ${r.rmsPx.toFixed(3)} px in ${r.iterations} it, ${ms.toFixed(0)} ms; f ${prob.cam.f.toFixed(2)} (true 1000), k1 ${prob.cam.k1.toFixed(4)}, k2 ${prob.cam.k2.toFixed(4)}; max rel rot err ${Math.max(...relErr).toFixed(4)} deg`);
    expect(r.rmsPx).toBeLessThan(0.8);
    expect(Math.abs(prob.cam.f - 1000) / 1000).toBeLessThan(0.005);
    expect(Math.abs(prob.cam.k1 + 0.06)).toBeLessThan(0.01);
    expect(Math.max(...relErr)).toBeLessThan(0.05);
  });

  it("joint coin fit in the bundle adjustment: the scale comes out of the same optimum as perturbed poses (vs a post-hoc fit on them)", () => {
    // planar textured points + a 23.00 x 1.5 mm coin at the origin; the "SfM" frame is the true one scaled by 0.04
    const S = 0.04, D = 23, T = 1.5;
    const cams = [...ring(16, 12), ...ring(4, 35)].filter((_, i) => i % 2 === 0 || i >= 16);
    const P = points(800, true, 21).filter((X) => Math.hypot(X[0], X[1]) > 25);
    const rng = makeRng(31);
    const obsCam: number[] = [], obsPt: number[] = [], obsU: number[] = [], obsV: number[] = [];
    P.forEach((X, pi) =>
      cams.forEach((c, ci) => {
        const q = projectPx(cam, c.R, c.t, X);
        if (!q || q[0] < 0 || q[1] < 0 || q[0] > 1280 || q[1] > 720) return;
        obsCam.push(ci);
        obsPt.push(pi);
        obsU.push(q[0] + 0.4 * gaussian(rng));
        obsV.push(q[1] + 0.4 * gaussian(rng));
      }),
    );
    // coin edges: the cylinder silhouette (undistorted) -> distorted pixels, 0.3 px noise
    const distort = (u: number, v: number) => {
      const x = (u - cam.cx) / cam.f, y = (v - cam.cy) / cam.f, r2 = x * x + y * y, d = 1 + cam.k1 * r2 + cam.k2 * r2 * r2;
      return { x: cam.f * x * d + cam.cx + 0.3 * gaussian(rng), y: cam.f * y * d + cam.cy + 0.3 * gaussian(rng) };
    };
    const K = { fx: cam.f, fy: cam.f, cx: cam.cx, cy: cam.cy };
    const coinViews = cams.map((c, i) => ({ cam: i, pts: silhouettePoints(K, { R: c.R, t: c.t }, D, T, 120)!.pts.map((p) => distort(p.x, p.y)) }));
    // perturbed start in scene units: poses off by ~0.3 degrees and ~1 mm, points jittered
    const start = cams.map((c, i) => {
      const a = 0.005 * Math.sin(3 * i + 1), b = 0.005 * Math.cos(5 * i);
      return { R: m3mul([1, -a, b, a, 1, 0, -b, 0, 1], c.R), t: [(c.t[0] + Math.sin(i)) * S, (c.t[1] - Math.cos(i)) * S, (c.t[2] + 0.5) * S] as V3 };
    });
    const und = (pts: readonly { x: number; y: number }[]) => pts.map((p) => {
      const [x, y] = undistort(cam, p.x, p.y);
      return { x: cam.f * x + cam.cx, y: cam.f * y + cam.cy };
    });
    const postHoc = fitCoinCircle3D(coinViews.map((v) => ({ K, pose: { R: start[v.cam].R, t: start[v.cam].t }, points: und(v.pts) })), { diameterMm: D, thicknessMm: T, model: "cylinder" });
    const prob: BAProblem = {
      cams: start.map((c) => ({ R: c.R, t: c.t })),
      cam: { ...cam },
      points: Float64Array.from(P.flatMap((X) => [X[0] * S, X[1] * S, X[2] * S])),
      obsCam: Int32Array.from(obsCam),
      obsPt: Int32Array.from(obsPt),
      obsU: Float64Array.from(obsU),
      obsV: Float64Array.from(obsV),
      coin: { views: coinViews, thicknessRatio: T / D, state: { centre: [...postHoc.circle!.center] as V3, normal: [...postHoc.circle!.normal] as V3, radius: postHoc.circle!.radius } },
    };
    // (a) bundle adjustment WITHOUT the coin, then the post-hoc fit on its refined poses
    const plain: BAProblem = { ...prob, cams: prob.cams.map((c) => ({ ...c })), cam: { ...cam }, points: Float64Array.from(prob.points), coin: null };
    bundleAdjust(plain, { refineFocal: true, refineK1: true, refineK2: true, iterations: 40 });
    const ph2 = fitCoinCircle3D(coinViews.map((v) => ({ K: { fx: plain.cam.f, fy: plain.cam.f, cx: cam.cx, cy: cam.cy }, pose: { R: plain.cams[v.cam].R, t: plain.cams[v.cam].t }, points: und(v.pts) })), { diameterMm: D, thicknessMm: T, model: "cylinder" });
    // the BA result is up to a similarity: compare the coin scale with the scale of its own camera centres
    const centre = (c: { R: readonly number[]; t: readonly number[] }) => m3v(m3T(c.R), [-c.t[0], -c.t[1], -c.t[2]]);
    const spread = (cs: V3[]) => {
      const m = cs.reduce((a, c) => [a[0] + c[0] / cs.length, a[1] + c[1] / cs.length, a[2] + c[2] / cs.length], [0, 0, 0]);
      return Math.sqrt(cs.reduce((a, c) => a + vnorm(vsub(c, m as V3)) ** 2, 0));
    };
    const trueSpread = spread(cams.map(centre));
    const scaleAfterBA = (ph2.mmPerUnit! * spread(plain.cams.map(centre))) / trueSpread - 1;
    // (b) joint
    const r = bundleAdjust(prob, { refineFocal: true, refineK1: true, refineK2: true, iterations: 40 });
    const scalePostHoc = postHoc.mmPerUnit! * S - 1;
    const scaleJoint = ((D / 2 / prob.coin!.state.radius) * spread(prob.cams.map(centre))) / trueSpread - 1;
    // a BA without the coin, then the post-hoc fit on its poses
    console.log(`coin scale error (SIMULATED, synthetic tracks): post-hoc on 0.3 deg / 1 mm perturbed poses ${(scalePostHoc * 100).toFixed(2)} %, post-hoc after a BA without the coin ${(scaleAfterBA * 100).toFixed(3)} %, joint BA ${(scaleJoint * 100).toFixed(3)} % (feature rms ${r.rmsPx.toFixed(2)} px, coin rms ${r.coinRmsPx?.toFixed(2)} px, f ${prob.cam.f.toFixed(1)})`);
    expect(Math.abs(scaleJoint)).toBeLessThan(0.003);
    expect(Math.abs(scaleAfterBA)).toBeLessThan(0.005);
    expect(Math.abs(prob.cam.f - 1000) / 1000).toBeLessThan(0.005);
  }, 120_000);
});
