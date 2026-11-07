// The CLEAN look of the camera-view overlay (HandStage look="clean"): nothing but the live landmark skeleton drawn
// over the real hand. For each of the 21 tracked landmarks a joint (a disc with a white ring and a thin dark edge, so
// it reads on any picture), and between them tapered strokes in the colour of their finger, shaded by relief and
// drawn far bones first, a translucent palm and a short fading wrist stub. No rings, sparkles, dust, sweep, sampled
// points, forearm cylinder, grid or rails.
//
// THIS IS A 3D LANDMARK SKELETON, NOT A RECONSTRUCTED SURFACE. It shows where hand tracking puts the joints; the
// relief (z) only shades near parts lighter and orders far bones first, because MediaPipe's relative depth is an
// estimate, not a physical distance.
//
// It reads the same inputs as the glow look (poseRef landmarks in video pixels, frameRef, mirror, tone, tags, budget,
// onDegrade) and keeps the performance guard, the single onDegrade report and window.__OVERLAY_STATS__, but it costs a
// few hundred vertices a frame, so the guard has nothing to step down. It only READS landmarks.
import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, NormalBlending, OrthographicCamera, Points, Scene, ShaderMaterial, WebGLRenderer } from "three";
import { useEffect, useRef, useState } from "react";
import type { HandStageProps, OverlayDegradeReason } from "./HandStage";
import type { Landmark } from "./handModel";
import { CONNECTIONS, PALM_POLYGON, PART_COLOURS, boneOf, fingerOf, type Part } from "./landmarkTopology";
import {
  SKELETON_BONE_VERTS,
  SKELETON_QUADS,
  containRect,
  fillBoneVerts,
  fillWristStub,
  hasDepth,
  jointDiameter,
  mapToElement,
  palmLength,
  skeletonShade,
  skeletonToneAlpha,
  sortByKey,
} from "./overlayMath";
import { createLabelPlacer, OverlayTagLayer, type TagRefs } from "./overlayLabels";
import { approach } from "./palette";
import { DEFAULT_BUDGET, PerfGuard, type Budget } from "./perfGuard";

const FPS = 30;
const FADE_IN_S = 0.2;
const FADE_OUT_S = 0.25;
const TONE_SETTLE_MS = 250;
const SMOOTH = 24; // light smoothing: steady, but never behind the real hand
const NB = CONNECTIONS.length;
const PALM_ALPHA = 0.24;

const rgb01 = (hex: number): [number, number, number] => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
const PART_RGB: Record<Part, [number, number, number]> = {
  thumb: rgb01(PART_COLOURS.thumb),
  index: rgb01(PART_COLOURS.index),
  middle: rgb01(PART_COLOURS.middle),
  ring: rgb01(PART_COLOURS.ring),
  pinky: rgb01(PART_COLOURS.pinky),
  palm: rgb01(PART_COLOURS.palm),
};

const FLAT_VERT = /* glsl */ `
  attribute vec4 aColor;
  varying vec4 vC;
  void main() {
    vC = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const FLAT_FRAG = /* glsl */ `
  uniform float uAlpha;
  varying vec4 vC;
  void main() {
    gl_FragColor = vec4(vC.rgb, vC.a * uAlpha);
  }
`;
const JOINT_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  uniform float uDpr;
  varying vec3 vC;
  void main() {
    vC = aColor;
    gl_PointSize = aSize * uDpr;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
// a coloured disc, a white ring and a thin dark edge: legible on a white table and on a dark one
const JOINT_FRAG = /* glsl */ `
  uniform float uAlpha;
  varying vec3 vC;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r = length(c) * 2.0;
    if (r > 1.0) discard;
    vec3 col = mix(vC, vec3(1.0), smoothstep(0.62, 0.68, r));
    col = mix(col, vec3(0.02, 0.1, 0.2), smoothstep(0.84, 0.9, r));
    float edge = 1.0 - smoothstep(0.93, 1.0, r);
    float a = edge * mix(1.0, 0.6, smoothstep(0.84, 0.9, r)) * uAlpha;
    gl_FragColor = vec4(col, a);
  }
