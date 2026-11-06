// The camera view as a 3D measuring display: a transparent layer over the live video that draws a luminous
// 3D hand exactly where the real hand is, with measuring rails along the fingers, a hand-length rail beside
// the hand and a scanning sweep. Loaded lazily with the rest of the scene (HandStage.tsx).
//
// Two looks, eased between (``onBlack``): over the live picture the points keep a dark rim and normal blending so
// they read on a bright table; over a picture blacked out round the hand they glow additively, like a hologram,
// with a bright rim, a halo of dust, glowing joints, soft rails and a luminous sweep. Three tones (``tone``) recolour
// it: idle (cyan and blue), ok (cool green-cyan) and a paler blue when the pose needs fixing (palette.ts).
//
// Round the hand, like the reference picture: two thin luminous rings that tilt gently round it (one wide, one
// with a touch of gold; each split so its back half is drawn behind the hand and its front half over it), a bright
// bead running round each ring, and a light sprinkle of sparkles outside the silhouette. They are the first thing the
// performance guard drops (perfGuard.ts, plan.rings) and they only exist while a hand is tracked.
//
// It runs on top of live hand tracking on phones, so the budget is tight: pixel ratio at most 1.25, 30 frames a
// second, a few thousand points, and nothing allocated per frame in the pose loop.
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  LinearSRGBColorSpace,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  OrthographicCamera,
  Points,
  RingGeometry,
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
  fillNodes,
  fillRails,
  haloOf,
  hasDepth,
  mapToElement,
  nodeGlow,
  normalizeInto,
  orbitBead,
  orbitFrameOf,
  orbitPose,
  poseBounds,
  railSide,
  RING_A,
  RING_B,
  ringRadius,
  rimWeights,
  easeFrame,
  sparkleShell,
  triangle,
  type Bounds,
  type HandFrame,
  type OrbitFrame,
  type OrbitPose,
  type RailInfo,
} from "./overlayMath";
import { approach, assemble, LIGHT_HEX, roleAt, stepPalette, toneAccentRgb, toneMotion, toneTarget } from "./palette";
import { DEFAULT_BUDGET, PerfGuard, type Budget, type Plan } from "./perfGuard";

const NAVY = new Color("#031a33"); // the dark edge that keeps the layer readable on a bright picture
const FPS = 30;
const SWEEP_S = 1.6;
const FADE_IN_S = 0.3;
const ASSEMBLE_MS = 300;
const TONE_SETTLE_MS = 250;
const BLACK_SETTLE_MS = 300;
const HALO_SHARE = 0.22; // dust round the hand, as a share of the points on it
const Z_GAIN = 1.35; // the relief is exaggerated a little so a tilted hand reads as 3D
const COUNT_PHONE = 3000;
const COUNT_LARGE = 5000;
const SPARKLES_PHONE = 70; // the sprinkle outside the silhouette (a few dozen read as dust, more as noise)
const SPARKLES_LARGE = 120;
const RING_SEGMENTS = 64; // per half ring
const RING_SETTLE_MS = 220; // the rings follow the hand a little behind its tracking jitter
/** The layers of an orbit ring, from the one underneath to the top: width (a share of the ring's radius), opacity and
 *  which colour. ``rim`` is a navy edge that keeps the ring readable on a bright picture; ``halo`` is the tone's
 *  glow (the gold of the second ring), ``body`` the tone's blue, ``core`` white-hot. */
const RING_LAYERS: readonly (readonly [number, number, "rim" | "halo" | "body" | "core"])[] = [
  [0.046, 0.4, "rim"],
  [0.17, 0.1, "halo"],
  [0.08, 0.22, "halo"],
  [0.032, 0.8, "body"],
  [0.014, 1, "core"],
];
const BEAD_SPEED = [0.075, -0.06] as const; // turns a second, the two rings running opposite ways
const BEAD_PHASE = [0.2, 0.65] as const;

