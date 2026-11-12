// The flowing blue particle wave of the start screen: strands of glowing points riding a slow wave. Decoration only.
// Same speed guard as the capture screen's particles (it thins out, then slows down, then stops on a slow phone) and
// no movement under prefers-reduced-motion (one still frame).
import { useEffect, useRef } from "react";
import { PerfGuard } from "../hand3d/perfGuard";

const STRANDS = 15;
const COLS = 64;

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** The point of a strand at a time: the wave's height at column `c` (0..1) of strand `s` (0..1). */
export function wavePoint(c: number, s: number, t: number, w: number, h: number): { x: number; y: number; glow: number } {
  const ph = c * Math.PI * 2.1 + t * 0.55 + s * 1.15;
  const crest = Math.sin(ph) * 0.5 + 0.5;
  const swell = 0.55 + 0.45 * Math.sin(c * Math.PI * 1.3 - t * 0.3 + 0.8);
  const y = h * (0.5 + 0.2 * Math.sin(c * Math.PI * 1.6 + t * 0.4)) + (s - 0.5) * h * 0.46 * swell + Math.sin(ph * 0.7) * h * 0.05;
  return { x: c * w, y, glow: 0.25 + 0.75 * Math.pow(crest, 2.2) * (0.6 + 0.4 * (1 - Math.abs(s - 0.5) * 2)) };
}

export function ParticleWave({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const still = reducedMotion();
    const guard = new PerfGuard({ maxFrameMs: 6, minFps: 20 });
    let w = 0;
    let h = 0;
    const size = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.max(1, Math.round(r.width));
      h = Math.max(1, Math.round(r.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { size(); draw(performance.now()); }) : null;
    ro?.observe(canvas);

    // a small, fixed set of per-point randoms so the points do not flicker as they move
    const jitter = Array.from({ length: STRANDS * COLS }, (_, i) => ({ r: (Math.sin(i * 12.9898) * 43758.5453) % 1, q: (Math.sin(i * 78.233) * 12345.678) % 1 }));
    const dot = (x: number, y: number, r: number, a: number) => {
      ctx.fillStyle = `rgba(${150 + 70 * a | 0},${200 + 40 * a | 0},255,${Math.min(1, a)})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    };
    function draw(now: number) {
      const t = still ? 2.2 : now / 1000;
      const plan = guard.plan;
      const strands = Math.max(5, Math.round(STRANDS * plan.pointFraction));
      ctx!.clearRect(0, 0, w, h);
      ctx!.globalCompositeOperation = "lighter";
      for (let si = 0; si < strands; si++) {
        const s = si / (strands - 1);
        for (let ci = 0; ci < COLS; ci++) {
          const c = ci / (COLS - 1);
          const p = wavePoint(c, s, t, w, h);
          const j = jitter[si * COLS + ci];
          const a = p.glow * (0.55 + 0.45 * Math.abs(j.q));
          dot(p.x + j.r * 2, p.y + j.q * 2, 0.5 + 1.5 * a * Math.abs(j.r + 0.5), a * 0.9);
        }
      }
      ctx!.globalCompositeOperation = "source-over";
    }

    if (still) {
      draw(0);
      return () => ro?.disconnect();
    }
    let raf = 0;
    let stopped = false;
    let lastDraw = 0;
    const loop = (now: number) => {
      if (stopped) return;
      raf = requestAnimationFrame(loop);
      if (document.hidden) return;
      const plan = guard.tick(now);
      if (plan.disabled) {
        stopped = true;
        draw(2.2 * 1000); // one still frame
        return;
      }
      const fps = plan.level <= 2 ? 60 : plan.fps;
      if (now - lastDraw < 1000 / fps - 3) return;
      lastDraw = now;
      const t0 = performance.now();
      draw(now);
      guard.frame(performance.now() - t0);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, []);

  return <canvas ref={ref} className={`mm-wave ${className ?? ""}`} aria-hidden="true" />;
}
