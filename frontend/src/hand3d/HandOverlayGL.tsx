// The camera view as a 3D measuring display: a transparent layer over the live video that draws a luminous
// 3D hand exactly where the real hand is, with measuring rails along the fingers, a hand-length rail beside
// the hand and a scanning sweep. Loaded lazily with the rest of the scene (HandStage.tsx).
//
// It runs on top of live hand tracking on phones, so the budget is tight: pixel ratio at most 1.25, 30 frames a
// second, a few thousand points, and nothing allocated per frame in the pose loop.
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
  OrthographicCamera,
  Points,
  Scene,
  ShaderMaterial,
  WebGLRenderer,
} from "three";
import { useEffect, useRef, useState } from "react";
import type { HandStageProps } from "./HandStage";
import { genericHand, handWire, poseSamples, sampleHand, type Landmark, type SampledHand, type Vec3 } from "./handModel";
import {
  BEAD_COUNT,
  FINGER_RAIL_VERTS,
  HAND_RAIL_VERTS,
  beadGlow,
  containRect,
  fillRails,
  hasDepth,
  mapToElement,
  normalizeInto,
  poseBounds,
  railSide,
  triangle,
  type Bounds,
  type HandFrame,
  type RailInfo,
} from "./overlayMath";
import { DEFAULT_BUDGET, PerfGuard, type Budget, type Plan } from "./perfGuard";

const BLUE = new Color("#2b8cff");
const CYAN = new Color("#19e6e6");
const RAIL = new Color("#19e6e6");
const PALE = new Color("#d4fbff");
const WIRE = new Color("#1fb4ff");
const NAVY = new Color("#031a33"); // the dark edge that keeps the layer readable on a bright picture
const FPS = 30;
const SWEEP_S = 1.6;
const Z_GAIN = 1.35; // the relief is exaggerated a little so a tilted hand reads as 3D
const COUNT_PHONE = 3000;
const COUNT_LARGE = 5000;

const VERT = /* glsl */ `
  attribute float aGlow;
  attribute float aSeed;
  uniform float uTime;
  uniform float uPx;
  uniform float uBeam;
  uniform float uTwinkle;
  varying float vGlow;
  varying float vBeam;
  varying float vTw;
  varying float vNear;
  void main() {
    float s = aSeed * 6.2831;
    float d = position.y - uBeam;
    vBeam = exp(-d * d * 260.0);
    vTw = mix(1.0, 0.7 + 0.3 * sin(uTime * 2.4 + s * 5.0), uTwinkle);
    vGlow = aGlow;
    vNear = clamp(position.z / 0.3, -1.0, 1.0);
    gl_PointSize = uPx * (0.7 + aGlow * 1.1 + vBeam * 1.0) * (1.0 + 0.35 * vNear);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uBlue;
  uniform vec3 uCyan;
  uniform float uAlpha;
  uniform float uFade;
  varying float vGlow;
  varying float vBeam;
  varying float vTw;
  varying float vNear;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r = length(c) * 2.0;
    if (r > 1.0) discard;
    float g = clamp(vGlow * vTw + vBeam * 0.7, 0.0, 1.3);
    vec3 col = mix(uBlue, uCyan, smoothstep(0.05, 0.6, g));
    col = mix(col, vec3(0.86, 1.0, 1.0), smoothstep(0.7, 1.2, g) * 0.85);
    // a dark rim round each point: blue and cyan alone vanish on a white table or a bright window
    col = mix(col, vec3(0.012, 0.1, 0.2), smoothstep(0.45, 0.95, r) * 0.8);
    float soft = 1.0 - smoothstep(0.7, 1.0, r);
    float alpha = soft * clamp(0.4 + 0.6 * g, 0.0, 1.0) * (0.8 + 0.25 * vNear) * uAlpha * uFade;
    // normal (premultiplied) blending, not additive: additive glow disappears on a bright background
    gl_FragColor = vec4(col * alpha, alpha);
  }
`;

function pointMaterial(alpha: number): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    premultipliedAlpha: true,
    uniforms: {
      uTime: { value: 0 },
      uPx: { value: 2.4 },
      uBeam: { value: -9 },
      uTwinkle: { value: 1 },
      uBlue: { value: BLUE },
      uCyan: { value: CYAN },
      uAlpha: { value: alpha },
      uFade: { value: 0 },
    },
  });
}