const VERT = /* glsl */ `
  attribute float aGlow;
  attribute float aSeed;
  attribute float aRim;
  uniform float uTime;
  uniform float uPx;
  uniform float uBeam;
  uniform float uTwinkle;
  uniform float uAssemble;
  uniform float uBlack;
  uniform float uDrift;
  varying float vGlow;
  varying float vBeam;
  varying float vTw;
  varying float vNear;
  varying float vRim;
  void main() {
    float s = aSeed * 6.2831;
    vec3 p = position;
    // sparkles drift a little where they are (the hand's own points have uDrift 0)
    p.xy += uDrift * vec2(sin(uTime * 0.6 + s * 3.0), cos(uTime * 0.5 + s * 2.0));
    // a hand that has just appeared: the points start a little way out and converge on it
    if (uAssemble > 0.001) {
      vec3 dir = p - vec3(0.0, 0.45, 0.0) + 0.4 * vec3(cos(s * 3.1), sin(s * 2.3), cos(s * 1.7));
      p += normalize(dir) * uAssemble * 0.2;
    }
    float d = p.y - uBeam;
    vBeam = exp(-d * d * 260.0);
    vTw = mix(1.0, 0.7 + 0.3 * sin(uTime * 2.4 + s * 5.0), uTwinkle);
    vGlow = aGlow;
    vRim = aRim;
    vNear = clamp(position.z / 0.3, -1.0, 1.0);
    float size = 0.75 + 0.5 * fract(aSeed * 17.31); // every point a little different
    gl_PointSize = uPx * size * (0.7 + aGlow * 1.1 + vBeam * mix(1.0, 0.45, uBlack) + aRim * 0.5 * uBlack) * (1.0 + 0.35 * vNear);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uDeep;
  uniform vec3 uMid;
  uniform vec3 uGlow;
  uniform vec3 uSpark;
  uniform float uAlpha;
  uniform float uFade;
  uniform float uBlack;
  varying float vGlow;
  varying float vBeam;
  varying float vTw;
  varying float vNear;
  varying float vRim;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float r = length(c) * 2.0;
    if (r > 1.0) discard;
    // the edge of the hand and the fingertips, knuckles and creases glow most
    float g = clamp(vGlow * vTw + vBeam * mix(0.7, 0.4, uBlack) + vRim * 0.45 * uBlack, 0.0, 1.4);
    vec3 col = mix(uDeep, uMid, smoothstep(0.0, 0.3, g));
    col = mix(col, uGlow, smoothstep(0.25, 0.7, g));
    col = mix(col, uSpark, smoothstep(0.7, 1.2, g) * 0.85);
    // a dark rim round each point: blue and cyan alone vanish on a white table or a bright window (not needed on black)
    col = mix(col, vec3(0.012, 0.1, 0.2), smoothstep(0.45, 0.95, r) * 0.8 * (1.0 - uBlack));
    float soft = mix(1.0 - smoothstep(0.7, 1.0, r), exp(-r * r * 3.2), uBlack);
    float alpha = soft * clamp(0.4 + 0.6 * g, 0.0, 1.0) * (0.8 + 0.25 * vNear) * uAlpha * uFade;
    // on the live picture: normal (premultiplied) blending. On black: less coverage and more light, so that
    // overlapping points add up like a hologram.
    gl_FragColor = vec4(col * alpha * mix(1.0, 1.55, uBlack), alpha * mix(1.0, 0.55, uBlack));
  }
`;

// The soft band of the scanning sweep: a quad across the hand, brightest along its middle line.
const BAND_VERT = /* glsl */ `
  attribute float aV;
  varying float vV;
  varying float vX;
  void main() {
    vV = aV;
    vX = position.x;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const BAND_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOp;
  uniform vec2 uXRange;
  varying float vV;
  varying float vX;
  void main() {
    float across = exp(-vV * vV * 3.2);
    float u = (vX - uXRange.x) / max(1e-4, uXRange.y - uXRange.x);
    float ends = smoothstep(0.0, 0.12, u) * (1.0 - smoothstep(0.88, 1.0, u));
    float a = across * ends * uOp;
    gl_FragColor = vec4(uColor * a, a * 0.5);
  }
`;

// The palette is shared by every material: one set of colours, eased on tone changes (palette.ts).
const PAL = {
  uDeep: { value: new Color() },
  uMid: { value: new Color() },
  uGlow: { value: new Color() },
  uSpark: { value: new Color() },
};
const LINE = { wire: new Color(), rail: new Color(), pale: new Color() };

