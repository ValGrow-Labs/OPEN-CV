// The "3D mesh" overlay of the capture screen: a dense, fine lattice of dots laid over the tracked hand (rows across each
// finger and the palm, a glowing cyan rim along the silhouette), thin contour lines (rings across the fingers, relief lines
// over the palm), a scan frame sized to the hand and a scan line that sits where the real coverage is. A VISUAL EFFECT drawn
// from the hand's 21 landmarks on a 2D canvas: the dots are not measured points and this is not a scan or a measurement.
// How the lattice is laid out (fixed coordinates on each finger and on the palm, so the dots keep their place from frame
// to frame) is in swarm.ts. It reuses the 3D layer's speed guard (hand3d/perfGuard.ts): a slow phone loses the shimmer, then
// the glow and contour lines, then half the dots and frame rate, and finally the layer itself; the scan underneath is never
// affected. prefers-reduced-motion: nothing drifts, shimmers or eases; the frame and the scan line simply sit where they are.
// The same layer draws the five live finger-length labels ("~72 mm") beside the fingertips from the numbers the scan already
// computes (fingerLabels.ts has the smoothing and the placement): they are rough live estimates, shown only while the coin is
// accepted, and are not drawn by the speed guard's last steps.
import { useEffect, useRef, type MutableRefObject } from "react";
import type { Landmark } from "../hand3d/handModel";
import { PerfGuard } from "../hand3d/perfGuard";
import { labelInputs, leaderEnd, LengthSmoother, placeLabels, type FingerLengths, type PlacedLabel, type Rect } from "./fingerLabels";
import {
  buildContours,
  clampBox,
  buildLattice,
  easeBox,
  fingerPoint,
  frameTarget,
  handGeom,
  HIDDEN,
  latticePoints,
  newHandGeom,
  palmPoint,
  scanLineFraction,
  swarmShare,
  videoToCanvas,
  visibleLimit,
  type Box,
} from "./swarm";

/** Floating specks over the whole picture (the "particle environment" before a hand is found). */
const AMBIENT = 80;

export interface ParticleFieldProps {
  /** The tracked hand in video pixels (smoothed), or null; read every frame, no re-render. */
  poseRef: MutableRefObject<readonly Landmark[] | null>;
  /** The video frame's size in pixels. */
  frameRef: MutableRefObject<{ width: number; height: number } | null>;
  /** The real coverage of the current view, 0..100. */
  coverageRef: MutableRefObject<number>;
  mirror: boolean;
  /** The full mesh (default) or a light version: a sparse set of dots and the scan frame only, so the hand shows plainly. */
  mesh?: boolean;
  /** The finger lengths the scan computes from the current frame (live estimates, only while the coin is accepted), and when
   *  they were taken: read every frame, no re-render. */
  lengthsRef?: MutableRefObject<{ mm: FingerLengths | null; at: number }>;
  /** The labels appeared / went away (so the screen can show or hide its "live estimate" note). */
  onLabels?: (shown: boolean) => void;
  /** The speed guard gave up on the layer: tell the screen once. */
  onDegrade?: () => void;
  /** The hand is lined up with the guide box: the scan frame turns green (a colour only, nothing else changes). */
  lined?: boolean;
  className?: string;
}

interface Speck {
  x: number;
  y: number;
  ph: number;
  sp: number;
  size: number;
}

/** A soft cyan glow (added to the picture). */
let glow: HTMLCanvasElement | null = null;
function glowSprite(): HTMLCanvasElement {
  if (glow) return glow;
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  if (g) {
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, "rgba(235,252,255,1)");
    grad.addColorStop(0.22, "rgba(120,228,255,0.8)");
    grad.addColorStop(0.55, "rgba(40,160,255,0.28)");
    grad.addColorStop(1, "rgba(30,120,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
  }
  glow = c;
  return c;
}

