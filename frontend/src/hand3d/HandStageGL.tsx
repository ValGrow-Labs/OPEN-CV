// The three.js scene of the glowing hand. Loaded lazily (HandStage.tsx), so three.js is not part of the main bundle.
//
// Modes (see docs/HAND_3D.md):
//   scan, static, live  a luminous particle hand with a wireframe outline over a sonar-wave grid, in a dark
//                       stage (ClassicScene below): the calculating screen, the result page, a small live tile.
//   overlay             the camera view itself (HandOverlayGL.tsx): a transparent layer drawn exactly over the
//                       real hand, with measuring rails along the fingers and a scanning sweep. It uses only the
//                       tracked landmarks (no video pixels are read), takes no input and is aria-hidden.
//
// The overlay protects scan speed (perfGuard.ts): when its own cost or the page's frame rate is over budget for
// about 1.5 s it takes itself down a step (half the points, no wireframe or twinkle, 20 fps) and finally
// switches itself off, calling onDegrade("disabled") so the screen goes back to its 2D drawing. It never steps
// back up. A lost WebGL context or a scene that cannot start also switches it off: never a blank, frozen canvas.
//
// It is an illustration drawn from 21 landmarks, not a 3D scan.
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  RingGeometry,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderer,
} from "three";
import { useEffect, useRef, useState } from "react";
import type { HandStageProps } from "./HandStage";
import HandOverlayGL from "./HandOverlayGL";
import { genericHand, handWire, measureRings, normalizePose, poseSamples, sampleHand, type Landmark, type SampledHand, type Vec3 } from "./handModel";
import { bracketBox, splitLabel } from "./lightLayout";
import { LIGHT_HEX } from "./palette";

const FOV = 36;
const FLOOR_Y = -0.62; // the floor, in the spinning frame (the wrist sits at -0.5)
const RIG_Y = -0.5; // the hand's own origin (its wrist) in the spinning frame
const SWING_RAD = (35 * Math.PI) / 180;
const SCAN_SWING_RAD = (58 * Math.PI) / 180; // the hero hand sways rather than spins: it is never seen edge-on
const TURN_S = 14;
const COUNT_SMALL = 4500;
const COUNT_LARGE = 9000;
// The live tile runs next to hand tracking (which also uses the GPU): it must never slow the scan down.
const COUNT_LIVE = 2200;
const LIVE_FPS = 24;

const BLUE = new Color("#2b8cff");
const CYAN = new Color("#19e6e6");

// The light theme (result page): normal blending on a pale stage, so colours are saturated blues.
const SWING_LIGHT_RAD = (20 * Math.PI) / 180; // the labels sit beside the hand: it sways a little less
const L_DEEP = new Color(LIGHT_HEX.deep);
const L_MID = new Color(LIGHT_HEX.mid);
const L_GLOW = new Color(LIGHT_HEX.glow);

const POINT_VERT = /* glsl */ `
  attribute float aGlow;
  attribute float aSeed;
  attribute vec3 aDir;
  uniform float uTime;
  uniform float uScale;
  uniform float uSize;
  uniform float uBeam;
  uniform float uDrift;
  uniform float uTwinkle;
  varying float vGlow;
  varying float vBeam;
  varying float vTw;
  void main() {
    vec3 p = position;
    float s = aSeed * 6.2831;
    p += aDir * uDrift * (0.6 + 0.4 * sin(uTime * 0.7 + s * 3.0));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float d = abs(position.y - uBeam);
    vBeam = exp(-d * d * 420.0);
    vTw = mix(1.0, 0.72 + 0.28 * sin(uTime * 2.4 + s * 5.0), uTwinkle);
    vGlow = aGlow;
    gl_PointSize = uSize * uScale * (0.6 + aGlow * 1.3 + vBeam * 0.8) / max(0.2, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const POINT_FRAG = /* glsl */ `
  uniform vec3 uBlue;
  uniform vec3 uCyan;
  uniform float uAlpha;
  uniform float uDim;
  varying float vGlow;
  varying float vBeam;
  varying float vTw;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r = length(c) * 2.0;
    if (r > 1.0) discard;
    float a = pow(1.0 - r, 1.7);
    float g = clamp(vGlow * vTw + vBeam * 0.55, 0.0, 1.25);
    vec3 col = mix(uBlue, uCyan, smoothstep(0.05, 0.6, g));
    col = mix(col, vec3(1.0), smoothstep(0.62, 1.1, g));
    float k = (0.5 + g) * uAlpha * uDim;
    gl_FragColor = vec4(col * k * a, a * k);
  }
