// The three.js scene of the experimental mesh viewer (a lazy chunk: three.js is not in the main bundle).
//
// Built once per input (geometry, colour buffers, skeleton, grid); the display mode, colour mode and skeleton toggle only
// swap materials, copy a precomputed colour array into one attribute, or flip visibility, so toggling never re-creates
// geometry. TrackballControls turn the view freely (no pole clamp: the underside and every roll are reachable), zoom and
// pan; a headlight follows the camera so every side is lit. Rendering is on demand (only when the view changes) and stops
// while the card is off screen or the tab is hidden. Everything GPU-side is disposed on unmount.
import { useEffect, useRef } from "react";
import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh as ThreeMesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Quaternion,
  RGBAFormat,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  CanvasTexture,
  Vector3,
  WebGLRenderer,
} from "three";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";
import type { MeshSceneProps } from "./MeshViewer";
import { MV_LOST } from "./MeshViewer";
import {
  confidenceColours,
  HAND_BONES,
  homeView,
  PLAIN_SURFACE,
  POINT_PLAIN,
  SKELETON_COLOUR,
  SKELETON_JOINT,
  supportColours,
  type Bounds,
  type ColourMode,
  type V3,
} from "./meshViewerModel";

const FOV = 35;

/** sRGB 0..1 to linear in place (vertex colours are linear in three.js; the legend's hex colours are sRGB). */
function toLinear(a: Float32Array): Float32Array {
  for (let i = 0; i < a.length; i++) {
    const c = a[i];
    a[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return a;
}

/** A soft round dot for the point sprites (alpha-tested, so no sorting is needed). */
function dotTexture(): DataTexture {
  const n = 32;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2);
      const i = (y * n + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = d <= 1 ? 255 : 0;
    }
  const t = new DataTexture(data, n, n, RGBAFormat);
  t.needsUpdate = true;
  return t;
}

function labelSprite(text: string, colour: string): { sprite: Sprite; dispose(): void } {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (g) {
    g.font = "700 46px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = colour;
    g.fillText(text, 32, 34);
  }
  const tex = new CanvasTexture(c);
  const mat = new SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new Sprite(mat);
  sprite.scale.set(0.95, 0.95, 0.95);
  return { sprite, dispose: () => (tex.dispose(), mat.dispose()) };
}

interface Content {
  group: Group;
  surface: ThreeMesh | null;
  wire: ThreeMesh | null;
  meshPoints: Points | null;
  cloud: Points | null;
  skeleton: Group | null;
  mats: {
    surfPlain: MeshStandardMaterial;
    surfColour: MeshStandardMaterial;
    wirePlain: MeshBasicMaterial;
    wireColour: MeshBasicMaterial;
    mPtsPlain: PointsMaterial;
    mPtsColour: PointsMaterial;
    cPtsPlain: PointsMaterial;
    cPtsColour: PointsMaterial;
  };
  meshColour: BufferAttribute | null;
  meshBuffers: { support: Float32Array | null; confidence: Float32Array | null };
  meshKind: ColourMode | null;
  cloudColour: BufferAttribute | null;
  cloudBuffers: { own: Float32Array | null; support: Float32Array | null };
  cloudKind: string | null;
  disposables: { dispose(): void }[];
}

interface Core {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  controls: TrackballControls;
  content: Content | null;
  bounds: Bounds | null;
  dirty: boolean;
}

export default function MeshViewerGL(props: MeshSceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  live.current = props;
  const core = useRef<Core | null>(null);
  const firstReady = useRef(false);

  // ---- renderer, camera, controls, lights, gizmo: once per mount
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "default" });
    } catch (err) {
      live.current.onFail(`3D view unavailable: ${String((err as Error)?.message ?? err).slice(0, 80)}`);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);
    renderer.domElement.style.cssText = "display:block;width:100%;height:100%;touch-action:none;outline:none";

    const scene = new Scene();
    const camera = new PerspectiveCamera(FOV, 1, 0.1, 1000);
    camera.up.set(0, 0, 1);
    scene.add(camera);
    const hemi = new HemisphereLight(0xffffff, 0xc4d2ee, 1.15);
    hemi.position.set(0, 0, 1);
    scene.add(hemi);
    scene.add(new AmbientLight(0xffffff, 0.35));
    const head = new DirectionalLight(0xffffff, 1.55);
    head.position.set(0.45, 0.75, 0.2);
    const headTarget = new Object3D();
    headTarget.position.set(0, 0, -1);
    camera.add(head, headTarget);
    head.target = headTarget;

    const controls = new TrackballControls(camera, renderer.domElement);
    controls.rotateSpeed = 3.2;
    controls.zoomSpeed = 1.1;
    controls.panSpeed = 0.9;
    controls.staticMoving = true;
    controls.keys = ["", "", ""];

    // the axes gizmo (board axes x, y, z), drawn in a corner from the camera's orientation
    const gScene = new Scene();
    const gCam = new OrthographicCamera(-1.75, 1.75, 1.75, -1.75, 0.1, 10);
    const gDispose: { dispose(): void }[] = [];
    const axes: [V3, string][] = [
      [[1, 0, 0], "#d6336c"],
      [[0, 1, 0], "#2f9e44"],
      [[0, 0, 1], "#1f5eea"],
    ];
    axes.forEach(([d, colour], k) => {
      const geo = new BufferGeometry();
      geo.setAttribute("position", new BufferAttribute(Float32Array.from([0, 0, 0, d[0], d[1], d[2]]), 3));
      const mat = new LineBasicMaterial({ color: colour, depthTest: false });
      gScene.add(new LineSegments(geo, mat));
      const s = labelSprite("xyz"[k], colour);
      s.sprite.position.set(d[0] * 1.35, d[1] * 1.35, d[2] * 1.35);
      gScene.add(s.sprite);
      gDispose.push(geo, mat, s);
    });

    const c: Core = { renderer, scene, camera, controls, content: null, bounds: null, dirty: true };
    core.current = c;
    let visible = true;
    let interacting = false;
    controls.addEventListener("change", () => {
      c.dirty = true;
      if (interacting) {
        interacting = false;
        live.current.onViewChange("free");
      }
    });
    controls.addEventListener("start", () => (interacting = true));
    controls.addEventListener("end", () => (interacting = false));

    const resize = () => {
      const w = Math.max(1, el.clientWidth);
      const h = Math.max(1, el.clientHeight);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      controls.handleResize();
      c.dirty = true;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    const io = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
      if (visible) c.dirty = true;
    });
    io.observe(el);

    const onLost = (e: Event) => {
      e.preventDefault();
      live.current.onFail(MV_LOST);
    };
    renderer.domElement.addEventListener("webglcontextlost", onLost);

    renderer.setAnimationLoop(() => {
      if (!visible || document.hidden) return;
      controls.update();
      if (!c.dirty) return;
      c.dirty = false;
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setViewport(0, 0, w, h);
      renderer.render(scene, camera);
      // gizmo in the top-right corner
      const g = Math.min(92, Math.round(Math.min(w, h) * 0.24));
      gCam.position.copy(camera.position).sub(controls.target).setLength(4);
      gCam.up.copy(camera.up);
      gCam.lookAt(0, 0, 0);
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.setScissorTest(true);
      renderer.setScissor(w - g - 6, h - g - 6, g, g);
      renderer.setViewport(w - g - 6, h - g - 6, g, g);
      renderer.render(gScene, gCam);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, w, h);
      renderer.autoClear = true;
      const info = renderer.info;
      el.dataset.geometries = String(info.memory.geometries);
      el.dataset.renders = String(Number(el.dataset.renders ?? 0) + 1);
    });

    // keyboard: arrows turn about the screen axes (15 degrees), + / - zoom, 0 resets
    const q = new Quaternion();
    const onKey = (e: KeyboardEvent) => {
      const off = camera.position.clone().sub(controls.target);
      const up = camera.up.clone().normalize();
      const right = new Vector3().crossVectors(off, up).normalize();
      const step = (15 * Math.PI) / 180;
      let moved = true;
      if (e.key === "ArrowLeft") q.setFromAxisAngle(up, -step);
      else if (e.key === "ArrowRight") q.setFromAxisAngle(up, step);
      else if (e.key === "ArrowUp") q.setFromAxisAngle(right, -step);
      else if (e.key === "ArrowDown") q.setFromAxisAngle(right, step);
      else if (e.key === "+" || e.key === "=") (off.multiplyScalar(0.85), q.identity());
      else if (e.key === "-" || e.key === "_") (off.multiplyScalar(1 / 0.85), q.identity());
      else if (e.key === "0" || e.key === "Home") {
        e.preventDefault();
        home();
        live.current.onViewChange("home");
        return;
      } else moved = false;
      if (!moved) return;
      e.preventDefault();
      off.applyQuaternion(q);
      camera.up.applyQuaternion(q);
      camera.position.copy(controls.target).add(off);
      camera.lookAt(controls.target);
      controls.update();
      c.dirty = true;
      live.current.onViewChange("free");
    };
    el.addEventListener("keydown", onKey);

    // Distance that fits the bounding box's eight corners for this view direction (tighter than the bounding sphere for
    // a flat hand seen from the side), with a small margin.
    const fitDistance = (b: Bounds, toCamera: V3, up: V3) => {
      const tv = Math.tan((FOV * Math.PI) / 360);
      const th = tv * camera.aspect;
      const right: V3 = [up[1] * toCamera[2] - up[2] * toCamera[1], up[2] * toCamera[0] - up[0] * toCamera[2], up[0] * toCamera[1] - up[1] * toCamera[0]];
      let d = b.radius * 0.5;
      for (let k = 0; k < 8; k++) {
        const p: V3 = [(k & 1 ? b.max[0] : b.min[0]) - b.center[0], (k & 2 ? b.max[1] : b.min[1]) - b.center[1], (k & 4 ? b.max[2] : b.min[2]) - b.center[2]];
        const x = Math.abs(p[0] * right[0] + p[1] * right[1] + p[2] * right[2]);
        const y = Math.abs(p[0] * up[0] + p[1] * up[1] + p[2] * up[2]);
        const z = p[0] * toCamera[0] + p[1] * toCamera[1] + p[2] * toCamera[2];
        d = Math.max(d, z + x / th, z + y / tv);
      }
      return d * 1.12;
    };
    const look = (toCamera: V3, up: V3) => {
      const b = c.bounds;
      if (!b) return;
      const d = fitDistance(b, toCamera, up);
      controls.target.set(b.center[0], b.center[1], b.center[2]);
      camera.position.set(b.center[0] + toCamera[0] * d, b.center[1] + toCamera[1] * d, b.center[2] + toCamera[2] * d);
      camera.up.set(up[0], up[1], up[2]);
      camera.lookAt(controls.target);
      controls.update();
      c.dirty = true;
    };
    const home = () => {
      const h = homeView(live.current.frame);
      look(h.toCamera, h.up);
    };
    live.current.controlsRef.current = { reset: home, view: (p) => look(p.toCamera, p.up) };

    return () => {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      io.disconnect();
      el.removeEventListener("keydown", onKey);
      controls.dispose();
      if (c.content) disposeContent(c.content);
      for (const d of gDispose) d.dispose();
      renderer.domElement.removeEventListener("webglcontextlost", onLost);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      core.current = null;
      if (live.current.controlsRef.current) live.current.controlsRef.current = null;
    };
  }, []);

  // ---- content: rebuilt only when the data changes
  const { mesh, points, pointColors, pointLabels, confidence, support, landmarks, bounds, grid } = props;
  useEffect(() => {
    const c = core.current;
    if (!c) return;
    if (c.content) {
      c.scene.remove(c.content.group);
      disposeContent(c.content);
      c.content = null;
    }
    const r = bounds.radius;
    const group = new Group();
    const disposables: { dispose(): void }[] = [];
    const dot = dotTexture();
    disposables.push(dot);
    const pointsMat = (size: number, vertexColors: boolean) =>
      new PointsMaterial({ color: vertexColors ? 0xffffff : POINT_PLAIN, size, sizeAttenuation: true, map: dot, alphaTest: 0.5, vertexColors });
    const meshPtSize = Math.min(r * 0.02, Math.max(r * 0.006, 1.6 * Math.sqrt((4 * r * r) / Math.max(1, mesh ? mesh.vertices.length / 3 : 1))));
    const np = points ? points.length / 3 : 0;
    const cloudPtSize = Math.min(r * 0.02, Math.max(r * 0.005, 1.6 * Math.sqrt((4 * r * r) / Math.max(1, np))));
    const mats = {
      surfPlain: new MeshStandardMaterial({ color: PLAIN_SURFACE, roughness: 0.62, metalness: 0, side: DoubleSide }),
      surfColour: new MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0, side: DoubleSide, vertexColors: true }),
      wirePlain: new MeshBasicMaterial({ color: 0x2452c4, wireframe: true, transparent: true, opacity: 0.55 }),
      wireColour: new MeshBasicMaterial({ color: 0xffffff, wireframe: true, vertexColors: true, transparent: true, opacity: 0.85 }),
      mPtsPlain: pointsMat(meshPtSize, false),
      mPtsColour: pointsMat(meshPtSize, true),
      cPtsPlain: pointsMat(cloudPtSize, false),
      cPtsColour: pointsMat(cloudPtSize, true),
    };
    disposables.push(...Object.values(mats));

    let surface: ThreeMesh | null = null, wire: ThreeMesh | null = null, meshPoints: Points | null = null, meshColour: BufferAttribute | null = null;
    const meshBuffers = { support: support ? toLinear(supportColours(support)) : null, confidence: confidence ? toLinear(confidenceColours(confidence)) : null };
    if (mesh) {
      const geo = new BufferGeometry();
      const pos = new BufferAttribute(mesh.vertices, 3);
      geo.setAttribute("position", pos);
      geo.setIndex(new BufferAttribute(mesh.indices, 1));
      geo.computeVertexNormals();
      if (meshBuffers.support || meshBuffers.confidence) {
        meshColour = new BufferAttribute(new Float32Array(mesh.vertices.length), 3);
        geo.setAttribute("color", meshColour);
      }
      surface = new ThreeMesh(geo, mats.surfPlain);
      wire = new ThreeMesh(geo, mats.wirePlain);
      const pgeo = new BufferGeometry(); // the mesh's vertices as points: shares the GPU buffers, no index
      pgeo.setAttribute("position", pos);
      if (meshColour) pgeo.setAttribute("color", meshColour);
      meshPoints = new Points(pgeo, mats.mPtsPlain);
      group.add(surface, wire, meshPoints);
      disposables.push(geo, pgeo);
    }

    let cloud: Points | null = null, cloudColour: BufferAttribute | null = null;
    const cloudBuffers = { own: pointColors ? toLinear(Float32Array.from(pointColors)) : null, support: pointLabels ? toLinear(supportColours(pointLabels)) : null };
    if (points) {
      const geo = new BufferGeometry();
      geo.setAttribute("position", new BufferAttribute(points.length % 3 === 0 ? points : points.subarray(0, np * 3), 3));
      if (cloudBuffers.own || cloudBuffers.support) {
        cloudColour = new BufferAttribute(new Float32Array(np * 3), 3);
        geo.setAttribute("color", cloudColour);
      }
      cloud = new Points(geo, mats.cPtsPlain);
      group.add(cloud);
      disposables.push(geo);
    }

    // the scale grid (minor and major lines) on the board plane
    {
      const minor: number[] = [], major: number[] = [];
      const { step, majorEvery, x0, x1, y0, y1, z } = grid;
      const near = (v: number) => Math.abs(v / (step * majorEvery) - Math.round(v / (step * majorEvery))) < 1e-6;
      for (let x = x0; x <= x1 + 1e-9; x += step) (near(x) ? major : minor).push(x, y0, z, x, y1, z);
      for (let y = y0; y <= y1 + 1e-9; y += step) (near(y) ? major : minor).push(x0, y, z, x1, y, z);
      for (const [arr, colour, opacity] of [[minor, 0x9fb4da, 0.45], [major, 0x6f8cc4, 0.7]] as const) {
        const geo = new BufferGeometry();
        geo.setAttribute("position", new BufferAttribute(Float32Array.from(arr), 3));
        const mat = new LineBasicMaterial({ color: colour, transparent: true, opacity, depthWrite: false });
        const ls = new LineSegments(geo, mat);
        ls.renderOrder = -1;
        group.add(ls);
        disposables.push(geo, mat);
      }
    }

    // the landmark skeleton: thin orange bones and small joints, drawn on top of everything
    let skeleton: Group | null = null;
    if (landmarks) {
      skeleton = new Group();
      const boneGeo = new CylinderGeometry(1, 1, 1, 8, 1, false);
      const jointGeo = new SphereGeometry(1, 12, 8);
      const boneMat = new MeshBasicMaterial({ color: SKELETON_COLOUR, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 });
      const jointMat = new MeshBasicMaterial({ color: SKELETON_JOINT, depthTest: false, depthWrite: false, transparent: true });
      const bones = new InstancedMesh(boneGeo, boneMat, HAND_BONES.length);
      const joints = new InstancedMesh(jointGeo, jointMat, 21);
      const br = r * 0.006, jr = r * 0.0135;
      const m = new Matrix4(), qq = new Quaternion(), a = new Vector3(), b = new Vector3(), dir = new Vector3(), Y = new Vector3(0, 1, 0), s = new Vector3();
      HAND_BONES.forEach(([i, j], k) => {
        a.fromArray(landmarks, i * 3);
        b.fromArray(landmarks, j * 3);
        dir.subVectors(b, a);
        const L = dir.length();
        qq.setFromUnitVectors(Y, L > 1e-9 ? dir.clone().normalize() : Y);
        m.compose(a.clone().add(b).multiplyScalar(0.5), qq, s.set(br, Math.max(L, 1e-6), br));
        bones.setMatrixAt(k, m);
      });
      for (let i = 0; i < 21; i++) {
        const rr = i === 0 ? jr * 1.4 : jr;
        m.compose(a.fromArray(landmarks, i * 3), qq.identity(), s.set(rr, rr, rr));
        joints.setMatrixAt(i, m);
      }
      bones.renderOrder = 10;
      joints.renderOrder = 11;
      bones.frustumCulled = joints.frustumCulled = false;
      skeleton.add(bones, joints);
      group.add(skeleton);
      disposables.push(boneGeo, jointGeo, boneMat, jointMat, bones, joints);
    }

    c.scene.add(group);
    c.content = { group, surface, wire, meshPoints, cloud, skeleton, mats, meshColour, meshBuffers, meshKind: null, cloudColour, cloudBuffers, cloudKind: null, disposables };
    const boundsChanged = !c.bounds || c.bounds.radius !== bounds.radius || c.bounds.center.some((v, i) => v !== bounds.center[i]);
    c.bounds = bounds;
    const camR = bounds.radius;
    c.camera.near = camR * 0.02;
    c.camera.far = camR * 80;
    c.camera.updateProjectionMatrix();
    c.controls.minDistance = camR * 0.25;
    c.controls.maxDistance = camR * 14;
    if (boundsChanged) live.current.controlsRef.current?.reset();
    applyModes(c, live.current);
    if (!firstReady.current) {
      firstReady.current = true;
      live.current.onReady();
    }
  }, [mesh, points, pointColors, pointLabels, confidence, support, landmarks, bounds, grid]);

  // ---- modes: cheap (materials, one colour copy, visibility)
  useEffect(() => {
    if (core.current) applyModes(core.current, live.current);
  }, [props.display, props.colour, props.skeleton]);

  return (
    <div
      ref={host}
      className="mv-canvas"
      tabIndex={0}
      role="application"
      aria-label="3D view. Drag to turn in any direction, scroll or pinch to zoom, right-drag or two fingers to pan. Arrow keys turn, plus and minus zoom, 0 resets."
      data-testid="mv-canvas"
    />
  );
}