`;

function flatMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: FLAT_VERT,
    fragmentShader: FLAT_FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: NormalBlending,
    // the camera maps screen pixels with y down, which flips the winding of every triangle: draw both faces
    side: DoubleSide,
    uniforms: { uAlpha: { value: 0 } },
  });
}

function dynamic(attr: BufferAttribute): BufferAttribute {
  attr.setUsage(35048); // DynamicDrawUsage
  return attr;
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

/** Set by a test page to read the cost of a frame; never set in the app. */
interface FrameStats {
  frames: number;
  poseMs: number;
  frameMs: number;
}

export default function HandOverlayCleanGL(props: HandStageProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const refsBox = useRef<TagRefs>({ tags: { current: [] }, leads: { current: [] }, dots: { current: [] } });
  const refs = refsBox.current;
  const propsRef = useRef(props);
  propsRef.current = props;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let degraded = false;
    // Switched off (no WebGL, the scene could not start, the context was lost, or it was too heavy for this
    // phone): render nothing and tell the screen once, which goes back to its 2D drawing.
    const disable = (reason: OverlayDegradeReason, detail?: string) => {
      if (degraded) return;
      degraded = true;
      const prev = (globalThis as { __OVERLAY_STATS__?: object }).__OVERLAY_STATS__ ?? {};
      (globalThis as { __OVERLAY_STATS__?: unknown }).__OVERLAY_STATS__ = { ...prev, reason: detail ? `${reason}: ${detail}` : reason };
      setFailed(true);
      propsRef.current.onDegrade?.(reason, detail);
    };

    const build = (): (() => void) => {
      const stats = (globalThis as { __HAND3D_STATS__?: FrameStats }).__HAND3D_STATS__;
      // No multisampling on this full-size, always-on layer: it costs fill-rate on a phone and, next to the 3D card's own context,
      // got this context dropped under load (the glow look has always run without it). Edges stay smooth enough from the bones' halo.
      const renderer = new WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" });
      try {
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        renderer.setClearColor(0x000000, 0);
        renderer.setPixelRatio(dpr);
        const canvas = renderer.domElement;
        mount.appendChild(canvas);

        // Screen pixels, y down: the camera maps a point of the layer to the same pixel of the video behind it.
        const scene = new Scene();
        const camera = new OrthographicCamera(0, 1, 0, 1, 1, 3000);
        camera.position.z = 1500;

        // ---- the palm: a translucent fan over wrist, thumb base and the four knuckles
        const palmPos = new Float32Array(PALM_POLYGON.length * 3);
        const palmCol = new Float32Array(PALM_POLYGON.length * 4);
        const [pr, pg, pb] = PART_RGB.palm;
        for (let i = 0; i < PALM_POLYGON.length; i++) {
          palmCol[i * 4] = pr;
          palmCol[i * 4 + 1] = pg;
          palmCol[i * 4 + 2] = pb;
          palmCol[i * 4 + 3] = PALM_ALPHA;
        }
        const palmGeo = new BufferGeometry();
        const palmPosAttr = dynamic(new BufferAttribute(palmPos, 3));
        palmGeo.setAttribute("position", palmPosAttr);
        palmGeo.setAttribute("aColor", new BufferAttribute(palmCol, 4));
        const fan: number[] = [];
        for (let i = 1; i < PALM_POLYGON.length - 1; i++) fan.push(0, i, i + 1);
        palmGeo.setIndex(fan);
        const palmMat = flatMaterial();
        const palm = new Mesh(palmGeo, palmMat);
        palm.renderOrder = 0;

        // ---- the wrist stub
        const wristPos = new Float32Array(12);
        const wristCol = new Float32Array(16);
        const wristPosAttr = dynamic(new BufferAttribute(wristPos, 3));
        const wristColAttr = dynamic(new BufferAttribute(wristCol, 4));
        const wristGeo = new BufferGeometry();
        wristGeo.setAttribute("position", wristPosAttr);
        wristGeo.setAttribute("aColor", wristColAttr);
        wristGeo.setIndex([0, 1, 2, 1, 3, 2]);
        const wristMat = flatMaterial();
        const wrist = new Mesh(wristGeo, wristMat);
        wrist.renderOrder = 1;

        // ---- the bones: three quads each (dark outline, white halo, colour), written far to near
        const bonePos = new Float32Array(NB * SKELETON_BONE_VERTS * 3);
        const boneCol = new Float32Array(NB * SKELETON_BONE_VERTS * 4);
        const bonePosAttr = dynamic(new BufferAttribute(bonePos, 3));
        const boneColAttr = dynamic(new BufferAttribute(boneCol, 4));
        const boneGeo = new BufferGeometry();
        boneGeo.setAttribute("position", bonePosAttr);
        boneGeo.setAttribute("aColor", boneColAttr);
        const boneIdx: number[] = [];
        for (let s = 0; s < NB * SKELETON_QUADS; s++) {
          const base = s * 4;
          boneIdx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
        }
        boneGeo.setIndex(boneIdx);
        const boneMat = flatMaterial();
        const bonesMesh = new Mesh(boneGeo, boneMat);
        bonesMesh.renderOrder = 2;
        const boneRgb = new Float32Array(NB * 3);
        CONNECTIONS.forEach(([a, b], k) => {
          const c = PART_RGB[boneOf(a, b)];
          boneRgb[k * 3] = c[0];
          boneRgb[k * 3 + 1] = c[1];
          boneRgb[k * 3 + 2] = c[2];
        });

        // ---- the joints: discs, nearest drawn last
        const jointPos = new Float32Array(63);
        const jointCol = new Float32Array(63);
        const jointSize = new Float32Array(21);
        const jointPosAttr = dynamic(new BufferAttribute(jointPos, 3));
        const jointColAttr = dynamic(new BufferAttribute(jointCol, 3));
        const jointSizeAttr = dynamic(new BufferAttribute(jointSize, 1));
        const jointIdxArr = new Uint16Array(21);
        const jointIdxAttr = dynamic(new BufferAttribute(jointIdxArr, 1));
        const jointGeo = new BufferGeometry();
        jointGeo.setAttribute("position", jointPosAttr);
        jointGeo.setAttribute("aColor", jointColAttr);
        jointGeo.setAttribute("aSize", jointSizeAttr);
        jointGeo.setIndex(jointIdxAttr);
        const jointMat = new ShaderMaterial({
          vertexShader: JOINT_VERT,
          fragmentShader: JOINT_FRAG,
          transparent: true,
          depthTest: false,
          depthWrite: false,
          blending: NormalBlending,
          uniforms: { uAlpha: { value: 0 }, uDpr: { value: dpr } },
        });
        const joints = new Points(jointGeo, jointMat);
        joints.renderOrder = 3;
        const jointRgb: [number, number, number][] = Array.from({ length: 21 }, (_, i) => PART_RGB[fingerOf(i)]);

        for (const o of [palm, wrist, bonesMesh, joints]) {
          o.frustumCulled = false;
          scene.add(o);
        }

        // ---- state, all preallocated
        const tgt = new Float32Array(63); // the tracked hand on the screen (x, y, relief) per joint
        const cur = new Float32Array(63); // the eased one that is drawn
        const boneOrder: number[] = Array.from({ length: NB }, (_, k) => k);
        const boneKey = new Float32Array(NB);
        const jointOrder: number[] = Array.from({ length: 21 }, (_, k) => k);
        const jointKey = new Float32Array(21);
        let toneAlpha = skeletonToneAlpha(propsRef.current.tone);
        let havePose = false;
        let lastSeen = -1e9;
        let fade = 0;
        let useZ = false;
        let drawn = false;
        let frameNo = 0;
        let width = 0;
        let height = 0;
        let lastFrame = 0;
        const bud = propsRef.current.budget;
        const budget: Budget = bud && bud.maxFrameMs > 0 && bud.minFps > 0 ? bud : DEFAULT_BUDGET;
        const guard = new PerfGuard(budget);
        let statsAt = 0;
        const publishStats = (now: number) => {
          if (now - statsAt < 500) return;
          statsAt = now;
          (globalThis as { __OVERLAY_STATS__?: unknown }).__OVERLAY_STATS__ = {
            level: guard.plan.level,
            costMs: guard.costMs < 0 ? null : Math.round(guard.costMs * 100) / 100,
            pageFps: guard.intervalMs <= 0 ? null : Math.round(10000 / guard.intervalMs) / 10,
            reason: null,
            look: "clean",
          };
        };
        const placeLabels = createLabelPlacer(() => propsRef.current, refs);

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
              const k = 1 - Math.exp(-dt * SMOOTH);
              for (let i = 0; i < 63; i++) cur[i] += (tgt[i] - cur[i]) * k;
            }
            havePose = true;
            lastSeen = now;
            valid = true;
          }

          // in over 0.2 s when a hand is found, out over a quarter of a second when lost
          const want = valid || now - lastSeen < 80;
          fade = want ? Math.min(1, fade + dt / FADE_IN_S) : Math.max(0, fade - dt / FADE_OUT_S);
          toneAlpha = approach(toneAlpha, skeletonToneAlpha(p.tone), dt * 1000, TONE_SETTLE_MS);

          let show = false;
          let stub = false;
          if (havePose && fade > 0.002) {
            const p0 = stats ? performance.now() : 0;
            const palmLen = palmLength(cur);
            show = palmLen > 4;
            if (show) {
              for (let i = 0; i < PALM_POLYGON.length; i++) {
                const j = PALM_POLYGON[i];
                palmPos[i * 3] = cur[j * 3];
                palmPos[i * 3 + 1] = cur[j * 3 + 1];
                palmPos[i * 3 + 2] = 0;
              }
              palmPosAttr.needsUpdate = true;

              stub = fillWristStub(cur, palmLen, PART_RGB.palm, wristPos, wristCol);
              wristPosAttr.needsUpdate = true;
              wristColAttr.needsUpdate = true;

              for (let k = 0; k < NB; k++) {
                const [a, c] = CONNECTIONS[k];
                boneKey[k] = (cur[a * 3 + 2] + cur[c * 3 + 2]) / 2;
              }
              sortByKey(boneOrder, boneKey);
              fillBoneVerts(cur, CONNECTIONS, boneOrder, boneRgb, palmLen, bonePos, boneCol);
              bonePosAttr.needsUpdate = true;
              boneColAttr.needsUpdate = true;

              for (let i = 0; i < 21; i++) {
                const z = cur[i * 3 + 2];
                jointKey[i] = z;
                jointPos[i * 3] = cur[i * 3];
                jointPos[i * 3 + 1] = cur[i * 3 + 1];
                jointPos[i * 3 + 2] = 0;
                const s = skeletonShade(z, palmLen);
                const c = jointRgb[i];
                jointCol[i * 3] = Math.min(1, c[0] * s);
                jointCol[i * 3 + 1] = Math.min(1, c[1] * s);
                jointCol[i * 3 + 2] = Math.min(1, c[2] * s);
                jointSize[i] = jointDiameter(i, palmLen, z);
              }
              sortByKey(jointOrder, jointKey);
              for (let i = 0; i < 21; i++) jointIdxArr[i] = jointOrder[i];
              jointPosAttr.needsUpdate = true;
              jointColAttr.needsUpdate = true;
              jointSizeAttr.needsUpdate = true;
              jointIdxAttr.needsUpdate = true;

              const alpha = fade * toneAlpha;
              palmMat.uniforms.uAlpha.value = alpha;
              wristMat.uniforms.uAlpha.value = alpha;
              boneMat.uniforms.uAlpha.value = alpha;
              jointMat.uniforms.uAlpha.value = alpha;
            }
            if (stats) stats.poseMs += performance.now() - p0;
          }
          palm.visible = show;
          bonesMesh.visible = show;
          joints.visible = show;
          wrist.visible = show && stub;

          if (show || drawn) {
            renderer.render(scene, camera); // also clears the canvas once the hand has faded out
            drawn = show;
          }
          if (frameNo % 2 === 0) placeLabels({ show: show && fade > 0.35, joints: cur, width, height });
          const cost = performance.now() - c0;
          guard.frame(cost);
          if (stats) {
            stats.frames++;
            stats.frameMs += cost;
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
          publishStats(now);
          if (next.disabled) {
            looping = false;
            disable(guard.disabledReason ?? "too_slow");
            return;
          }
          if (now - lastFrame >= 1000 / next.fps - 2) frame(now);
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
        // A lost context cannot be drawn to: switch off (the screen's 2D drawing takes over) rather than leave a
        // blank, frozen canvas.
        const onLost = (e: Event) => {
          e.preventDefault();
          lost = true;
          disable("context_lost");
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
          for (const g of [palmGeo, wristGeo, boneGeo, jointGeo]) g.dispose();
          for (const m of [palmMat, wristMat, boneMat, jointMat]) m.dispose();
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
      const text = err instanceof Error ? err.message : String(err);
      disable(/webgl/i.test(text) ? "no_webgl" : "error", text);
    }
    return () => teardown?.();
  }, []);

  if (failed) return null;
  return (
    <>
      <div ref={mountRef} className="hand-stage-gl" />
      <OverlayTagLayer tags={props.tags} refs={refs} />
    </>
  );
}
