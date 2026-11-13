// The "Particle Environment" of the capture screen: glowing blue particles float over the whole picture, swarm onto the
// skin once a hand is tracked ("Swarm to Skin") and thicken as the real coverage of the view grows ("Progressive
// Coverage"). A visual effect drawn on a 2D canvas from the tracked landmarks; it is not a scan and not a measurement.
// It reuses the 3D layer's speed guard (hand3d/perfGuard.ts): a slow phone loses particles, then frame rate, and
// finally the layer itself; the scan underneath is never affected. prefers-reduced-motion: no drifting, no flight.
import { useEffect, useRef, type MutableRefObject } from "react";
import type { Landmark } from "../hand3d/handModel";
import { PerfGuard } from "../hand3d/perfGuard";
import { particleCount, skinSamples, skinTable, swarmShare, videoToCanvas } from "./swarm";

// Many small points, so the hand reads as a dense swarm. A prime sample count keeps `(i * 7) % SKIN_SAMPLES` distinct.
const MAX_PARTICLES = 1100;
const SKIN_SAMPLES = 1399;

export interface ParticleFieldProps {
  /** The tracked hand in video pixels (smoothed), or null; read every frame, no re-render. */
  poseRef: MutableRefObject<readonly Landmark[] | null>;
  /** The video frame's size in pixels. */
  frameRef: MutableRefObject<{ width: number; height: number } | null>;
  /** The real coverage of the current view, 0..100. */
  coverageRef: MutableRefObject<number>;
  mirror: boolean;
  /** The speed guard gave up on the layer: tell the screen once. */
  onDegrade?: () => void;
  className?: string;
}

interface Particle {
  x: number;
  y: number;
  /** Drift phase and speed. */
  ph: number;
  sp: number;
  size: number;
  /** 0 floating, 1 on the skin (eased). */
  a: number;
  /** Which skin sample it takes and its rank among the particles (the lowest ranks swarm first). */
  skin: number;
  rank: number;
  tw: number;
  /** Drawn size and opacity this frame. */
  s: number;
  al: number;
}

let sprite: HTMLCanvasElement | null = null;
function glowSprite(): HTMLCanvasElement {
  if (sprite) return sprite;
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  if (g) {
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, "rgba(220,240,255,1)");
    grad.addColorStop(0.25, "rgba(140,200,255,0.75)");
    grad.addColorStop(1, "rgba(60,130,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
  }
  sprite = c;
  return c;
}

/** The points on the skin: a white core, a saturated blue body and a deep-blue edge, drawn normally (not added to the
 *  picture) so they stay visible on a bright wall as well as a dark one. */