function applyModes(c: Core, p: MeshSceneProps): void {
  const k = c.content;
  if (!k) return;
  const { display, colour, skeleton } = p;
  // mesh colour attribute: copy the precomputed buffer for this mode once
  if (k.meshColour && colour !== "plain" && k.meshKind !== colour) {
    const src = colour === "support" ? k.meshBuffers.support : k.meshBuffers.confidence;
    if (src) {
      (k.meshColour.array as Float32Array).set(src);
      k.meshColour.needsUpdate = true;
      k.meshKind = colour;
    }
  }
  const meshColoured = colour !== "plain" && k.meshKind === colour;
  if (k.surface) {
    k.surface.visible = display === "surface";
    k.surface.material = meshColoured ? k.mats.surfColour : k.mats.surfPlain;
  }
  if (k.wire) {
    k.wire.visible = display === "wireframe";
    k.wire.material = meshColoured ? k.mats.wireColour : k.mats.wirePlain;
  }
  const cloudShown = display === "points" && !!k.cloud;
  if (k.meshPoints) {
    k.meshPoints.visible = display === "points" && !k.cloud;
    k.meshPoints.material = meshColoured ? k.mats.mPtsColour : k.mats.mPtsPlain;
  }
  if (k.cloud) {
    k.cloud.visible = cloudShown;
    const want = colour === "support" && k.cloudBuffers.support ? "support" : colour === "plain" && k.cloudBuffers.own ? "own" : null;
    if (want && k.cloudColour && k.cloudKind !== want) {
      (k.cloudColour.array as Float32Array).set(want === "support" ? k.cloudBuffers.support! : k.cloudBuffers.own!);
      k.cloudColour.needsUpdate = true;
      k.cloudKind = want;
    }
    k.cloud.material = want ? k.mats.cPtsColour : k.mats.cPtsPlain;
  }
  if (k.skeleton) k.skeleton.visible = skeleton;
  c.dirty = true;
}

function disposeContent(k: Content): void {
  for (const d of k.disposables) d.dispose();
}