/** One dot of the lattice: a white core, a cyan body and a soft blue edge. */
let dotImgCache: HTMLCanvasElement | null = null;
function dotSprite(): HTMLCanvasElement {
  if (dotImgCache) return dotImgCache;
  const c = document.createElement("canvas");
  c.width = c.height = 24;
  const g = c.getContext("2d");
  if (g) {
    const grad = g.createRadialGradient(12, 12, 0, 12, 12, 12);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.2, "rgba(228,254,255,1)");
    grad.addColorStop(0.4, "rgba(120,228,255,0.96)");
    grad.addColorStop(0.64, "rgba(30,120,232,0.6)");
    grad.addColorStop(0.86, "rgba(10,56,150,0.24)");
    grad.addColorStop(1, "rgba(10,56,150,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 24, 24);
  }
  dotImgCache = c;
  return c;
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** A rounded rectangle path (no ctx.roundRect: older phones do not have it). */
function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

const BUCKETS = 4;

/** A colour channel between `a` and `b` (t 0..1), as a whole number. */
const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

const LABEL_FONT = '600 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export function ParticleField({ poseRef, frameRef, coverageRef, lengthsRef, onLabels, mirror, mesh = true, onDegrade, lined = false, className }: ParticleFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mirrorRef = useRef(mirror);
  mirrorRef.current = mirror;
  const meshRef = useRef(mesh);
  meshRef.current = mesh;
  const linedRef = useRef(lined);
  linedRef.current = lined;
  const degradeRef = useRef(onDegrade);
  degradeRef.current = onDegrade;
  const labelsRef = useRef(onLabels);
  labelsRef.current = onLabels;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const still = reducedMotion();
    const guard = new PerfGuard({ maxFrameMs: 8, minFps: 20 });
    const lat = buildLattice();
    const contours = buildContours();
    const geom = newHandGeom();
    const pts = new Float32Array(lat.count * 2);
    const rimEff = new Float32Array(lat.count); // each dot's rim weight this frame (a patch dot's depends on where it lands)
    const lmc = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
    const smoother = new LengthSmoother();
    let lastLengthsAt = -1;
    let labelA = 0;
    let labelsShown = false;
    let labelCount = 0;
    let labelText = "";
    let reserved: Rect[] = [];
    let reservedAt = -1e9;
    const buf = new Float32Array(2);
    const glowImg = glowSprite();
    const dotImg = dotSprite();
    // the dots, sorted into a few brightness steps each frame (one fillStyle per step, not per dot)
    const bucket = Array.from({ length: BUCKETS }, () => new Int32Array(lat.count));
    const bucketN = new Int32Array(BUCKETS);
    const rimList = new Int32Array(lat.count);
    const vid = { width: 1, height: 1 };
    const cv = { width: 1, height: 1 };
    let w = 0;
    let h = 0;
    const rnd = (() => {
      let s = 12345;
      return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    })();
    const specks: Speck[] = Array.from({ length: AMBIENT }, () => ({ x: 0, y: 0, ph: rnd() * Math.PI * 2, sp: 0.25 + rnd() * 0.6, size: 1.2 + rnd() * 2.4 }));

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const nw = Math.max(1, Math.round(r.width));
      const nh = Math.max(1, Math.round(r.height));
      if (nw === w && nh === h) return;
      const first = w === 0;
      w = nw;
      h = nh;
      canvas.width = Math.round(nw * dpr);
      canvas.height = Math.round(nh * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (first) for (const p of specks) ((p.x = rnd() * w), (p.y = rnd() * h));
    };
    resize();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    ro?.observe(canvas);

    let raf = 0;
    let last = 0;
    let lastDraw = 0;
    let handAlpha = 0;
    let lastSeen = 0;
    let stopped = false;
    let haveHand = false;
    let box: Box | null = null;
    let scanF = 0.06;
    let shareS = 0.6;
    let meshS = 1; // 1 full mesh .. 0 light version, eased
    let greenS = 0; // 0 cyan scan frame .. 1 green (lined up with the guide box), eased
    let drawn = 0;
    let visibleDots = 0;

    const frame = (now: number) => {
      if (stopped) return;
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const plan = guard.tick(now);
      if (plan.disabled) {
        ctx.clearRect(0, 0, w, h);
        stopped = true;
        degradeRef.current?.();
        return;
      }
      // 30 frames a second is plenty for a lattice of dots and leaves the main thread to the hand tracker; the guard takes it
      // to 20 on a slow phone.
      const fps = still ? 8 : Math.min(30, plan.fps);
      if (now - lastDraw < 1000 / fps - 3) return;
      const t0 = performance.now();
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
      last = now;
      lastDraw = now;
      resize();
      const ease = (rate: number) => (still ? 1 : 1 - Math.exp(-rate * dt));

      const pose = poseRef.current;
      const fr = frameRef.current;
      const hand = pose && fr && pose.length >= 21 ? pose : null;
      if (hand) lastSeen = now;
      const present = hand !== null || now - lastSeen < 450;
      handAlpha += ((present ? 1 : 0) - handAlpha) * ease(5);
      meshS += ((meshRef.current ? 1 : 0) - meshS) * ease(8);
      greenS += ((linedRef.current ? 1 : 0) - greenS) * ease(10);
      const full = meshS > 0.5;

      if (hand && fr) {
        vid.width = fr.width;
        vid.height = fr.height;
        cv.width = w;
        cv.height = h;
        const mir = mirrorRef.current;
        for (let i = 0; i < 21; i++) {
          const m = videoToCanvas(hand[i], vid, cv, mir);
          lmc[i].x = m.x;
          lmc[i].y = m.y;
        }
        handGeom(lmc, geom);
        latticePoints(lmc, geom, lat, pts, rimEff);
        const target = frameTarget(lmc);
        box = box ? easeBox(box, target, still ? 1 : dt) : target;
        scanF += (scanLineFraction(coverageRef.current) - scanF) * ease(4);
        haveHand = true;
      }
      shareS += ((full ? swarmShare(coverageRef.current) : 0.14) - shareS) * ease(3);

      ctx.clearRect(0, 0, w, h);
      const sec = now / 1000;

      // 1. floating specks over the whole picture (fainter once a hand is there)
      {
        const nAmb = Math.max(12, Math.round(AMBIENT * (plan.pointFraction || 1)));
        ctx.globalCompositeOperation = "lighter";
        for (let i = 0; i < nAmb; i++) {
          const p = specks[i];
          if (!still) {
            p.x += Math.cos(sec * 0.2 * p.sp + p.ph) * 14 * p.sp * dt + 6 * p.sp * dt;
            p.y += Math.sin(sec * 0.17 * p.sp + p.ph * 1.7) * 14 * p.sp * dt - 5 * p.sp * dt;
            if (p.x > w + 4) p.x = -4;
            else if (p.x < -4) p.x = w + 4;
            if (p.y > h + 4) p.y = -4;
            else if (p.y < -4) p.y = h + 4;
          }
          ctx.globalAlpha = (0.34 - 0.18 * handAlpha) * (0.7 + 0.3 * Math.sin(sec * 1.3 + p.ph));
          const s = p.size * 2.6;
          ctx.drawImage(glowImg, p.x - s / 2, p.y - s / 2, s, s);
        }
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1; // the specks set their own alpha: everything after them is drawn at full strength
      }

      if (haveHand && box && handAlpha > 0.02) {
        const ha = handAlpha;
        const fb = clampBox(box, w, h);
        const ds = Math.max(0.8, Math.min(1.5, geom.len / 280)); // dots grow a little with a close hand

        // 2. the scan frame: a thin light border, a faint glass fill, inner corner brackets
        const bw = fb.x1 - fb.x0;
        const bh = fb.y1 - fb.y0;
        roundedRect(ctx, fb.x0, fb.y0, bw, bh, 16);
        ctx.fillStyle = `rgba(120,205,255,${0.07 * ha})`;
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = `rgba(4,48,110,${0.3 * ha})`;
        ctx.stroke();
        ctx.lineWidth = 1.3;
        ctx.strokeStyle = `rgba(${mix(140, 61, greenS)},${mix(228, 220, greenS)},${mix(255, 151, greenS)},${0.98 * ha})`;
        ctx.stroke();
        {
          const inset = 7;
          const L = Math.min(18, bw / 4, bh / 4);
          const x0 = fb.x0 + inset;
          const y0 = fb.y0 + inset;
          const x1 = fb.x1 - inset;
          const y1 = fb.y1 - inset;
          ctx.beginPath();
          ctx.moveTo(x0, y0 + L);
          ctx.lineTo(x0, y0);
          ctx.lineTo(x0 + L, y0);
          ctx.moveTo(x1 - L, y0);
          ctx.lineTo(x1, y0);
          ctx.lineTo(x1, y0 + L);
          ctx.moveTo(x1, y1 - L);
          ctx.lineTo(x1, y1);
          ctx.lineTo(x1 - L, y1);
          ctx.moveTo(x0 + L, y1);
          ctx.lineTo(x0, y1);
          ctx.lineTo(x0, y1 - L);
          ctx.lineCap = "round";
          ctx.lineWidth = 4;
          ctx.strokeStyle = `rgba(4,48,110,${0.45 * ha})`;
          ctx.stroke();
          ctx.lineWidth = 2.2;
          ctx.strokeStyle = `rgba(${mix(215, 150, greenS)},${mix(250, 255, greenS)},${mix(255, 205, greenS)},${0.99 * ha})`;
          ctx.stroke();
        }

        // 3. the dots: which ones are shown follows the real coverage and the speed guard (always a subset of the same set)
        const cut = visibleLimit(lat, shareS, plan.pointFraction) / lat.count;
        bucketN.fill(0);
        visibleDots = 0;
        let nRim = 0;
        const shimmer = plan.sweep && !still;
        for (let i = 0; i < lat.count; i++) {
          if (lat.rank[i] >= cut || pts[2 * i] <= HIDDEN / 2) continue; // not shown (speed guard) / a patch dot this hand does not need
          const rim = rimEff[i];
          let a = 0.4 + 0.6 * rim;
          if (shimmer) a *= 0.88 + 0.12 * Math.sin(sec * 2.1 + lat.phase[i]);
          const b = Math.min(BUCKETS - 1, Math.floor(a * BUCKETS));
          bucket[b][bucketN[b]++] = i;
          visibleDots++;
          if (rim > 0.4) rimList[nRim++] = i;
        }
        // the dots: round and very fine (their size follows the hand's size, so the density looks the same near and far),
        // brighter towards the silhouette and dimmer in the middle so the skin shows through; the sprite's soft blue edge
        // keeps them visible on pale skin and a bright wall as well as on a dark one
        const dotSize = Math.max(2.4, Math.min(5, geom.len * 0.0085));
        for (let b = 0; b < BUCKETS; b++) {
          ctx.globalAlpha = (0.35 + 0.65 * ((b + 1) / BUCKETS)) * ha;
          for (let j = 0; j < bucketN[b]; j++) {
            const i = bucket[b][j];
            ctx.drawImage(dotImg, pts[2 * i] - dotSize / 2, pts[2 * i + 1] - dotSize / 2, dotSize, dotSize);
          }
        }
        ctx.globalAlpha = 1;
        // the rim light: a cyan glow on the dots along the silhouette
        if (full && plan.wire) {
          ctx.globalCompositeOperation = "lighter";
          for (let j = 0; j < nRim; j++) {
            const i = rimList[j];
            const rim = rimEff[i];
            ctx.globalAlpha = Math.min(1, 0.42 * rim * ha);
            const s = (4.5 + 5 * rim) * ds;
            ctx.drawImage(glowImg, pts[2 * i] - s / 2, pts[2 * i + 1] - s / 2, s, s);
          }
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = "source-over";
        }

        // 4. contour lines: a ring across every finger, relief lines over the palm
        if (full && plan.wire) {
          ctx.beginPath();
          for (const arc of contours.fingerArcs) {
            for (let k = 0; k < arc.vs.length; k++) {
              const v = arc.vs[k];
              fingerPoint(lmc, geom, arc.finger, arc.u + 0.03 * (1 - v * v), v, buf, 0);
              if (k === 0) ctx.moveTo(buf[0], buf[1]);
              else ctx.lineTo(buf[0], buf[1]);
            }
          }
          for (const line of contours.palm) {
            for (let k = 0; k < line.length; k += 2) {
              palmPoint(geom, line[k], line[k + 1], buf, 0);
              if (k === 0) ctx.moveTo(buf[0], buf[1]);
              else ctx.lineTo(buf[0], buf[1]);
            }
          }
          ctx.lineJoin = "round";
          ctx.lineCap = "round";
          ctx.lineWidth = 3.4;
          ctx.strokeStyle = `rgba(90,200,255,${0.14 * ha})`;
          ctx.stroke();
          ctx.lineWidth = 0.9;
          ctx.strokeStyle = `rgba(190,246,255,${0.5 * ha})`;
          ctx.stroke();
        }

        // 5. the scan line: a thin, slightly elliptical line across the hand at the real coverage
        if (full) {
          const cy = fb.y1 - (fb.y1 - fb.y0) * scanF;
          const rx = Math.max(10, bw / 2 - 6);
          const ry = Math.max(4, bw * 0.045);
          const cx = (fb.x0 + fb.x1) / 2;
          ctx.save();
          roundedRect(ctx, fb.x0, fb.y0, bw, bh, 16);
          ctx.clip();
          ctx.beginPath();
          ctx.ellipse(cx, cy, rx, ry * 2.4, 0, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(150,225,255,${0.1 * ha})`;
          ctx.fill();
          ctx.beginPath();
          ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
          ctx.lineWidth = 3.4;
          ctx.strokeStyle = `rgba(80,190,255,${0.2 * ha})`;
          ctx.stroke();
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = `rgba(214,248,255,${0.9 * ha})`;
          ctx.stroke();
          ctx.restore();
        }
        ctx.globalAlpha = 1;
      }

      // 6. the live finger labels: "~72 mm" beside each fingertip, from the numbers the scan computes (smoothed over the last few
      // frames), while the coin is accepted. Drawn in the full and the light view alike; the speed guard's last steps drop them.
      {
        const lr = lengthsRef?.current;
        if (lr && lr.at !== lastLengthsAt) {
          lastLengthsAt = lr.at;
          smoother.push(lr.mm, now);
        }
        const vals = hand && plan.level <= 3 ? smoother.read(now) : null;
        labelA += ((vals ? 1 : 0) - labelA) * ease(8);
        const nowShown = labelA > 0.5;
        if (nowShown !== labelsShown) {
          labelsShown = nowShown;
          labelsRef.current?.(nowShown);
        }
        labelCount = 0;
        labelText = "";
        if (vals && labelA > 0.02 && haveHand) {
          // the buttons and the guidance pill on the picture are kept clear (looked up a couple of times a second)
          if (now - reservedAt > 400) {
            reservedAt = now;
            const cr = canvas.getBoundingClientRect();
            reserved = Array.from(canvas.parentElement?.querySelectorAll(".mm-cam-switch, .mm-pill") ?? []).map((el) => {
              const r = el.getBoundingClientRect();
              return { x0: r.left - cr.left - 6, y0: r.top - cr.top - 6, x1: r.right - cr.left + 6, y1: r.bottom - cr.top + 6 };
            });
          }
          ctx.font = LABEL_FONT;
          const inputs = labelInputs(lmc, vals, (t) => ctx.measureText(t).width);
          const placed: PlacedLabel[] = placeLabels(inputs, { x0: 8, y0: 34, x1: w - 8, y1: h - 8 }, { reserved });
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.lineCap = "round";
          for (const l of placed) {
            if (!l.visible) continue;
            labelCount++;
            labelText += (labelText ? " " : "") + l.finger + ":" + l.text;
            const a = labelA * handAlpha;
            const end = leaderEnd(l);
            // a thin leader from the fingertip to its label, and a small bright point on the fingertip
            ctx.beginPath();
            ctx.moveTo(l.tip.x, l.tip.y);
            ctx.lineTo(end.x, end.y);
            ctx.lineWidth = 1;
            ctx.strokeStyle = `rgba(200,244,255,${0.7 * a})`;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(l.tip.x, l.tip.y, 2.2, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(235,252,255,${0.95 * a})`;
            ctx.fill();
            // the label: a dark glass pill with a light edge, white text (readable on a bright wall and a dark one alike)
            roundedRect(ctx, l.x, l.y, l.w, l.h, l.h / 2);
            ctx.fillStyle = `rgba(6,18,40,${0.78 * a})`;
            ctx.fill();
            ctx.lineWidth = 1;
            ctx.strokeStyle = `rgba(160,228,255,${0.85 * a})`;
            ctx.stroke();
            ctx.fillStyle = `rgba(244,252,255,${a})`;
            ctx.fillText(l.text, l.x + l.w / 2, l.y + l.h / 2 + 0.5);
          }
          ctx.globalAlpha = 1;
        }
      }
      const cost = performance.now() - t0;
      guard.frame(cost);
      // read-only numbers for diagnostics and the tests: what this layer costs per frame, and how many dots it draws
      if (++drawn % 15 === 0) (window as unknown as { __MESH_STATS__?: unknown }).__MESH_STATS__ = { level: plan.level, costMs: Math.round(guard.costMs * 100) / 100, lastMs: Math.round(cost * 100) / 100, dots: visibleDots, labels: labelCount, labelText, fps: Math.round(guard.intervalMs > 0 ? 1000 / guard.intervalMs : 0) };
    };
    raf = requestAnimationFrame(frame);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      // the layer goes away (a new view, the speed guard): so do its labels, and the screen's note about them
      if (labelsShown) labelsRef.current?.(false);
    };
  }, [poseRef, frameRef, coverageRef, lengthsRef]);

  return <canvas ref={canvasRef} className={`mm-particles ${className ?? ""}`} aria-hidden="true" />;
}
