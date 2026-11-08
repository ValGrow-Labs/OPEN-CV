// The SIMULATED results that README.md quotes: rendered views of the board with known truth, through the detector, the
// pose, the calibration and the coin check. Opt in (about 10 to 15 minutes): RUN_BOARD_SWEEP=1. Each table is printed
// to the console, labelled SIMULATED. A short smoke test runs by default.
//
// Nothing here says anything about real phones, real lenses or real prints: the renderer draws an ideal matte sheet.
import { describe, expect, it } from "vitest";
import type { CameraPose, Intrinsics, Pt } from "../common";
import { cameraCenter, intrinsicsFromHfov, rotationAngleBetween } from "../geometry/camera";
import { seededRandom } from "../geometry/linalg";
import { calibrateCamera, viewFromDetections, type PlanarView } from "./calibrate";
import { checkCoinScale } from "./coinCheck";
import { detectMarkers } from "./detect";
import { MARKER_CODES } from "./dictionary";
import { estimateBoardPose } from "./pose";
import { handOccluders, occludedFromCamera, orbitPose, projectedMarkerCorners, renderBoardView, type Ellipsoid, type RenderOptions } from "./render";
import { BOARD, PAPER, type BoardLayout, type BoardMarker } from "./spec";

const HFOV = 65;
const DIST = { k1: -0.08, k2: 0.02 };
const intr = (w: number, h: number): Intrinsics => ({ ...intrinsicsFromHfov(w, h, HFOV), ...DIST });
const HAND_CENTRE = { x: 124.5, y: 105, z: 0 };
const STANDARD: RenderOptions = { blurSigmaPx: 0.8, noiseSigma: 3, light: { gradientX: 0.15, vignette: 0.2 } };
const HARD: RenderOptions = { blurSigmaPx: 1.5, noiseSigma: 6, motionBlur: { lengthPx: 4, angleDeg: 30 }, light: { gradientX: 0.3, gradientY: 0.15, vignette: 0.3, level: 0.85 } };
const AZIMUTHS = [0, 45, 90, 135, 180, 225, 270, 315];
const ELEVATIONS = [90, 60, 45, 30, 20, 15, 12, 10];

interface ViewStats {
  visible: number;
  correct: number;
  falseDet: number;
  cornerErr: number[];
  /** per visible marker: projected cell size (shortest side / 6, px) and whether it was found */
  cells: { cellPx: number; found: boolean }[];
  poseOk: boolean;
  markersUsed: number;
  rotErrDeg: number;
  centreErrMm: number;
  detMs: number;
}

function evaluateView(K: Intrinsics, pose: CameraPose, render: RenderOptions, layout: BoardLayout = BOARD, occluders: readonly Ellipsoid[] = []): ViewStats {
  const img = renderBoardView(K, pose, { ...render, layout, occluders });
  const det = detectMarkers(img, { layout });
  const truth = projectedMarkerCorners(K, pose, layout);
  const S = layout.markerMm;
  const visibleIds = new Set<number>();
  const cells: ViewStats["cells"] = [];
  for (const m of layout.markers) {
    const cs = truth.get(m.id)!;
    if (cs.some((p) => !p || p.x < 1 || p.y < 1 || p.x > K.width - 2 || p.y > K.height - 2)) continue;
    const probe: Pt[] = [{ x: m.x, y: m.y }, { x: m.x + S, y: m.y }, { x: m.x, y: m.y + S }, { x: m.x + S, y: m.y + S }, { x: m.x + S / 2, y: m.y + S / 2 }];
    if (occluders.length && probe.some((p) => occludedFromCamera(pose, p, occluders))) continue;
    visibleIds.add(m.id);
    const sides = [0, 1, 2, 3].map((i) => Math.hypot(cs[(i + 1) % 4]!.x - cs[i]!.x, cs[(i + 1) % 4]!.y - cs[i]!.y));
    cells.push({ cellPx: Math.min(...sides) / 6, found: false });
  }
  let correct = 0, falseDet = 0;
  const cornerErr: number[] = [];
  const visibleList = [...visibleIds];
  for (const d of det.markers) {
    const t = truth.get(d.id)!;
    const errs = d.corners.map((p, i) => (t[i] ? Math.hypot(p.x - t[i]!.x, p.y - t[i]!.y) : Infinity));
    if (Math.max(...errs) > 3) {
      falseDet++;
      continue;
    }
    if (visibleIds.has(d.id)) {
      correct++;
      cells[visibleList.indexOf(d.id)].found = true;
    }
    cornerErr.push(...errs);
  }
  const p = estimateBoardPose(K, det.markers, { layout });
  const ok = p.ok && p.markersUsed >= 2;
  const c0 = cameraCenter(pose);
  return {
    visible: visibleIds.size,
    correct,
    falseDet,
    cornerErr,
    cells,
    poseOk: ok,
    markersUsed: p.ok ? p.markersUsed : 0,
    rotErrDeg: ok && p.ok ? rotationAngleBetween(p.pose.R, pose.R) : NaN,
    centreErrMm: ok && p.ok ? Math.hypot(...cameraCenter(p.pose).map((v, i) => v - c0[i])) : NaN,
    detMs: det.timingsMs.total,
  };
}