`;

const GRID_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uAmp;
  varying float vA;
  varying float vW;
  void main() {
    vec3 p = position;
    float r = length(p.xz);
    float w = sin(r * 9.0 - uTime * 2.2) * exp(-r * 0.95) * uAmp
            + 0.45 * sin(r * 3.2 - uTime * 0.9) * exp(-r * 0.5) * uAmp;
    p.y += w;
    vW = w / max(uAmp, 0.0001);
    vA = (1.0 - smoothstep(1.2, 3.1, r)) * (0.3 + 0.7 * exp(-r * 0.55));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const GRID_FRAG = /* glsl */ `
  uniform vec3 uBlue;
  uniform vec3 uCyan;
  uniform float uAlpha;
  varying float vA;
  varying float vW;
  void main() {
    float crest = smoothstep(0.25, 1.0, abs(vW));
    vec3 col = mix(uBlue, uCyan, 0.35 + 0.65 * crest);
    col = mix(col, vec3(1.0), crest * 0.35);
    gl_FragColor = vec4(col, vA * uAlpha * (0.55 + 0.7 * crest));
  }
`;

/** A tiny seeded generator, so the dust and twinkle phases are the same on every device. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function validLandmarks(points: readonly Landmark[] | null | undefined): points is readonly Landmark[] {
  return !!points && points.length >= 21 && points.slice(0, 21).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

function toPose(points: readonly Landmark[] | null | undefined, mirror: boolean): Vec3[] {
  if (validLandmarks(points)) {
    try {
      return normalizePose(points, { mirror });
    } catch {
      /* fall through to the generic hand */
    }
  }
  return genericHand();
}

function lineGrid(): BufferGeometry {
  const lines = 41;
  const extent = 3.2;
  const seg = 100;
  const verts: number[] = [];
  for (let i = 0; i < lines; i++) {
    const c = -extent + (2 * extent * i) / (lines - 1);
    for (let j = 0; j < seg; j++) {
      const a = -extent + (2 * extent * j) / seg;
      const b = -extent + (2 * extent * (j + 1)) / seg;
      verts.push(a, 0, c, b, 0, c); // along x
      verts.push(c, 0, a, c, 0, b); // along z
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(verts), 3));
  return g;
}

function pointMaterial(size: number, alpha: number, drift: number): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: POINT_VERT,
    fragmentShader: POINT_FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uScale: { value: 800 },
      uSize: { value: size },
      uBeam: { value: -9 },
      uDrift: { value: drift },
      uTwinkle: { value: 1 },
      uBlue: { value: BLUE },
      uCyan: { value: CYAN },
      uAlpha: { value: alpha },
      uDim: { value: 1 },
    },
  });
}

// Light theme points: a soft blue speck whose colour climbs from deep blue to bright cyan-blue with its glow,
// drawn with normal alpha blending (additive light would vanish on a white page).
const LIGHT_POINT_FRAG = /* glsl */ `
  uniform vec3 uDeep;
  uniform vec3 uMid;
  uniform vec3 uGlow;
  uniform float uAlpha;
  uniform float uDim;
  varying float vGlow;
  varying float vBeam;
  varying float vTw;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r = length(c) * 2.0;
    if (r > 1.0) discard;
    float a = pow(1.0 - r, 1.35);
    float g = clamp(vGlow * vTw + vBeam * 0.55, 0.0, 1.25);
    vec3 col = mix(uDeep, uMid, smoothstep(0.0, 0.12, g));
    col = mix(col, uGlow, smoothstep(0.15, 0.8, g));
    float k = (0.4 + g * 0.8) * uAlpha * uDim;
    gl_FragColor = vec4(col, clamp(a * k, 0.0, 1.0));
  }