let skinSprite: HTMLCanvasElement | null = null;
function skinDot(): HTMLCanvasElement {
  if (skinSprite) return skinSprite;
  const c = document.createElement("canvas");
  c.width = c.height = 48;
  const g = c.getContext("2d");
  if (g) {
    const grad = g.createRadialGradient(24, 24, 0, 24, 24, 24);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.2, "rgba(232,246,255,1)");
    grad.addColorStop(0.42, "rgba(80,170,255,0.96)");
    grad.addColorStop(0.7, "rgba(24,96,238,0.55)");
    grad.addColorStop(1, "rgba(16,64,220,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 48, 48);
  }
  skinSprite = c;
  return c;
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

export function ParticleField({ poseRef, frameRef, coverageRef, mirror, onDegrade, className }: ParticleFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mirrorRef = useRef(mirror);
  mirrorRef.current = mirror;
  const degradeRef = useRef(onDegrade);
  degradeRef.current = onDegrade;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const still = reducedMotion();
    const guard = new PerfGuard({ maxFrameMs: 7, minFps: 20 });
    const table = skinTable(SKIN_SAMPLES);
    const samples = new Float32Array(SKIN_SAMPLES * 2);
    const sprite = glowSprite();
    const dot = skinDot();
    const floatIdx = new Int32Array(MAX_PARTICLES);
    const skinIdx = new Int32Array(MAX_PARTICLES);
    let w = 0;
    let h = 0;
    const rnd = (() => {
      let s = 12345;
      return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    })();
    const parts: Particle[] = Array.from({ length: MAX_PARTICLES }, (_, i) => ({
      x: 0,
      y: 0,
      ph: rnd() * Math.PI * 2,
      sp: 0.25 + rnd() * 0.6,
      size: 0.7 + rnd() * 1.9,
      a: 0,
      skin: Math.floor(rnd() * SKIN_SAMPLES),
      rank: i / MAX_PARTICLES,
      tw: rnd() * Math.PI * 2,
      s: 0,
      al: 0,
    }));
    // the rank order is shuffled so the swarm fills the hand evenly, not part by part
    for (let i = parts.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [parts[i].rank, parts[j].rank] = [parts[j].rank, parts[i].rank];
    }
    for (let i = 0; i < parts.length; i++) parts[i].skin = (i * 7) % SKIN_SAMPLES; // distinct skin points

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
      if (first) for (const p of parts) ((p.x = rnd() * w), (p.y = rnd() * h));
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
      // 60 frames a second while the guard is content, then the guard's own 30 and 20.
      const fps = still ? 8 : plan.level <= 2 ? 60 : plan.fps;
      if (now - lastDraw < 1000 / fps - 3) return;
      const t0 = performance.now();
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
      last = now;
      lastDraw = now;
      resize();

      const pose = poseRef.current;
      const fr = frameRef.current;
      const hand = pose && fr && pose.length >= 21 ? pose : null;
      if (hand) lastSeen = now;
      const present = hand !== null || now - lastSeen < 450;
      handAlpha += ((present ? 1 : 0) - handAlpha) * (still ? 1 : 1 - Math.exp(-5 * dt));
      if (hand && fr) skinSamples(hand, table, samples);
      const share = swarmShare(coverageRef.current);
      const n = particleCount(MAX_PARTICLES, plan.pointFraction);
      const mir = mirrorRef.current;
      const k = still ? 1 : 1 - Math.exp(-7 * dt);
      ctx.clearRect(0, 0, w, h);
      const sec = now / 1000;
      let nf = 0;
      let ns = 0;
      for (let i = 0; i < n; i++) {
        const p = parts[i];
        const swarm = hand !== null && fr !== null && p.rank < share;
        p.a += ((swarm ? 1 : 0) - p.a) * (still ? 1 : 1 - Math.exp(-3.5 * dt));
        if (swarm && fr) {
          const m = videoToCanvas({ x: samples[2 * p.skin], y: samples[2 * p.skin + 1] }, { width: fr.width, height: fr.height }, { width: w, height: h }, mir);
          const jit = still ? 0 : 1.2;
          const tx = m.x + Math.sin(sec * 2 + p.ph) * jit;
          const ty = m.y + Math.cos(sec * 2.3 + p.ph) * jit;
          p.x += (tx - p.x) * k;
          p.y += (ty - p.y) * k;
        } else if (!still) {
          // free drift: a slow flow field, wrapped at the edges
          p.x += Math.cos(sec * 0.2 * p.sp + p.ph) * 14 * p.sp * dt + 6 * p.sp * dt;
          p.y += Math.sin(sec * 0.17 * p.sp + p.ph * 1.7) * 14 * p.sp * dt - 5 * p.sp * dt;
          if (p.x > w + 4) p.x = -4;
          else if (p.x < -4) p.x = w + 4;
          if (p.y > h + 4) p.y = -4;
          else if (p.y < -4) p.y = h + 4;
        }
        const twinkle = plan.sweep && !still ? 0.8 + 0.2 * Math.sin(sec * 2.2 + p.tw) : 0.92;
        const onSkin = p.a * handAlpha;
        if (onSkin > 0.35) {
          p.s = (0.8 + p.size * 0.6 + 1.4 * onSkin) * 2.5;
          p.al = Math.min(1, (0.5 + 0.5 * onSkin) * twinkle + 0.08);
          skinIdx[ns++] = i;
        } else {
          p.s = (p.size + 2.2 * onSkin) * 2.4;
          p.al = Math.min(1, (0.34 + 0.66 * onSkin) * twinkle);
          floatIdx[nf++] = i;
        }
      }
      // the floating glow is added to the picture; the points on the skin are drawn over it, in solid colour
      ctx.globalCompositeOperation = "lighter";
      for (let j = 0; j < nf; j++) {
        const p = parts[floatIdx[j]];
        ctx.globalAlpha = p.al;
        ctx.drawImage(sprite, p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
      }
      ctx.globalCompositeOperation = "source-over";
      for (let j = 0; j < ns; j++) {
        const p = parts[skinIdx[j]];
        ctx.globalAlpha = p.al;
        ctx.drawImage(dot, p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
      }
      ctx.globalAlpha = 1;
      guard.frame(performance.now() - t0);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [poseRef, frameRef, coverageRef]);

  return <canvas ref={canvasRef} className={`mm-particles ${className ?? ""}`} aria-hidden="true" />;
}