const med = (v: number[]) => {
  const s = v.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : NaN;
};
const max = (v: number[]) => (v.filter(Number.isFinite).length ? Math.max(...v.filter(Number.isFinite)) : NaN);
const rmsOf = (v: number[]) => (v.length ? Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length) : NaN);
const f = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "-");

function summarise(rows: ViewStats[]) {
  const vis = rows.reduce((s, r) => s + r.visible, 0);
  const cor = rows.reduce((s, r) => s + r.correct, 0);
  const errs = rows.flatMap((r) => r.cornerErr);
  return {
    visPerView: vis / rows.length,
    rate: vis ? cor / vis : NaN,
    cornerRms: rmsOf(errs),
    cornerMax: max(errs),
    falseDet: rows.reduce((s, r) => s + r.falseDet, 0),
    poseViews: rows.filter((r) => r.poseOk).length,
    minUsed: Math.min(...rows.map((r) => r.markersUsed)),
    rotMed: med(rows.map((r) => r.rotErrDeg)),
    rotMax: max(rows.map((r) => r.rotErrDeg)),
    ctrMed: med(rows.map((r) => r.centreErrMm)),
    ctrMax: max(rows.map((r) => r.centreErrMm)),
    ms: rows.reduce((s, r) => s + r.detMs, 0) / rows.length,
  };
}

const HEADER =
  "| elev (deg) | dist (mm) | visible / view | detected | corner RMS (px) | worst corner (px) | false | views with pose | fewest markers used | rot. err. median / max (deg) | camera-centre err. median / max (mm) | detect (ms) |\n|---|---|---|---|---|---|---|---|---|---|---|---|";
function row(e: number, d: number, s: ReturnType<typeof summarise>, n: number) {
  return `| ${e} | ${d} | ${f(s.visPerView, 1)} | ${f(100 * s.rate, 0)} % | ${f(s.cornerRms)} | ${f(s.cornerMax)} | ${s.falseDet} | ${s.poseViews}/${n} | ${s.minUsed} | ${f(s.rotMed, 3)} / ${f(s.rotMax, 3)} | ${f(s.ctrMed)} / ${f(s.ctrMax)} | ${f(s.ms, 0)} |`;
}

/** A board layout like spec.ts with other numbers (for the board-change proposal only; spec.ts is not changed). */
function altLayout(markerMm: number, longCount: number, rightCount: number, gapMm: number, marginMm = 8): BoardLayout {
  const markers: BoardMarker[] = [];
  const add = (x: number, y: number) => markers.push({ id: markers.length, code: MARKER_CODES[markers.length], x, y });
  const rowSpan = longCount * markerMm + (longCount - 1) * gapMm;
  const x0 = PAPER.widthMm - marginMm - rowSpan;
  for (let i = 0; i < longCount; i++) add(x0 + i * (markerMm + gapMm), PAPER.heightMm - marginMm - markerMm);
  const colSpan = rightCount * markerMm + (rightCount - 1) * gapMm;
  const yTop = (PAPER.heightMm + colSpan) / 2 - markerMm;
  for (let i = 0; i < rightCount; i++) add(PAPER.widthMm - marginMm - markerMm, yTop - i * (markerMm + gapMm));
  for (let i = longCount - 1; i >= 0; i--) add(x0 + i * (markerMm + gapMm), marginMm);
  const rightInner = PAPER.widthMm - marginMm - markerMm - gapMm;
  return {
    ...BOARD,
    markerMm,
    markers,
    coinTarget: { ...BOARD.coinTarget, center: { x: rightInner - 20, y: PAPER.heightMm / 2 } },
    handArea: { minX: 0, minY: marginMm + markerMm + gapMm, maxX: rightInner, maxY: PAPER.heightMm - marginMm - markerMm - gapMm },
  };
}