/** Put a palette array (linear components, ROLES order) into the shared colours. */
function applyPalette(pal: Float32Array): void {
  const at = (role: "deep" | "mid" | "glow" | "spark" | "wire" | "rail" | "pale", c: Color) => {
    const i = roleAt(role);
    c.setRGB(pal[i], pal[i + 1], pal[i + 2], LinearSRGBColorSpace);
  };
  at("deep", PAL.uDeep.value);
  at("mid", PAL.uMid.value);
  at("glow", PAL.uGlow.value);
  at("spark", PAL.uSpark.value);
  at("wire", LINE.wire);
  at("rail", LINE.rail);
  at("pale", LINE.pale);
}

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
      uAssemble: { value: 0 },
      uBlack: { value: 0 },
      uDrift: { value: 0 },
      uDeep: PAL.uDeep,
      uMid: PAL.uMid,
      uGlow: PAL.uGlow,
      uSpark: PAL.uSpark,
      uAlpha: { value: alpha },
      uFade: { value: 0 },
    },
  });
}

function lineMaterial(color: Color, opacity: number): LineBasicMaterial {
  return new LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });
}

interface RingLayerMat {
  mat: MeshBasicMaterial;
  kind: "rim" | "halo" | "body" | "core";
  gold: boolean;
  opacity: number;
}

/** One luminous orbit ring at unit radius in its own XY plane: every layer is two half rings, so that the half on
 *  the near side (y > 0, which the tilt turns towards the viewer) can be drawn over the hand and the other behind it. */
function orbitRing(gold: boolean): { group: Group; layers: RingLayerMat[]; geos: RingGeometry[] } {
  const group = new Group();
  group.rotation.order = "ZXY"; // tilt about x first, then turn in the screen plane
  const layers: RingLayerMat[] = [];
  const geos: RingGeometry[] = [];
  RING_LAYERS.forEach(([w, opacity, kind], i) => {
    const mat = new MeshBasicMaterial({ color: kind === "core" ? "#ffffff" : NAVY, transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: DoubleSide });
    layers.push({ mat, kind, gold, opacity });
    for (const front of [false, true]) {
      const geo = new RingGeometry(1 - w / 2, 1 + w / 2, RING_SEGMENTS, 1, front ? 0 : Math.PI, Math.PI);
      geos.push(geo);
      const m = new Mesh(geo, mat);
      m.renderOrder = front ? 3 + i * 0.01 : -2 + i * 0.01;
      m.frustumCulled = false;
      group.add(m);
    }
  });
  return { group, layers, geos };
}