function lineMaterial(color: Color, opacity: number): LineBasicMaterial {
  return new LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Finite landmarks, checked without allocating. */
function validLandmarks(points: readonly Landmark[] | null | undefined): points is readonly Landmark[] {
  if (!points || points.length < 21) return false;
  for (let i = 0; i < 21; i++) {
    const p = points[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  }
  return true;
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Set by a test page to read the cost of a frame; never set in the app. */
interface FrameStats {
  frames: number;
  poseMs: number;
  frameMs: number;
}

export default function HandOverlayGL(props: HandStageProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const tagEls = useRef<(HTMLSpanElement | null)[]>([]);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let degraded = false;
    // Switched off (no WebGL, the scene could not start, the context was lost, or it was too heavy for this
    // phone): render nothing and tell the screen, which goes back to its 2D drawing.
    const disable = () => {
      if (degraded) return;
      degraded = true;
      setFailed(true);
      propsRef.current.onDegrade?.("disabled");
    };

    const build = (): (() => void) => {
    const phone = typeof matchMedia === "function" && matchMedia("(max-width: 640px), (pointer: coarse)").matches;
    const lowEnd = (navigator.hardwareConcurrency ?? 8) <= 4;
    const count = phone || lowEnd ? COUNT_PHONE : COUNT_LARGE;
    const reduce = reducedMotion();
    const stats = (globalThis as { __HAND3D_STATS__?: FrameStats }).__HAND3D_STATS__;

    const renderer = new WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" });
    try {
    const dpr = Math.min(window.devicePixelRatio || 1, lowEnd ? 1 : 1.25);
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(dpr);
    const canvas = renderer.domElement;
    mount.appendChild(canvas);

    // Screen pixels, y down: the camera maps a point of the layer to the same pixel of the video behind it.
    const scene = new Scene();
    const camera = new OrthographicCamera(0, 1, 0, 1, 1, 3000);
    camera.position.z = 1500;

    const generic = genericHand();
    const sampled = sampleHand(generic, count, 7);
    // The points come out of the sampler in random order, so a prefix is a fair thinner sample of the hand.
    let active: SampledHand = sampled;
    const positions = new Float32Array(count * 3);
    const posAttr = new BufferAttribute(positions, 3);
    posAttr.setUsage(35048); // DynamicDrawUsage
    const rand = rng(11);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) seed[i] = rand();
    const handGeo = new BufferGeometry();
    handGeo.setAttribute("position", posAttr);
    handGeo.setAttribute("aGlow", new BufferAttribute(sampled.glow, 1));
    handGeo.setAttribute("aSeed", new BufferAttribute(seed, 1));
    const handMat = pointMaterial(0.8);
    const handPoints = new Points(handGeo, handMat);

    const wireArr = new Float32Array(handWire(generic));
    const wireAttr = new BufferAttribute(wireArr, 3);
    wireAttr.setUsage(35048);
    const wireGeo = new BufferGeometry();
    wireGeo.setAttribute("position", wireAttr);
    const wireMat = lineMaterial(WIRE, 0.62);
    const wire = new LineSegments(wireGeo, wireMat);

    const fingerArr = new Float32Array(FINGER_RAIL_VERTS * 3);
    const fingerAttr = new BufferAttribute(fingerArr, 3);
    fingerAttr.setUsage(35048);
    const fingerGeo = new BufferGeometry();
    fingerGeo.setAttribute("position", fingerAttr);
    const fingerMat = lineMaterial(RAIL, 0.95);
    const fingerRails = new LineSegments(fingerGeo, fingerMat);

    const handRailArr = new Float32Array(HAND_RAIL_VERTS * 3);
    const handRailAttr = new BufferAttribute(handRailArr, 3);
    handRailAttr.setUsage(35048);
    const handRailGeo = new BufferGeometry();
    handRailGeo.setAttribute("position", handRailAttr);
    const handRailMat = lineMaterial(PALE, 1);
    const handRail = new LineSegments(handRailGeo, handRailMat);

    const beadArr = new Float32Array(BEAD_COUNT * 3);
    const beadAttr = new BufferAttribute(beadArr, 3);
    beadAttr.setUsage(35048);
    const beadSeed = new Float32Array(BEAD_COUNT);
    for (let i = 0; i < BEAD_COUNT; i++) beadSeed[i] = rand();
    const beadGeo = new BufferGeometry();
    beadGeo.setAttribute("position", beadAttr);
    beadGeo.setAttribute("aGlow", new BufferAttribute(beadGlow(), 1));
    beadGeo.setAttribute("aSeed", new BufferAttribute(beadSeed, 1));
    const beadMat = pointMaterial(1.05);
    const beads = new Points(beadGeo, beadMat);

    const beamArr = new Float32Array(12);
    const beamAttr = new BufferAttribute(beamArr, 3);
    beamAttr.setUsage(35048);
    const beamGeo = new BufferGeometry();
    beamGeo.setAttribute("position", beamAttr);
    const beamMat = lineMaterial(PALE, 0.9);
    const beam = new LineSegments(beamGeo, beamMat);

    // The hand space (wrist at the origin, y up, wrist to middle fingertip = 1) is placed on the screen by this
    // one transform; y is flipped because the screen's y runs down.
    // Every line is drawn twice: a dark copy a hair down and to the side first (a drop shadow), so the lines
    // read on a bright picture as well as a dark one.
    const shadowMat = lineMaterial(NAVY, 0.5);
    const shadows = [wireGeo, fingerGeo, handRailGeo, beamGeo].map((g) => {
      const l = new LineSegments(g, shadowMat);
      l.position.set(0.007, -0.007, -0.02);
      return l;
    });
    const hand = new Group();
    for (const o of [...shadows, handPoints, wire, fingerRails, handRail, beads, beam]) {
      o.frustumCulled = false;
      hand.add(o);
    }
    hand.visible = false;
    scene.add(hand);

    // ---- state, all preallocated
    const tgt = new Float32Array(63); // the tracked hand on the screen (x, y, relief) per joint
    const cur = new Float32Array(63); // the eased one that is drawn
    const pose: Vec3[] = generic.map((p) => ({ ...p }));
    const hf: HandFrame = { x0: 0, y0: 0, len: 0 };
    const info: RailInfo = { mx: 0, my: 0, side: 1 };
    const bounds: Bounds = { minX: -0.5, maxX: 0.5, minY: 0, maxY: 1 };
    let havePose = false;
    let lastSeen = -1e9;
    let fade = 0;
    let useZ = false;
    let drawn = false; // something is on the canvas
    let frameNo = 0;
    let width = 0;
    let height = 0;
    let lastFrame = 0;
    const t0 = performance.now();
    const b = propsRef.current.budget;
    const budget: Budget = b && b.maxFrameMs > 0 && b.minFps > 0 ? b : DEFAULT_BUDGET;
    const guard = new PerfGuard(budget);
    let plan: Plan = guard.plan;
    // A step down of the guard: fewer points, no wireframe or twinkle, a lower frame rate, or off.
    const applyPlan = (next: Plan) => {
      plan = next;
      active = next.pointFraction >= 1 ? sampled : { ...sampled, count: Math.floor(count * next.pointFraction) };
      handGeo.setDrawRange(0, active.count);
      wire.visible = next.wire;
      shadows[0].visible = next.wire;
    };

    const resize = () => {
      const r = mount.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      if (w === width && h === height) return;
      width = w;
      height = h;
      renderer.setSize(w, h, false);
      camera.right = w;
      camera.bottom = h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    const frame = (now: number) => {
      const c0 = performance.now();
      const p = propsRef.current;
      const dt = Math.min(0.1, lastFrame ? (now - lastFrame) / 1000 : 1 / FPS);
      lastFrame = now;
      frameNo++;
      const t = reduce ? 1.2 : (now - t0) / 1000;

      const src = p.poseRef?.current;
      let valid = false;
      if (validLandmarks(src) && width > 0) {
        const fs = p.frameRef?.current;
        const fw = fs && fs.width > 0 ? fs.width : width;
        const fh = fs && fs.height > 0 ? fs.height : height;
        useZ = hasDepth(src);
        mapToElement(src, fw, containRect(width, height, fw, fh), !!p.mirror, useZ, tgt);
        if (!havePose || now - lastSeen > 300) {
          cur.set(tgt); // a hand that has just appeared is drawn where it is, not slid in
        } else {
          const k = 1 - Math.exp(-dt * 22); // light smoothing: steady, but never behind the real hand
          for (let i = 0; i < 63; i++) cur[i] += (tgt[i] - cur[i]) * k;
        }
        havePose = true;
        lastSeen = now;
        valid = true;
      }

      // in quickly when a hand is found, out over a quarter of a second when it is lost
      const want = valid || now - lastSeen < 80;
      fade = want ? Math.min(1, fade + dt / 0.1) : Math.max(0, fade - dt / 0.25);

      let show = false;
      if (havePose && fade > 0.002) {
        const p0 = stats ? performance.now() : 0;
        show = normalizeInto(cur, pose, generic, useZ, Z_GAIN, hf);
        if (show) {
          poseSamples(active, pose, positions);
          posAttr.needsUpdate = true;
          if (plan.wire && frameNo % 2 === 0) {
            const w = handWire(pose);
            if (w.length === wireArr.length) {
              wireArr.set(w);
              wireAttr.needsUpdate = true;
            }
          }
          fillRails(pose, fingerArr, handRailArr, beadArr, info, railSide(pose, hf.x0, hf.len, width));
          fingerAttr.needsUpdate = true;
          handRailAttr.needsUpdate = true;
          beadAttr.needsUpdate = true;

          poseBounds(pose, bounds);
          const sweeping = !reduce && plan.twinkle;
          const by = sweeping ? bounds.minY + (bounds.maxY - bounds.minY) * triangle(t, SWEEP_S) : -99;
          const x0 = bounds.minX - 0.1;
          const x1 = bounds.maxX + 0.1;
          beamArr[0] = x0; beamArr[1] = by; beamArr[2] = 0.08;
          beamArr[3] = x1; beamArr[4] = by; beamArr[5] = 0.08;
          beamArr[6] = x0; beamArr[7] = by + 0.014; beamArr[8] = 0.08;
          beamArr[9] = x1; beamArr[10] = by + 0.014; beamArr[11] = 0.08;
          beamAttr.needsUpdate = true;
          beam.visible = sweeping;

          hand.position.set(hf.x0, hf.y0, 0);
          hand.scale.set(hf.len, -hf.len, hf.len);
          const px = Math.min(3.4, Math.max(1.6, hf.len * 0.0078)) * dpr;
          handMat.uniforms.uPx.value = px;
          beadMat.uniforms.uPx.value = px * 1.8;
          for (const m of [handMat, beadMat]) {
            m.uniforms.uTime.value = t;
            m.uniforms.uBeam.value = by;
            m.uniforms.uTwinkle.value = reduce || !plan.twinkle ? 0 : 1;
            m.uniforms.uFade.value = fade;
          }
          wireMat.opacity = 0.62 * fade;
          fingerMat.opacity = 0.95 * fade;
          handRailMat.opacity = fade;
          beamMat.opacity = 0.9 * fade;
          shadowMat.opacity = 0.5 * fade;
        }
        if (stats) stats.poseMs += performance.now() - p0;
      }
      hand.visible = show;

      if (show || drawn) {
        renderer.render(scene, camera); // also clears the canvas once the hand has faded out
        drawn = show;
      }
      if (frameNo % 2 === 0) updateTags(show);
      const cost = performance.now() - c0;
      guard.frame(cost);
      if (stats) {
        stats.frames++;
        stats.frameMs += cost;
      }
    };

    // Labels: finger lengths above the fingertips (each rises until it clears the ones already placed), the hand
    // length beside its rail. Every label stays inside the element.
    const updateTags = (show: boolean) => {
      const tags = propsRef.current.tags;
      if (!tags || tags.length === 0) return;
      const visible = show && fade > 0.35;
      const placed: { x: number; y: number; w: number }[] = [];
      const GAP = 3;
      const tops: { i: number; x: number; y: number }[] = [];
      tags.forEach((tag, i) => {
        const el = tagEls.current[i];
        if (!el) return;
        el.style.opacity = visible ? "1" : "0";
        if (!visible) return;
        const w = el.offsetWidth || 70;
        const h = el.offsetHeight || 22;
        if (tag.between) {
          const [a, b] = tag.between;
          const railed = (a === 0 && b === 12) || (a === 12 && b === 0);
          const ex = railed ? hf.x0 + info.mx * hf.len : (cur[a * 3] + cur[b * 3]) / 2;
          const ey = railed ? hf.y0 - info.my * hf.len : (cur[a * 3 + 1] + cur[b * 3 + 1]) / 2;
          const side = railed ? info.side : 1;
          let left = side > 0 ? ex + 12 : ex - w - 12;
          left = Math.min(width - w - 4, Math.max(4, left));
          const top = Math.min(height - h - 4, Math.max(4, ey - h / 2));
          el.style.transform = `translate(${left.toFixed(1)}px, ${top.toFixed(1)}px)`;
          placed.push({ x: left + w / 2, y: top, w });
        } else {
          tops.push({ i, x: cur[tag.joint * 3], y: cur[tag.joint * 3 + 1] });
        }
      });
      if (!visible) return;
      tops.sort((u, v) => u.x - v.x);
      for (const s of tops) {
        const el = tagEls.current[s.i];
        if (!el) continue;
        const w = el.offsetWidth || 50;
        const h = el.offsetHeight || 22;
        let top = s.y - 10 - h;
        const cx = Math.min(width - w / 2 - 4, Math.max(w / 2 + 4, s.x));
        for (let guard = 0; guard < 8; guard++) {
          const hit = placed.find((q) => Math.abs(q.x - cx) < (q.w + w) / 2 + GAP && Math.abs(q.y - top) < h + GAP);
          if (!hit) break;
          top = hit.y - h - GAP;
        }
        top = Math.max(4, top);
        placed.push({ x: cx, y: top, w });
        el.style.setProperty("--lead", `${Math.max(8, s.y - top - h)}px`);
        el.style.transform = `translate(${cx.toFixed(1)}px, ${top.toFixed(1)}px) translateX(-50%)`;
      }
    };

    // ---- the loop: while the layer is on screen and the page is in front
    let raf = 0;
    let looping = false;
    let visible = true;
    let lost = false;
    const wanted = () => visible && !document.hidden && !lost;
    const tick = (now: number) => {
      raf = 0;
      if (!wanted()) {
        looping = false;
        return;
      }
      const next = guard.tick(now);
      if (next.level !== plan.level) {
        applyPlan(next);
        if (next.disabled) {
          looping = false;
          disable();
          return;
        }
      }
      if (now - lastFrame >= 1000 / plan.fps - 2) frame(now);
      raf = requestAnimationFrame(tick);
    };
    const start = () => {
      if (looping || !wanted()) return;
      looping = true;
      lastFrame = 0;
      raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver((entries) => {
      visible = entries[entries.length - 1]?.isIntersecting ?? true;
      if (visible) start();
    });
    io.observe(mount);
    const onVisibility = () => {
      if (!document.hidden) start();
    };
    document.addEventListener("visibilitychange", onVisibility);
    // A lost context cannot be drawn to: the layer switches itself off (the screen's 2D drawing takes over)
    // rather than leave a blank, frozen canvas. A restored context finds it already gone.
    const onLost = (e: Event) => {
      e.preventDefault();
      lost = true;
      disable();
    };
    canvas.addEventListener("webglcontextlost", onLost);

    resize();
    start();

    return () => {
      lost = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onLost);
      for (const g of [handGeo, wireGeo, fingerGeo, handRailGeo, beadGeo, beamGeo]) g.dispose();
      for (const m of [handMat, beadMat, wireMat, fingerMat, handRailMat, beamMat, shadowMat]) m.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    };
    } catch (err) {
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      throw err;
    }
    };

    let teardown: (() => void) | undefined;
    try {
      teardown = build();
    } catch (err) {
      console.warn("3D hand overlay: could not start", err);
      disable();
    }
    return () => teardown?.();
  }, []);

  if (failed) return null;
  return (
    <>
      <div ref={mountRef} className="hand-stage-gl" />
      {props.tags && props.tags.length > 0 && (
        <div className="hand-stage-tags" aria-hidden="true">
          {props.tags.map((tag, i) => (
            <span
              key={`${tag.joint}-${tag.between ? tag.between.join("_") : ""}`}
              ref={(el) => void (tagEls.current[i] = el)}
              className={`hand-stage-tag${tag.emphasis ? " hand-stage-tag--em" : ""}${tag.between ? " hand-stage-tag--side" : ""}`}
            >
              {tag.label}
            </span>
          ))}
        </div>
      )}
    </>
  );
}