`;

function lightPointMaterial(size: number, alpha: number, drift: number): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: POINT_VERT,
    fragmentShader: LIGHT_POINT_FRAG,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uScale: { value: 800 },
      uSize: { value: size },
      uBeam: { value: -9 },
      uDrift: { value: drift },
      uTwinkle: { value: 1 },
      uDeep: { value: L_DEEP },
      uMid: { value: L_MID },
      uGlow: { value: L_GLOW },
      uAlpha: { value: alpha },
      uDim: { value: 1 },
    },
  });
}

// A soft cyan aura behind the hand (a radial gradient on a quad that faces the camera).
const AURA_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const AURA_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  varying vec2 vUv;
  void main() {
    float d = length((vUv - 0.5) * vec2(1.0, 0.9)) * 2.0;
    float a = pow(clamp(1.0 - d, 0.0, 1.0), 2.2) * uAlpha;
    gl_FragColor = vec4(uColor, a);
  }
`;

interface OrbitLayer {
  inner: number;
  outer: number;
  color: string;
  opacity: number;
}

/** One luminous orbit ring: layered flat rings (a wide faint halo, a blue body, a white-hot core), each split in
 *  two halves so the back half can be drawn behind the hand and the front half in front of it. The ring lies in
 *  the group's XZ plane; its front (towards the camera) is the half with z > 0. */