/** A single point that runs round a ring (the bright bead): a one-vertex Points with the layer's point shader. */
function beadPoints(): { points: Points; pos: Float32Array; posAttr: BufferAttribute; glow: Float32Array; glowAttr: BufferAttribute; mat: ShaderMaterial; geo: BufferGeometry } {
  const pos = new Float32Array(3);
  const posAttr = new BufferAttribute(pos, 3);
  posAttr.setUsage(35048);
  const glow = new Float32Array([1]);
  const glowAttr = new BufferAttribute(glow, 1);
  glowAttr.setUsage(35048);
  const geo = new BufferGeometry();
  geo.setAttribute("position", posAttr);
  geo.setAttribute("aGlow", glowAttr);
  geo.setAttribute("aSeed", new BufferAttribute(new Float32Array([0.5]), 1));
  geo.setAttribute("aRim", new BufferAttribute(new Float32Array(1), 1));
  const mat = pointMaterial(1.1);
  const points = new Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 4;
  return { points, pos, posAttr, glow, glowAttr, mat, geo };
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
    // The halo: a second, thinner sample pushed out from the skin (dust round the hand).
    const haloCount = Math.round(count * HALO_SHARE);
    const haloSampled = haloOf(sampleHand(generic, haloCount, 23), rng(29));
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
    handGeo.setAttribute("aRim", new BufferAttribute(rimWeights(sampled), 1));
    const handMat = pointMaterial(0.8);
    const handPoints = new Points(handGeo, handMat);

    const haloPositions = new Float32Array(haloCount * 3);
    const haloPosAttr = new BufferAttribute(haloPositions, 3);
    haloPosAttr.setUsage(35048);
    const haloSeed = new Float32Array(haloCount);
    for (let i = 0; i < haloCount; i++) haloSeed[i] = rand();
    const haloGeo = new BufferGeometry();
    haloGeo.setAttribute("position", haloPosAttr);
    haloGeo.setAttribute("aGlow", new BufferAttribute(haloSampled.glow, 1));
    haloGeo.setAttribute("aSeed", new BufferAttribute(haloSeed, 1));
    haloGeo.setAttribute("aRim", new BufferAttribute(new Float32Array(haloCount), 1));
    const haloMat = pointMaterial(0.55);
    const haloPoints = new Points(haloGeo, haloMat);

    // glowing nodes at the 21 joints: a bright core and a big soft glow round it (on black only)
    const nodeArr = new Float32Array(63);
    const nodeAttr = new BufferAttribute(nodeArr, 3);
    nodeAttr.setUsage(35048);
    const nodeSeed = new Float32Array(21);
    for (let i = 0; i < 21; i++) nodeSeed[i] = rand();
    const nodeGeo = new BufferGeometry();
    nodeGeo.setAttribute("position", nodeAttr);
    nodeGeo.setAttribute("aGlow", new BufferAttribute(nodeGlow(), 1));
    nodeGeo.setAttribute("aSeed", new BufferAttribute(nodeSeed, 1));
    nodeGeo.setAttribute("aRim", new BufferAttribute(new Float32Array(21), 1));
    const nodeMat = pointMaterial(0.9);
    const nodeGlowMat = pointMaterial(0.22);
    const nodes = new Points(nodeGeo, nodeMat);
    const nodeHalos = new Points(nodeGeo, nodeGlowMat);

    const wireArr = new Float32Array(handWire(generic));
    const wireAttr = new BufferAttribute(wireArr, 3);
    wireAttr.setUsage(35048);
    const wireGeo = new BufferGeometry();
    wireGeo.setAttribute("position", wireAttr);
    const wireMat = lineMaterial(LINE.wire, 0.62);
    const wire = new LineSegments(wireGeo, wireMat);

    const fingerArr = new Float32Array(FINGER_RAIL_VERTS * 3);
    const fingerAttr = new BufferAttribute(fingerArr, 3);
    fingerAttr.setUsage(35048);
    const fingerGeo = new BufferGeometry();
    fingerGeo.setAttribute("position", fingerAttr);
    const fingerMat = lineMaterial(LINE.rail, 0.95);
    const fingerRails = new LineSegments(fingerGeo, fingerMat);

    const handRailArr = new Float32Array(HAND_RAIL_VERTS * 3);
    const handRailAttr = new BufferAttribute(handRailArr, 3);
    handRailAttr.setUsage(35048);
    const handRailGeo = new BufferGeometry();
    handRailGeo.setAttribute("position", handRailAttr);
    const handRailMat = lineMaterial(LINE.pale, 1);
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
    beadGeo.setAttribute("aRim", new BufferAttribute(new Float32Array(BEAD_COUNT), 1));
    const beadMat = pointMaterial(1.05);
    const beads = new Points(beadGeo, beadMat);
    const beadGlowMat = pointMaterial(0.2); // the soft glow of the rails (on black only)
    const beadHalos = new Points(beadGeo, beadGlowMat);

    const beamArr = new Float32Array(12);
    const beamAttr = new BufferAttribute(beamArr, 3);
    beamAttr.setUsage(35048);
    const beamGeo = new BufferGeometry();
    beamGeo.setAttribute("position", beamAttr);
    const beamMat = lineMaterial(LINE.pale, 0.9);
    const beam = new LineSegments(beamGeo, beamMat);

    // the soft luminous band of the sweep (on black): a quad across the hand
    const bandArr = new Float32Array(12);
    const bandAttr = new BufferAttribute(bandArr, 3);
    bandAttr.setUsage(35048);
    const bandGeo = new BufferGeometry();
    bandGeo.setAttribute("position", bandAttr);
    bandGeo.setAttribute("aV", new BufferAttribute(new Float32Array([-1, -1, 1, 1]), 1));
    bandGeo.setIndex([0, 1, 2, 0, 2, 3]);
    const bandMat = new ShaderMaterial({
      vertexShader: BAND_VERT,
      fragmentShader: BAND_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      premultipliedAlpha: true,
      side: DoubleSide,
      uniforms: { uColor: { value: LINE.pale }, uOp: { value: 0 }, uXRange: { value: [0, 1] } },
    });
    const band = new Mesh(bandGeo, bandMat);

    // ---- the orbit rings, their beads and the sparkles: all in hand space, centred on the hand's box
    const orbits = new Group();
    orbits.visible = false;
    const ringA = orbitRing(false);
    const ringB = orbitRing(true);
    const rings = [ringA, ringB] as const;
    const beads2 = [beadPoints(), beadPoints()] as const;
    rings.forEach((r, k) => r.group.add(beads2[k].points));
    orbits.add(ringA.group, ringB.group);
    const sparkCount = phone || lowEnd ? SPARKLES_PHONE : SPARKLES_LARGE;
    const sparkPos = new Float32Array(sparkCount * 3);
    const sparkGlow = new Float32Array(sparkCount);
    const sparkSeed = new Float32Array(sparkCount);
    sparkleShell(sparkCount, rng(41), sparkPos, sparkGlow, sparkSeed);
    const sparkGeo = new BufferGeometry();
    sparkGeo.setAttribute("position", new BufferAttribute(sparkPos, 3));
    sparkGeo.setAttribute("aGlow", new BufferAttribute(sparkGlow, 1));
    sparkGeo.setAttribute("aSeed", new BufferAttribute(sparkSeed, 1));
    sparkGeo.setAttribute("aRim", new BufferAttribute(new Float32Array(sparkCount), 1));
    const sparkMat = pointMaterial(0.8);
    const sparkles = new Points(sparkGeo, sparkMat);
    sparkles.frustumCulled = false;
    sparkles.renderOrder = 1;
    orbits.add(sparkles);
    const ringMats = [ringA, ringB].flatMap((r) => r.layers);
    const orbitPoints = [sparkMat, beads2[0].mat, beads2[1].mat];
    const ringFrame: OrbitFrame = { cx: 0, cy: 0.5, hw: 0.35, hh: 0.55 };
    const ringTarget: OrbitFrame = { cx: 0, cy: 0.5, hw: 0.35, hh: 0.55 };
    const ringPose: OrbitPose = { tilt: 0, turn: 0 };
    const beadTmp = { x: 0, y: 0, glow: 1 };
    let ringsShown = false; // the rings were drawn last frame (a hand that has just appeared starts them in place)
    let ringBlendBlack = false;
    const GOLD = new Color(LIGHT_HEX.ringGold);
    const recolorRings = () => {
      for (const l of ringMats) {
        if (l.kind === "halo") l.mat.color.copy(l.gold ? GOLD : PAL.uGlow.value);
        else if (l.kind === "body") l.mat.color.copy(PAL.uMid.value);
        else if (l.kind === "rim") l.mat.color.copy(NAVY);
      }
    };
    recolorRings();

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
    for (const o of [...shadows, haloPoints, handPoints, band, wire, fingerRails, handRail, beadHalos, beads, nodeHalos, nodes, beam, orbits]) {
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
    // the colours (eased between tones), the black-picture mix and the sweep's phase
    const palCur = new Float32Array(toneTarget(propsRef.current.tone));
    applyPalette(palCur);
    let paletteDirty = true;
    let blackMix = propsRef.current.onBlack ? 1 : 0;
    let blendBlack = false; // whether the line materials are in their additive state
    let sweepPhase = 0;
    let appearedAt = -1e9;
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
    // A step down of the guard: no halo or sweep, no wireframe or nodes, half the points, a lower frame rate, or off.
    const applyPlan = (next: Plan) => {
      plan = next;
      active = next.pointFraction >= 1 ? sampled : { ...sampled, count: Math.floor(count * next.pointFraction) };
      handGeo.setDrawRange(0, active.count);
      haloPoints.visible = next.halo;
      if (!next.rings) orbits.visible = false;
      wire.visible = next.wire;
      shadows[0].visible = next.wire;
      nodes.visible = next.nodes;
      nodeHalos.visible = next.nodes;
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

      // in over 0.3 s when a hand is found (its points converge on it), out over a quarter of a second when lost
      const want = valid || now - lastSeen < 80;
      if (want && fade === 0) appearedAt = now;
      fade = want ? Math.min(1, fade + dt / FADE_IN_S) : Math.max(0, fade - dt / 0.25);

      // the tone's colours ease in over a quarter of a second; the black-picture look over 0.3 s
      if (stepPalette(palCur, toneTarget(p.tone), dt * 1000, TONE_SETTLE_MS) || paletteDirty) {
        applyPalette(palCur);
        wireMat.color.copy(LINE.wire);
        fingerMat.color.copy(LINE.rail);
        handRailMat.color.copy(LINE.pale);
        beamMat.color.copy(LINE.pale);
        recolorRings();
        paletteDirty = false;
      }
      blackMix = approach(blackMix, p.onBlack ? 1 : 0, dt * 1000, BLACK_SETTLE_MS);
      const additive = blackMix > 0.5;
      if (additive !== blendBlack) {
        blendBlack = additive;
        const mode = additive ? AdditiveBlending : NormalBlending;
        for (const m of [wireMat, fingerMat, handRailMat, beamMat]) {
          m.blending = mode;
          m.needsUpdate = true;
        }
      }
      if (additive !== ringBlendBlack) {
        ringBlendBlack = additive; // the ring layers glow additively on black, and are drawn normally (with their navy rim) otherwise
        for (const l of ringMats) {
          l.mat.blending = additive ? AdditiveBlending : NormalBlending;
          l.mat.needsUpdate = true;
        }
      }
      const motion = toneMotion(p.tone);

      let show = false;
      if (havePose && fade > 0.002) {
        const p0 = stats ? performance.now() : 0;
        show = normalizeInto(cur, pose, generic, useZ, Z_GAIN, hf);
        if (show) {
          poseSamples(active, pose, positions);
          posAttr.needsUpdate = true;
          // the black look's extras cost nothing on the live picture; the dust is posed every other frame
          // (a soft shell a frame behind is not seen), the nodes every frame
          if (blackMix > 0.02) {
            if (plan.halo && frameNo % 2 === 1) {
              poseSamples(haloSampled, pose, haloPositions);
              haloPosAttr.needsUpdate = true;
            }
            if (plan.nodes) {
              fillNodes(pose, nodeArr);
              nodeAttr.needsUpdate = true;
            }
          }
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
          const sweeping = !reduce && plan.sweep;
          if (sweeping) sweepPhase += (dt * motion.sweepSpeed) / SWEEP_S;
          const by = sweeping ? bounds.minY + (bounds.maxY - bounds.minY) * triangle(sweepPhase, 1) : -99;
          const x0 = bounds.minX - 0.1;
          const x1 = bounds.maxX + 0.1;
          beamArr[0] = x0; beamArr[1] = by; beamArr[2] = 0.08;
          beamArr[3] = x1; beamArr[4] = by; beamArr[5] = 0.08;
          beamArr[6] = x0; beamArr[7] = by + 0.014; beamArr[8] = 0.08;
          beamArr[9] = x1; beamArr[10] = by + 0.014; beamArr[11] = 0.08;
          beamAttr.needsUpdate = true;
          beam.visible = sweeping && blackMix < 0.5;
          // the soft band (on black): about a tenth of a hand tall, across the hand
          const bh = 0.07;
          bandArr[0] = x0; bandArr[1] = by - bh; bandArr[2] = 0.07;
          bandArr[3] = x1; bandArr[4] = by - bh; bandArr[5] = 0.07;
          bandArr[6] = x1; bandArr[7] = by + bh; bandArr[8] = 0.07;
          bandArr[9] = x0; bandArr[10] = by + bh; bandArr[11] = 0.07;
          bandAttr.needsUpdate = true;
          bandMat.uniforms.uXRange.value[0] = x0;
          bandMat.uniforms.uXRange.value[1] = x1;
          bandMat.uniforms.uOp.value = sweeping ? 0.5 * motion.sweepGain * blackMix * fade : 0;
          band.visible = sweeping && blackMix > 0.02;
          const swept = reduce ? 0 : assemble(now - appearedAt, ASSEMBLE_MS);

          hand.position.set(hf.x0, hf.y0, 0);
          hand.scale.set(hf.len, -hf.len, hf.len);
          const px = Math.min(3.4, Math.max(1.6, hf.len * 0.0078)) * dpr;
          handMat.uniforms.uPx.value = px;
          haloMat.uniforms.uPx.value = px * 1.7;
          beadMat.uniforms.uPx.value = px * 1.8;
          beadGlowMat.uniforms.uPx.value = px * 5;
          nodeMat.uniforms.uPx.value = px * 2.2;
          nodeGlowMat.uniforms.uPx.value = px * 6.5;
          for (const m of [handMat, haloMat, beadMat, beadGlowMat, nodeMat, nodeGlowMat]) {
            m.uniforms.uTime.value = t;
            m.uniforms.uBeam.value = by;
            m.uniforms.uTwinkle.value = reduce || !plan.sweep ? 0 : 1;
            m.uniforms.uFade.value = fade;
            m.uniforms.uBlack.value = blackMix;
            m.uniforms.uAssemble.value = m === handMat || m === haloMat ? swept : 0;
          }
          // ---- the orbit rings: round the hand's box, eased, tilting gently; beads run round them; sparkles drift
          const ringsOn = plan.rings;
          orbits.visible = ringsOn;
          if (ringsOn) {
            orbitFrameOf(bounds, ringTarget);
            easeFrame(ringFrame, ringTarget, dt * 1000, RING_SETTLE_MS, !ringsShown);
            orbits.position.set(ringFrame.cx, ringFrame.cy, 0);
            // a pose that needs fixing is dimmer and slower, like the sweep
            const gain = fade * (0.55 + 0.45 * motion.sweepGain);
            for (let k = 0; k < 2; k++) {
              const g = rings[k].group;
              g.scale.setScalar(ringRadius(ringFrame, k === 0 ? RING_A : RING_B));
              orbitPose(t, k as 0 | 1, ringPose);
              g.rotation.set(ringPose.tilt, 0, ringPose.turn);
              orbitBead(t, BEAD_SPEED[k], BEAD_PHASE[k], beadTmp);
              const bd = beads2[k];
              bd.pos[0] = beadTmp.x;
              bd.pos[1] = beadTmp.y;
              bd.glow[0] = beadTmp.glow;
              bd.posAttr.needsUpdate = true;
              bd.glowAttr.needsUpdate = true;
            }
            for (const l of ringMats) l.mat.opacity = l.opacity * gain * (l.kind === "rim" ? 1 - blackMix : 1);
            sparkles.scale.set(ringFrame.hw, ringFrame.hh, 0.5);
            const beadPx = px * 4;
            beads2[0].mat.uniforms.uPx.value = beadPx;
            beads2[1].mat.uniforms.uPx.value = beadPx;
            sparkMat.uniforms.uPx.value = px * 0.9;
            for (const m of orbitPoints) {
              m.uniforms.uTime.value = t;
              m.uniforms.uBeam.value = -99;
              m.uniforms.uTwinkle.value = reduce ? 0 : 1;
              m.uniforms.uFade.value = gain;
              m.uniforms.uBlack.value = blackMix;
            }
            sparkMat.uniforms.uDrift.value = reduce ? 0 : 0.05;
          }
          ringsShown = ringsOn;
          // the soft glow layers and the wireframe's lower alpha belong to the black look
          const glowOn = plan.nodes && blackMix > 0.02;
          beadHalos.visible = glowOn;
          nodeHalos.visible = glowOn;
          nodes.visible = glowOn;
          haloMat.uniforms.uFade.value = fade * blackMix; // the dust belongs to the black look
          haloPoints.visible = plan.halo && blackMix > 0.02;
          beadGlowMat.uniforms.uFade.value = fade * blackMix;
          nodeGlowMat.uniforms.uFade.value = fade * blackMix;
          nodeMat.uniforms.uFade.value = fade * blackMix;
          wireMat.opacity = (0.62 - 0.22 * blackMix) * fade;
          fingerMat.opacity = (0.95 - 0.15 * blackMix) * fade;
          handRailMat.opacity = fade;
          beamMat.opacity = 0.9 * fade * (blackMix > 0.02 ? 0.55 * motion.sweepGain : 1);
          shadowMat.opacity = 0.5 * fade * (1 - blackMix);
          const shade = blackMix < 0.97;
          for (let k = 0; k < shadows.length; k++) shadows[k].visible = shade && (k !== 0 || plan.wire);
        }
        if (stats) stats.poseMs += performance.now() - p0;
      }
      hand.visible = show;
      if (!show) ringsShown = false;

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
      for (const g of [handGeo, haloGeo, nodeGeo, wireGeo, fingerGeo, handRailGeo, beadGeo, beamGeo, bandGeo, sparkGeo, beads2[0].geo, beads2[1].geo, ...ringA.geos, ...ringB.geos]) g.dispose();
      for (const m of [handMat, haloMat, nodeMat, nodeGlowMat, beadMat, beadGlowMat, wireMat, fingerMat, handRailMat, beamMat, bandMat, shadowMat, sparkMat, beads2[0].mat, beads2[1].mat, ...ringMats.map((l) => l.mat)]) m.dispose();
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
        <div className="hand-stage-tags" aria-hidden="true" style={{ ["--tag-rgb" as string]: toneAccentRgb(props.tone) }}>
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