const out: string[] = [];
const cellBins = [0, 1.5, 2, 2.5, 3, 4, 6, Infinity];
const cellCounts = cellBins.slice(1).map(() => ({ n: 0, found: 0 }));
function addCells(rows: ViewStats[]) {
  for (const r of rows)
    for (const c of r.cells) {
      const b = cellBins.findIndex((lo, i) => c.cellPx >= lo && c.cellPx < cellBins[i + 1]);
      cellCounts[b].n++;
      if (c.found) cellCounts[b].found++;
    }
}

describe("board sweep smoke test (SIMULATED)", () => {
  it("evaluateView reports a perfect top view", () => {
    const K = intr(1280, 720);
    const s = evaluateView(K, orbitPose(HAND_CENTRE, 400, 90, 270), { ...STANDARD, seed: 1 });
    expect(s.visible).toBe(16);
    expect(s.correct).toBe(16);
    expect(s.falseDet).toBe(0);
    expect(s.rotErrDeg).toBeLessThan(0.05);
  });
});

describe.skipIf(!process.env.RUN_BOARD_SWEEP)("board sweep (SIMULATED, opt in)", () => {
  for (const [w, h] of [
    [1280, 720],
    [1920, 1080],
  ] as const)
    it(`detection and pose vs elevation and distance, ${w} x ${h}, no hand`, () => {
      const K = intr(w, h);
      const lines = [
        `SIMULATED (rendered images with known truth; says nothing about real phones or real prints). Detection and pose, ${w} x ${h}, hfov ${HFOV} deg, k1 ${DIST.k1}, k2 ${DIST.k2}, blur sigma ${STANDARD.blurSigmaPx} px, noise sigma ${STANDARD.noiseSigma} grey levels, light gradient +-15 % and vignette 20 %, no hand. 8 azimuths per row (camera looking at the hand-area centre); pose with the true intrinsics.`,
        HEADER,
      ];
      for (const d of [250, 350, 450])
        for (const e of ELEVATIONS) {
          const rows = AZIMUTHS.map((a, i) => evaluateView(K, orbitPose(HAND_CENTRE, d, e, a), { ...STANDARD, seed: 1000 * e + 10 * d + i + w }));
          addCells(rows);
          lines.push(row(e, d, summarise(rows), rows.length));
        }
      out.push(lines.join("\n"));
      console.log(lines.join("\n"));
    }, 3_600_000);

  it("detection probability vs projected cell size (from the two tables above)", () => {
    const lines = [
      "SIMULATED. Share of visible markers detected, by the marker's projected cell size (its shortest image side / 6), pooled over both resolutions, all distances, elevations and azimuths above.",
      "| cell size (px) | markers | detected |\n|---|---|---|",
    ];
    cellCounts.forEach((c, i) => lines.push(`| ${cellBins[i]} to ${Number.isFinite(cellBins[i + 1]) ? cellBins[i + 1] : "more"} | ${c.n} | ${c.n ? f((100 * c.found) / c.n, 0) : "-"} % |`));
    out.push(lines.join("\n"));
    console.log(lines.join("\n"));
  });

  for (const [label, cond] of [
    ["standard", STANDARD],
    ["hard", HARD],
  ] as const)
    it(`with the hand on the board (${label} imaging), 1280 x 720`, () => {
      const K = intr(1280, 720);
      const hand = handOccluders();
      const condText =
        label === "standard"
          ? "blur sigma 0.8 px, noise 3, light +-15 %"
          : "HARD: blur sigma 1.5 px + 4 px motion blur, noise sigma 6, light +-30 % / +-15 %, vignette 30 %, exposure 85 %";
      const lines = [
        `SIMULATED. With a crude hand (7 ellipsoids, up to 36 mm high) resting palm-down; 1280 x 720, ${condText}. "visible" excludes markers the hand hides (any corner or the centre). 8 azimuths per row.`,
        HEADER,
      ];
      for (const d of [350, 450])
        for (const e of ELEVATIONS) {
          const rows = AZIMUTHS.map((a, i) => evaluateView(K, orbitPose(HAND_CENTRE, d, e, a), { ...cond, seed: 5000 + 1000 * e + d + i }, BOARD, hand));
          lines.push(row(e, d, summarise(rows), rows.length));
        }
      out.push(lines.join("\n"));
      console.log(lines.join("\n"));
    }, 3_600_000);

  it("board-change evidence: larger markers at grazing elevations (alternative layouts, spec.ts unchanged)", () => {
    const K = intr(1280, 720);
    const hand = handOccluders();
    const layouts: [string, BoardLayout][] = [
      ["v1 (spec): 16 x 30 mm, gap 10", BOARD],
      ["36 mm, 6 per row + 2, gap 9", altLayout(36, 6, 2, 9)],
      ["40 mm, 6 per row + 2, gap 8", altLayout(40, 6, 2, 8)],
    ];
    const lines = [
      "SIMULATED. Alternative layouts (same A4 sheet, same dictionary, same margins) with the hand, 1280 x 720, standard imaging, 8 azimuths. Hand-area width (y extent): v1 114 mm, 36 mm markers 102 mm, 40 mm markers 98 mm.",
      "| layout | elev (deg) | dist (mm) | visible / view | detected | views with pose | fewest markers used | rot. err. median / max (deg) | camera-centre err. median / max (mm) |\n|---|---|---|---|---|---|---|---|---|",
    ];
    for (const [name, layout] of layouts)
      for (const d of [350, 450])
        for (const e of [15, 12, 10]) {
          const rows = AZIMUTHS.map((a, i) => evaluateView(K, orbitPose(HAND_CENTRE, d, e, a), { ...STANDARD, seed: 9000 + 1000 * e + d + i }, layout, hand));
          const s = summarise(rows);
          lines.push(`| ${name} | ${e} | ${d} | ${f(s.visPerView, 1)} | ${f(100 * s.rate, 0)} % | ${s.poseViews}/8 | ${s.minUsed} | ${f(s.rotMed, 3)} / ${f(s.rotMax, 3)} | ${f(s.ctrMed)} / ${f(s.ctrMax)} |`);
        }
    out.push(lines.join("\n"));
    console.log(lines.join("\n"));
  }, 3_600_000);

  it("calibration error vs number of views", () => {
    const K = intr(1280, 720);
    const lines = [
      `SIMULATED. Zhang self-calibration from rendered views through the detector (1280 x 720, true hfov ${HFOV} deg so fx = ${K.fx.toFixed(1)} px, k1 ${DIST.k1}, k2 ${DIST.k2}, standard imaging, no hand). Square pixels, principal point fixed at the centre (true), k2 automatic. 3 random view sets per N.`,
      "| views | view set | |focal error| mean / max (%) | focal sd reported, mean (%) | k1 error mean / max | k2 used | RMS (px) | fell back to assumed hfov | time (ms) |\n|---|---|---|---|---|---|---|---|---|",
    ];
    const kinds: [string, (rnd: ReturnType<typeof seededRandom>, i: number) => CameraPose][] = [
      ["random, 30 to 70 deg", (rnd) => orbitPose({ x: 110 + 40 * rnd.uniform(), y: 85 + 40 * rnd.uniform(), z: 0 }, 330 + 150 * rnd.uniform(), 30 + 40 * rnd.uniform(), 360 * rnd.uniform())],
      ["capture-like: 1 top + ring at 12 to 15 deg", (rnd, i) => (i === 0 ? orbitPose(HAND_CENTRE, 400, 90, 270) : orbitPose(HAND_CENTRE, 330 + 60 * rnd.uniform(), 12 + 3 * rnd.uniform(), (i * 137.5) % 360))],
    ];
    for (const [kindName, gen] of kinds) {
      const sets: PlanarView[][] = [];
      for (let s = 0; s < 3; s++) {
        const rnd = seededRandom(700 + s);
        const views: PlanarView[] = [];
        for (let i = 0; i < 20; i++) {
          const img = renderBoardView(K, gen(rnd, i), { ...STANDARD, seed: 7000 + 100 * s + i });
          views.push(viewFromDetections(detectMarkers(img).markers));
        }
        sets.push(views);
      }
      for (const n of [3, 5, 10, 20]) {
        const fe: number[] = [], sd: number[] = [], ke: number[] = [], rm: number[] = [], ms: number[] = [];
        let k2used = 0, fell = 0;
        for (const views of sets) {
          const t0 = performance.now();
          const r = calibrateCamera(views.slice(0, n), K.width, K.height);
          ms.push(performance.now() - t0);
          if (r.method !== "zhang") {
            fell++;
            continue;
          }
          fe.push(Math.abs(100 * (r.intrinsics.fx / K.fx - 1)));
          sd.push((100 * r.std.fx) / r.intrinsics.fx);
          ke.push(Math.abs(r.intrinsics.k1! - DIST.k1));
          rm.push(r.rmsPx);
          if (r.model.distortion === "k1k2") k2used++;
        }
        const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
        lines.push(`| ${n} | ${kindName} | ${f(mean(fe), 3)} / ${f(max(fe), 3)} | ${f(mean(sd), 3)} | ${f(mean(ke), 4)} / ${f(max(ke), 4)} | ${k2used}/${sets.length - fell} | ${f(mean(rm), 3)} | ${fell}/3 | ${f(mean(ms), 0)} |`);
      }
    }
    out.push(lines.join("\n"));
    console.log(lines.join("\n"));
  }, 3_600_000);

  it("coin print-scale check", () => {
    const lines = [
      "SIMULATED. Coin print-scale check: a 23 mm x 1.5 mm cylinder coin (face grey 176, side wall 122, paper 226) on the target, the crude hand on the board, standard imaging, camera 350 mm from the hand centre at azimuth 250 deg, pose from the detected markers. Scale error = measured / true print scale - 1. 'plain circle' = the same edge points fitted by a circle without the thickness model.",
      "| resolution | printed outline | true print scale | elev (deg) | measured scale | error (%) | plain-circle error (%) | edge residual (mm) | check (ms) |\n|---|---|---|---|---|---|---|---|---|",
    ];
    for (const [w, h] of [
      [1280, 720],
      [1920, 1080],
    ] as const) {
      const K = intr(w, h);
      for (const outline of ["spec 23 mm ring", "none"] as const)
        for (const s of [1, 0.97, 0.94])
          for (const e of [90, 75, 60, 45]) {
            const pose = orbitPose({ x: HAND_CENTRE.x * s, y: HAND_CENTRE.y * s, z: 0 }, 350, e, 250);
            const img = renderBoardView(K, pose, {
              ...STANDARD,
              printScale: s,
              occluders: handOccluders(),
              coin: { diameterMm: 23, thicknessMm: 1.5 },
              coinOutlineDiameterMm: outline === "none" ? 0 : undefined,
              seed: 300 + e + w,
            });
            const p = estimateBoardPose(K, detectMarkers(img).markers);
            if (!p.ok) {
              lines.push(`| ${w} x ${h} | ${outline} | ${s} | ${e} | pose failed | | | | |`);
              continue;
            }
            const t0 = performance.now();
            const r = checkCoinScale(img, K, p.pose, { referenceDiameterMm: 23, coinThicknessMm: 1.5 });
            const ms = performance.now() - t0;
            const plain = checkCoinScale(img, K, p.pose, { referenceDiameterMm: 23 });
            lines.push(
              r.ok
                ? `| ${w} x ${h} | ${outline} | ${s} | ${e} | ${r.printScale.toFixed(4)} | ${f(100 * (r.printScale / s - 1))} | ${plain.ok ? f(100 * (plain.printScale / s - 1)) : plain.reason} | ${f(r.residualMm, 3)} | ${f(ms, 0)} |`
                : `| ${w} x ${h} | ${outline} | ${s} | ${e} | refused: ${r.reason} | | | | |`,
            );
          }
    }
    out.push(lines.join("\n"));
    console.log(lines.join("\n"));
  }, 3_600_000);

  it("timings in Node", () => {
    const lines = ["SIMULATED images; timings in Node on this machine, single thread (median of 8 views at 45 deg, 350 mm, standard imaging).", "| step | 1280 x 720 | 1920 x 1080 |\n|---|---|---|"];
    const res: Record<string, string[]> = { render: [], "detect (full res)": [], "detect (decimate 2)": [], "pose": [] };
    for (const [w, h] of [
      [1280, 720],
      [1920, 1080],
    ] as const) {
      const K = intr(w, h);
      const tr: number[] = [], td: number[] = [], tdd: number[] = [], tp: number[] = [];
      for (const a of AZIMUTHS) {
        const pose = orbitPose(HAND_CENTRE, 350, 45, a);
        let t0 = performance.now();
        const img = renderBoardView(K, pose, { ...STANDARD, seed: a });
        tr.push(performance.now() - t0);
        t0 = performance.now();
        const det = detectMarkers(img);
        td.push(performance.now() - t0);
        t0 = performance.now();
        detectMarkers(img, { decimate: 2 });
        tdd.push(performance.now() - t0);
        t0 = performance.now();
        estimateBoardPose(K, det.markers);
        tp.push(performance.now() - t0);
      }
      res.render.push(`${f(med(tr), 0)} ms`);
      res["detect (full res)"].push(`${f(med(td), 0)} ms`);
      res["detect (decimate 2)"].push(`${f(med(tdd), 0)} ms`);
      res.pose.push(`${f(med(tp), 1)} ms`);
    }
    for (const [k, v] of Object.entries(res)) lines.push(`| ${k} | ${v[0]} | ${v[1]} |`);
    out.push(lines.join("\n"));
    console.log(lines.join("\n"));
  }, 600_000);

  it("prints every table", () => {
    console.log("\n\n===== BOARD SWEEP (SIMULATED) =====\n\n" + out.join("\n\n"));
    expect(out.length).toBeGreaterThan(0);
  });
});