function orbitRing(radius: number, halo: string, layers: readonly [number, number, number][]): { group: Group; disposables: (BufferGeometry | MeshBasicMaterial)[] } {
  const group = new Group();
  const disposables: (BufferGeometry | MeshBasicMaterial)[] = [];
  const spec: OrbitLayer[] = layers.map(([w, op, which]) => ({
    inner: radius - w / 2,
    outer: radius + w / 2,
    color: which === 0 ? halo : which === 1 ? LIGHT_HEX.mid : LIGHT_HEX.ringCore,
    opacity: op,
  }));
  spec.forEach((l, i) => {
    const mat = new MeshBasicMaterial({ color: l.color, transparent: true, opacity: l.opacity, depthWrite: false, side: DoubleSide });
    disposables.push(mat);
    // after a -90 degree turn about x, geometry y < 0 (theta in pi..2pi) faces the camera
    for (const front of [false, true]) {
      const geo = new RingGeometry(l.inner, l.outer, 120, 1, front ? Math.PI : 0, Math.PI);
      disposables.push(geo);
      const m = new Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = front ? 3 + i * 0.01 : -2 + i * 0.01;
      group.add(m);
    }
  });
  return { group, disposables };
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The camera overlay or the stage scenes, by mode. */
export default function HandStageGL(props: HandStageProps) {
  return props.mode === "overlay" ? <HandOverlayGL {...props} /> : <ClassicScene {...props} />;
}

function ClassicScene(props: HandStageProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const tagEls = useRef<(HTMLSpanElement | null)[]>([]);
  const propsRef = useRef(props);
  propsRef.current = props;
  const poseVersion = useRef(0);
  const [failed, setFailed] = useState(false);

  // A new pose, mode or mirror asks the running scene to re-read the props.
  useEffect(() => {
    poseVersion.current++;
  }, [props.landmarks, props.mode, props.mirror]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const phone = typeof matchMedia === "function" && matchMedia("(max-width: 640px), (pointer: coarse)").matches;
    const lowEnd = (navigator.hardwareConcurrency ?? 8) <= 4;
    const liveTile = propsRef.current.mode === "live";
    const count = liveTile ? COUNT_LIVE : phone || lowEnd ? COUNT_SMALL : COUNT_LARGE;
    const reduce = reducedMotion();
    // the light theme belongs to the stage modes: a live tile and the overlay never use it
    const light = propsRef.current.theme === "light" && propsRef.current.mode !== "live";

    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: false, alpha: true, powerPreference: "high-performance" });
    } catch (err) {
      console.warn("3D hand: WebGL unavailable", err);
      setFailed(true);
      return;
    }
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, liveTile ? 1 : phone ? 1.5 : 2));
    const canvas = renderer.domElement;
    mount.appendChild(canvas);

    const scene = new Scene();
    const camera = new PerspectiveCamera(FOV, 1, 0.1, 30);
    camera.position.set(0, 0.95, 2.95);
    camera.lookAt(0, -0.06, 0);

    // ---- the hand: particles attached to the bones, a halo of dust, and the wireframe outline
    const generic = genericHand();
    const sampled: SampledHand = sampleHand(generic, count, 7);
    const positions = new Float32Array(count * 3);
    const posAttr = new BufferAttribute(positions, 3);
    posAttr.setUsage(35048); // DynamicDrawUsage
    const rand = rng(11);
    const seed = new Float32Array(count);
    const dir = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      seed[i] = rand();
      const u = rand() * 2 - 1;
      const a = rand() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      dir[i * 3] = s * Math.cos(a);
      dir[i * 3 + 1] = u;
      dir[i * 3 + 2] = s * Math.sin(a);
    }
    const glowDust = new Float32Array(count);
    for (let i = 0; i < count; i++) glowDust[i] = 0.12 + sampled.glow[i] * 0.2;

    const handGeo = new BufferGeometry();
    handGeo.setAttribute("position", posAttr);
    handGeo.setAttribute("aGlow", new BufferAttribute(sampled.glow, 1));
    handGeo.setAttribute("aSeed", new BufferAttribute(seed, 1));
    handGeo.setAttribute("aDir", new BufferAttribute(dir, 3));

    const dustCount = Math.floor(count / 3);
    const dustGeo = new BufferGeometry();
    dustGeo.setAttribute("position", posAttr); // follows the hand
    dustGeo.setAttribute("aGlow", new BufferAttribute(glowDust, 1));
    dustGeo.setAttribute("aSeed", new BufferAttribute(seed, 1));
    dustGeo.setAttribute("aDir", new BufferAttribute(dir, 3));
    dustGeo.setDrawRange(0, dustCount);

    const handMat = light ? lightPointMaterial(0.017, 0.95, 0) : pointMaterial(0.02, 1.15, 0);
    const dustMat = light ? lightPointMaterial(0.026, 0.5, 0.12) : pointMaterial(0.022, 0.3, 0.07);
    const reflectMat = pointMaterial(0.02, 0.2, 0);
    // light theme: a soft, wide glow under the fine points (a third of them, big and faint) so the hand reads as luminous
    const bloomMat = light ? lightPointMaterial(0.08, 0.17, 0.02) : null;
    const pointMats: ShaderMaterial[] = [handMat, dustMat, reflectMat];
    if (bloomMat) pointMats.push(bloomMat);
    const wireOpacity = light ? 0.5 : 0.16;

    const wire0 = handWire(generic, { dense: light });
    let wireAttr = new BufferAttribute(new Float32Array(wire0), 3);
    const wireGeo = new BufferGeometry();
    wireGeo.setAttribute("position", wireAttr);
    const wireMat = light
      ? new LineBasicMaterial({ color: L_MID, transparent: true, opacity: wireOpacity, depthWrite: false })
      : new LineBasicMaterial({ color: CYAN, transparent: true, opacity: wireOpacity, blending: AdditiveBlending, depthWrite: false });

    const makeRig = (reflect: boolean) => {
      const rig = new Group();
      rig.position.y = RIG_Y;
      rig.add(new Points(handGeo, reflect ? reflectMat : handMat));
      if (!reflect) {
        if (bloomMat) rig.add(new Points(dustGeo, bloomMat));
        rig.add(new Points(dustGeo, dustMat));
        rig.add(new LineSegments(wireGeo, wireMat));
      }
      return rig;
    };

    const spinner = new Group();
    spinner.add(makeRig(false));
    const mirror = new Group();
    mirror.position.y = 2 * FLOOR_Y;
    mirror.scale.y = -1;
    mirror.add(makeRig(true));
    if (!light) spinner.add(mirror);

    // ---- light theme only: measuring rings, sparkles around the hand, an aura, and two luminous orbit rings
    const lightDispose: { dispose(): void }[] = [];
    let measureAttr: BufferAttribute | null = null;
    let orbitA: Group | null = null;
    let orbitB: Group | null = null;
    if (light) {
      const mGeo = new BufferGeometry();
      measureAttr = new BufferAttribute(measureRings(generic), 3);
      mGeo.setAttribute("position", measureAttr);
      const mMat = new LineBasicMaterial({ color: LIGHT_HEX.measure, transparent: true, opacity: 0.85, depthWrite: false });
      const mLines = new LineSegments(mGeo, mMat);
      mLines.renderOrder = 1;
      const mRig = new Group();
      mRig.position.y = RIG_Y;
      mRig.add(mLines);
      spinner.add(mRig);
      lightDispose.push(mGeo, mMat);
      if (bloomMat) lightDispose.push(bloomMat);

      // sparkles: a loose shell around the hand, denser close to its outline, drifting gently
      const nSpark = phone || lowEnd ? 260 : 520;
      const sp = new Float32Array(nSpark * 3);
      const sSeed = new Float32Array(nSpark);
      const sGlow = new Float32Array(nSpark);
      const sDir = new Float32Array(nSpark * 3);
      const sr = rng(23);
      for (let i = 0; i < nSpark; i++) {
        const u = sr() * 2 - 1;
        const a = sr() * Math.PI * 2;
        const q = Math.sqrt(1 - u * u);
        const dx = q * Math.cos(a);
        const dz = q * Math.sin(a);
        const k = 0.95 + 0.85 * sr() * sr();
        sp[i * 3] = dx * 0.58 * k;
        sp[i * 3 + 1] = 0.5 + u * 0.72 * k;
        sp[i * 3 + 2] = dz * 0.3 * k;
        sSeed[i] = sr();
        sGlow[i] = 0.12 + sr() * 0.6;
        sDir[i * 3] = dx;
        sDir[i * 3 + 1] = u;
        sDir[i * 3 + 2] = dz;
      }
      const sGeo = new BufferGeometry();
      sGeo.setAttribute("position", new BufferAttribute(sp, 3));
      sGeo.setAttribute("aGlow", new BufferAttribute(sGlow, 1));
      sGeo.setAttribute("aSeed", new BufferAttribute(sSeed, 1));
      sGeo.setAttribute("aDir", new BufferAttribute(sDir, 3));
      const sparkMat = lightPointMaterial(0.022, 0.85, 0.09);
      pointMats.push(sparkMat);
      const sRig = new Group();
      sRig.position.y = RIG_Y;
      sRig.add(new Points(sGeo, sparkMat));
      spinner.add(sRig);
      lightDispose.push(sGeo, sparkMat);

      const aura = new Mesh(
        new PlaneGeometry(3.0, 3.0),
        new ShaderMaterial({ vertexShader: AURA_VERT, fragmentShader: AURA_FRAG, transparent: true, depthWrite: false, uniforms: { uColor: { value: L_GLOW }, uAlpha: { value: 0.3 } } }),
      );
      aura.position.set(0, 0.04, -0.4);
      aura.renderOrder = -3;
      scene.add(aura);
      lightDispose.push(aura.geometry, aura.material as ShaderMaterial);

      const layers: [number, number, number][] = [
        [0.09, 0.05, 0],
        [0.05, 0.09, 0],
        [0.022, 0.4, 1],
        [0.008, 1, 2],
      ];
      const a = orbitRing(0.8, LIGHT_HEX.ringHalo, layers);
      a.group.position.y = 0.02;
      a.group.rotation.set(0.3, 0, -0.34);
      orbitA = a.group;
      const b = orbitRing(0.64, LIGHT_HEX.ringGold, layers);
      b.group.position.y = 0.06;
      b.group.rotation.set(0.52, 0, 0.4);
      orbitB = b.group;
      scene.add(a.group, b.group);
      lightDispose.push(...a.disposables, ...b.disposables);
    }

    const beamMat = new MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
    const beam = new Mesh(new RingGeometry(0.62, 0.655, 96), beamMat);
    beam.rotation.x = -Math.PI / 2;
    const beamFill = new Mesh(
      new RingGeometry(0, 0.62, 96),
      new MeshBasicMaterial({ color: BLUE, transparent: true, opacity: 0.07, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }),
    );
    beamFill.rotation.x = -Math.PI / 2;
    const beamGroup = new Group();
    beamGroup.add(beam, beamFill);
    beamGroup.position.y = RIG_Y;
    spinner.add(beamGroup);

    const gridMat = new ShaderMaterial({
      vertexShader: GRID_VERT,
      fragmentShader: GRID_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uAmp: { value: 0.03 }, uBlue: { value: BLUE }, uCyan: { value: CYAN }, uAlpha: { value: 0.5 } },
    });
    const grid = new LineSegments(lineGrid(), gridMat);
    grid.position.y = FLOOR_Y;

    if (!light) scene.add(grid);
    scene.add(spinner);

    // ---- pose handling: the target pose is eased into the current one (live hands jitter)
    let target: Vec3[] = generic;
    let current: Vec3[] = generic.map((p) => ({ ...p }));
    let seenVersion = -1;
    let lastLive = performance.now();
    let dim = 1;

    const repose = () => {
      poseSamples(sampled, current, positions);
      posAttr.needsUpdate = true;
      const w = handWire(current, { dense: light });
      if (measureAttr) {
        (measureAttr.array as Float32Array).set(measureRings(current));
        measureAttr.needsUpdate = true;
      }
      if (w.length !== wireAttr.array.length) {
        wireAttr = new BufferAttribute(new Float32Array(w), 3);
        wireGeo.setAttribute("position", wireAttr);
      } else {
        (wireAttr.array as Float32Array).set(w);
        wireAttr.needsUpdate = true;
      }
    };
    repose();

    // ---- interaction
    let userYaw = 0;
    let userPitch = 0;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let autoResumeAt = 0;
    const onDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      userYaw += (e.clientX - lastX) * 0.012;
      userPitch = Math.max(-0.45, Math.min(0.45, userPitch + (e.clientY - lastY) * 0.005));
      lastX = e.clientX;
      lastY = e.clientY;
      autoResumeAt = performance.now() + 2200;
      requestRender();
    };
    const onUp = () => {
      dragging = false;
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);

    // ---- sizing
    let width = 0;
    let height = 0;
    const resize = () => {
      const r = mount.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      if (w === width && h === height) return;
      width = w;
      height = h;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      // keep the whole hand in view on narrow (portrait) stages
      camera.fov = w / h < 0.8 ? FOV + (0.8 - w / h) * 30 : FOV;
      camera.updateProjectionMatrix();
      const scale = renderer.domElement.height / (2 * Math.tan((camera.fov * Math.PI) / 360));
      for (const m of pointMats) m.uniforms.uScale.value = scale;
      requestRender();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    // ---- the frame
    let raf = 0;
    let looping = false;
    let visible = true;
    let lost = false;
    let lastFrame = 0;
    const t0 = performance.now();
    const tmp = new Vector3();
    const m4 = new Matrix4();

    const frame = (now: number) => {
      raf = 0;
      const p = propsRef.current;
      const live = p.mode === "live";
      const dt = Math.min(0.1, lastFrame ? (now - lastFrame) / 1000 : 0.016);
      lastFrame = now;
      const t = reduce ? 1.2 : (now - t0) / 1000;

      if (seenVersion !== poseVersion.current) {
        seenVersion = poseVersion.current;
        if (p.mode !== "live") {
          target = p.mode === "static" ? toPose(p.landmarks, !!p.mirror) : generic;
          current = target.map((v) => ({ ...v }));
          repose();
        }
      }
      if (live) {
        const src = p.poseRef?.current;
        if (validLandmarks(src)) {
          target = toPose(src, !!p.mirror);
          lastLive = now;
        }
        const k = 1 - Math.exp(-dt * 14);
        let moved = 0;
        current = current.map((c, i) => {
          const g = target[i] ?? c;
          const nx = c.x + (g.x - c.x) * k;
          const ny = c.y + (g.y - c.y) * k;
          const nz = c.z + (g.z - c.z) * k;
          moved = Math.max(moved, Math.abs(nx - c.x), Math.abs(ny - c.y), Math.abs(nz - c.z));
          return { x: nx, y: ny, z: nz };
        });
        if (moved > 1e-4) repose();
        const stale = (now - lastLive) / 1000;
        dim += ((stale > 1.5 ? 0.55 : 1) - dim) * (1 - Math.exp(-dt * 2));
      } else {
        dim = 1;
      }

      // rotation: a slow sway (wider while scanning, gentle where labels or the live hand must stay readable)
      const amp = p.mode === "scan" ? SCAN_SWING_RAD : light ? SWING_LIGHT_RAD : SWING_RAD;
      const yaw = reduce ? 0.35 : now > autoResumeAt ? Math.sin((t * 2 * Math.PI) / TURN_S) * amp : 0;
      spinner.rotation.y = yaw + userYaw;
      spinner.rotation.x = -0.12 + userPitch;

      const beamOn = p.mode === "scan" && !reduce && !light;
      const beamY = beamOn ? -0.05 + (1.2 * ((t % 2.6) / 2.6)) : -9;
      for (const m of pointMats) {
        m.uniforms.uTime.value = t;
        m.uniforms.uBeam.value = beamY;
        m.uniforms.uTwinkle.value = reduce ? 0 : 1;
        m.uniforms.uDim.value = dim;
      }
      dustMat.uniforms.uDrift.value = reduce ? 0 : light ? 0.12 : 0.07;
      if (orbitA && orbitB) {
        // the orbit rings breathe: a slow tilt, never a spin (their back and front halves are fixed)
        const w = reduce ? 0 : t;
        orbitA.rotation.set(0.3 + 0.05 * Math.sin(w * 0.5), 0, -0.34 + 0.05 * Math.sin(w * 0.37 + 1));
        orbitB.rotation.set(0.52 + 0.05 * Math.sin(w * 0.43 + 2), 0, 0.4 + 0.05 * Math.sin(w * 0.31));
      }
      gridMat.uniforms.uTime.value = t;
      gridMat.uniforms.uAmp.value = reduce ? 0.018 : p.mode === "scan" ? 0.05 : 0.03;
      beamGroup.visible = beamOn;
      beamGroup.position.y = RIG_Y + beamY;
      wireMat.opacity = wireOpacity * dim;

      renderer.render(scene, camera);
      updateTags();
    };

    const updateTags = () => {
      const tags = propsRef.current.tags;
      if (!tags) return;
      spinner.updateMatrixWorld();
      m4.copy(camera.matrixWorldInverse);
      const centre = tmp.set(0, 0.5 + RIG_Y, 0).applyMatrix4(spinner.matrixWorld).applyMatrix4(m4);
      const centreDepth = centre.z;
      // light theme: the hand length is a vertical bracket on the right of the hand, not a label on a joint
      let handRight = 0;
      if (light && tags.some((t) => t.between)) {
        current.forEach((j) => {
          const v = tmp.set(j.x, j.y + RIG_Y, j.z).applyMatrix4(spinner.matrixWorld).project(camera);
          handRight = Math.max(handRight, (v.x * 0.5 + 0.5) * width);
        });
      }
      const spots = tags.map((tag, i) => {
        if (light && tag.between) {
          const [a, b] = tag.between;
          const ja = current[a];
          const jb = current[b];
          const el = tagEls.current[i];
          if (!ja || !jb || !el) return null;
          const ya = (-tmp.set(ja.x, ja.y + RIG_Y, ja.z).applyMatrix4(spinner.matrixWorld).project(camera).y * 0.5 + 0.5) * height;
          const yb = (-tmp.set(jb.x, jb.y + RIG_Y, jb.z).applyMatrix4(spinner.matrixWorld).project(camera).y * 0.5 + 0.5) * height;
          const box = bracketBox({ y1: ya, y2: yb, handRight, width, height });
          el.style.height = `${box.height.toFixed(1)}px`;
          el.style.transform = `translate(${box.x.toFixed(1)}px, ${box.top.toFixed(1)}px) translateX(-100%)`;
          el.style.opacity = "1";
          return null;
        }
        const j = current[tag.joint];
        if (!j) return null;
        const v = tmp.set(j.x, j.y + RIG_Y, j.z).applyMatrix4(spinner.matrixWorld);
        const view = v.clone().applyMatrix4(camera.matrixWorldInverse);
        v.project(camera);
        return {
          i,
          x: (v.x * 0.5 + 0.5) * width,
          y: (-v.y * 0.5 + 0.5) * height,
          hidden: view.z < centreDepth - 0.28 /* farther from the camera than the hand's middle */ || Math.abs(v.x) > 0.96 || Math.abs(v.y) > 0.96,
        };
      });
      // Labels are placed left to right; each one rises until it clears the labels already placed
      // (fingertips differ in height, so a fixed step by rank would still collide).
      const order = spots.filter((s): s is NonNullable<typeof s> => !!s).sort((a, b) => a.x - b.x);
      const placed: { x: number; y: number; w: number }[] = [];
      const GAP = light ? 7 : 3;
      order.forEach((s) => {
        const el = tagEls.current[s.i];
        if (!el) return;
        const w = el.offsetWidth || 90;
        const h = el.offsetHeight || 24;
        let top = s.y - 10 - h;
        for (let guard = 0; guard < 8; guard++) {
          const hit = placed.find((p) => Math.abs(p.x - s.x) < (p.w + w) / 2 + GAP && Math.abs(p.y - top) < h + GAP);
          if (!hit) break;
          top = hit.y - h - GAP;
        }
        top = Math.max(4, top); // never above the stage
        placed.push({ x: s.x, y: top, w });
        el.style.setProperty("--lead", `${Math.max(8, s.y - top - h)}px`);
        el.style.transform = `translate(${s.x.toFixed(1)}px, ${top.toFixed(1)}px) translateX(-50%)`;
        el.style.opacity = s.hidden ? "0" : "1";
      });
    };

    const loopWanted = () => !reduce && visible && !document.hidden && !lost;
    const tick = (now: number) => {
      raf = 0;
      if (!loopWanted()) {
        looping = false;
        return;
      }
      const cap = propsRef.current.mode === "live" ? LIVE_FPS : phone ? 40 : 60;
      if (now - lastFrame >= 1000 / cap - 2) frame(now);
      raf = requestAnimationFrame(tick);
    };
    const start = () => {
      if (looping || !loopWanted()) return;
      looping = true;
      lastFrame = 0;
      raf = requestAnimationFrame(tick);
    };
    function requestRender() {
      if (looping || raf || lost) return;
      raf = requestAnimationFrame((n) => {
        raf = 0;
        frame(n);
      });
    }

    const io = new IntersectionObserver((entries) => {
      visible = entries[entries.length - 1]?.isIntersecting ?? true;
      if (visible) start();
    });
    io.observe(mount);
    const onVisibility = () => {
      if (!document.hidden) start();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const onLost = (e: Event) => {
      e.preventDefault();
      lost = true;
      setFailed(true);
    };
    canvas.addEventListener("webglcontextlost", onLost);

    resize();
    requestRender();
    start();

    return () => {
      lost = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("webglcontextlost", onLost);
      for (const g of [handGeo, dustGeo, wireGeo, grid.geometry, beam.geometry, beamFill.geometry]) g.dispose();
      for (const m of [handMat, dustMat, reflectMat, wireMat, beamMat, gridMat, beamFill.material as MeshBasicMaterial]) m.dispose();
      for (const d of lightDispose) d.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    };
  }, []);

  if (failed) return <div className="hand-stage-fallback" aria-hidden="true" />;
  return (
    <>
      <div ref={mountRef} className="hand-stage-gl" />
      {props.tags && props.tags.length > 0 && (
        <div className="hand-stage-tags" aria-hidden="true">
          {props.tags.map((tag, i) => {
            // light theme: "Index 53 mm" is drawn as NAME: value; the text content stays the label
            const lightTag = props.theme === "light" && props.mode !== "live";
            const { name, value } = lightTag ? splitLabel(tag.label) : { name: tag.label, value: "" };
            const cls = `hand-stage-tag${lightTag && tag.between ? " hand-stage-tag--bracket" : ""}${lightTag && tag.emphasis ? " hand-stage-tag--em" : ""}`;
            return (
              <span key={`${tag.joint}-${tag.between ? tag.between.join("_") : ""}`} ref={(el) => void (tagEls.current[i] = el)} className={cls}>
                {lightTag && value ? (
                  <span className="hand-stage-tag-text">
                    <span className="hand-stage-tag-name">{name}</span> <span className="hand-stage-tag-val">{value}</span>
                  </span>
                ) : (
                  tag.label
                )}
              </span>
            );
          })}
        </div>
      )}
    </>
  );
}
