// The three.js scene of the estimated 3D landmark card (a lazy chunk: three.js is not in the main bundle).
//
// What it draws, from the 21 MediaPipe WORLD landmarks the scan already has (see viewerMath.ts for the axes):
//   * 21 joints (one InstancedMesh, with a white outline InstancedMesh behind it so they read on a light card)
//   * the bones (one InstancedMesh of thin cylinders), coloured by finger
//   * the palm as a translucent polygon, and the wrist: a ring and a short translucent forearm
//   * a reference grid under the hand and a small x/y/z gnomon
// Six draw calls, no shadows, no post-processing, no per-frame allocation, about 30 frames a second, and it stops
// drawing while the card is off screen or the tab is hidden.
//
// Controls: a mouse or pen drag turns the hand (yaw and pitch); a finger drag turns it sideways only, so a
// vertical swipe still scrolls the page (touch-action: pan-y); two fingers or the wheel zoom; arrow keys, + and -
// do the same from the keyboard; the card's buttons reset the view or look from above.
import { useEffect, useRef } from "react";
import {
  AmbientLight,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  WebGLRenderer,
} from "three";
import type { SceneHandState, SceneProps } from "./LandmarkViewer";
import { boneOf, CONNECTIONS, fingerOf, JOINT_COUNT, PALM_POLYGON, PART_COLOURS } from "./landmarkTopology";
import { fitDistance, isUsableHand, palmFacesCamera, smoothInto, toScene } from "./viewerMath";

const FOV = 38;
const FLOOR_Y = -1.5;
const ZOOM_MIN = 2.2;
const ZOOM_MAX = 9;
const DEFAULT_PITCH = 0.28;
const TOP_PITCH = 1.38;
const FRAME_MS = 33; // about 30 frames a second
const SMOOTH = 0.55; // share of the way to the new landmarks each frame (MediaPipe's points jitter)
const FIT_RADIUS = 1.5; // scene units: the hand and a little forearm fit in a sphere of this size

const MSG_FAILED = "3D view unavailable: it could not start on this device. The scan itself still works.";
const MSG_LOST = "3D view stopped: the browser reset the graphics. Reload the page to see it again. The scan itself still works.";

const PALM_FRONT = 0x1f5eea;
const PALM_BACK = 0xb08968;
const PALM_NEUTRAL = 0x5f7091;

export default function LandmarkViewerGL(props: SceneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    } catch (err) {
      console.warn("3D landmark view: WebGL unavailable", err);
      propsRef.current.onFail(MSG_FAILED);
      return;
    }
    renderer.setClearColor(0x000000, 0);
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Estimated 3D view of your hand. Drag to turn it, pinch or scroll to zoom. Arrow keys also work.");
    host.appendChild(canvas);

    const scene = new Scene();
    const camera = new PerspectiveCamera(FOV, 1, 0.1, 60);
    scene.add(new AmbientLight(0xffffff, 1.5));
    const sun = new DirectionalLight(0xffffff, 1.6);
    sun.position.set(2, 3, 4);
    scene.add(sun);

    // ---- joints, with a white outline behind them
    const sphere = new SphereGeometry(1, 14, 10);
    const joints = new InstancedMesh(sphere, new MeshLambertMaterial({ color: 0xffffff }), JOINT_COUNT);
    const outlines = new InstancedMesh(sphere, new MeshBasicMaterial({ color: 0xffffff, side: BackSide }), JOINT_COUNT);
    const tmpColor = new Color();
    for (let i = 0; i < JOINT_COUNT; i++) joints.setColorAt(i, tmpColor.setHex(PART_COLOURS[fingerOf(i)]));
    joints.frustumCulled = false;
    outlines.frustumCulled = false;
    const jointRadius = (i: number) => (i === 0 ? 0.095 : i % 4 === 0 ? 0.088 : 0.07);

    // ---- bones
    const cyl = new CylinderGeometry(1, 1, 1, 8, 1, false);
    const bones = new InstancedMesh(cyl, new MeshLambertMaterial({ color: 0xffffff }), CONNECTIONS.length);
    CONNECTIONS.forEach(([a, b], i) => bones.setColorAt(i, tmpColor.setHex(PART_COLOURS[boneOf(a, b)])));
    bones.frustumCulled = false;

    // ---- palm (a translucent fan) and wrist (a ring and a short forearm)
    const palmGeo = new BufferGeometry();
    const palmPos = new Float32Array(PALM_POLYGON.length * 3);
    palmGeo.setAttribute("position", new BufferAttribute(palmPos, 3));
    const fan: number[] = [];
    for (let i = 1; i < PALM_POLYGON.length - 1; i++) fan.push(0, i, i + 1);
    palmGeo.setIndex(fan);
    const palmMat = new MeshBasicMaterial({ color: PALM_NEUTRAL, transparent: true, opacity: 0.3, side: DoubleSide, depthWrite: false });
    const palm = new Mesh(palmGeo, palmMat);
    palm.frustumCulled = false;
    const forearm = new Mesh(
      new CylinderGeometry(1, 1, 1, 20, 1, true),
      new MeshBasicMaterial({ color: PALM_NEUTRAL, transparent: true, opacity: 0.16, side: DoubleSide, depthWrite: false }),
    );
    forearm.frustumCulled = false;
    const wristRing = new Mesh(new TorusGeometry(1, 0.035, 6, 32), new MeshBasicMaterial({ color: 0x3b4d73 }));
    wristRing.frustumCulled = false;

    const hand = [joints, outlines, bones, palm, forearm, wristRing];
    hand.forEach((o) => {
      o.visible = false;
      scene.add(o);
    });

    // ---- the reference plane and the axis gnomon
    const grid = new GridHelper(6, 12, 0x9db4de, 0xd3dff2);
    grid.position.y = FLOOR_Y;
    scene.add(grid);
    const gnomon = new LineSegments(
      new BufferGeometry().setAttribute(
        "position",
        new BufferAttribute(new Float32Array([-2.5, FLOOR_Y, 2.5, -1.8, FLOOR_Y, 2.5, -2.5, FLOOR_Y, 2.5, -2.5, FLOOR_Y + 0.7, 2.5, -2.5, FLOOR_Y, 2.5, -2.5, FLOOR_Y, 1.8]), 3),
      ),
      new LineBasicMaterial({ vertexColors: true }),
    );
    gnomon.geometry.setAttribute(
      "color",
      new BufferAttribute(new Float32Array([0.88, 0.19, 0.19, 0.88, 0.19, 0.19, 0.18, 0.62, 0.27, 0.18, 0.62, 0.27, 0.12, 0.37, 0.92, 0.12, 0.37, 0.92]), 3),
    );
    scene.add(gnomon);

    // ---- reusable temporaries (nothing is allocated per frame)
    const cur = new Float32Array(JOINT_COUNT * 3);
    const target = new Float32Array(JOINT_COUNT * 3);
    const pa = new Vector3();
    const pb = new Vector3();
    const mid = new Vector3();
    const dir = new Vector3();
    const yAxis = new Vector3(0, 1, 0);
    const zAxis = new Vector3(0, 0, 1);
    const q = new Quaternion();
    const m = new Matrix4();
    const sc = new Vector3();

    const at = (i: number, out: Vector3) => out.set(cur[i * 3], cur[i * 3 + 1], cur[i * 3 + 2]);

    function poseHand() {
      for (let i = 0; i < JOINT_COUNT; i++) {
        at(i, mid);
        const r = jointRadius(i);
        sc.set(r, r, r);
        m.compose(mid, q.identity(), sc);
        joints.setMatrixAt(i, m);
        sc.set(r * 1.45, r * 1.45, r * 1.45);
        m.compose(mid, q.identity(), sc);
        outlines.setMatrixAt(i, m);
      }
      joints.instanceMatrix.needsUpdate = true;
      outlines.instanceMatrix.needsUpdate = true;
      for (let i = 0; i < CONNECTIONS.length; i++) {
        at(CONNECTIONS[i][0], pa);
        at(CONNECTIONS[i][1], pb);
        dir.subVectors(pb, pa);
        const len = dir.length();
        mid.addVectors(pa, pb).multiplyScalar(0.5);
        q.setFromUnitVectors(yAxis, len > 1e-6 ? dir.multiplyScalar(1 / len) : yAxis);
        sc.set(0.036, Math.max(len, 1e-4), 0.036);
        m.compose(mid, q, sc);
        bones.setMatrixAt(i, m);
      }
      bones.instanceMatrix.needsUpdate = true;
      for (let k = 0; k < PALM_POLYGON.length; k++) {
        const j = PALM_POLYGON[k];
        palmPos[k * 3] = cur[j * 3];
        palmPos[k * 3 + 1] = cur[j * 3 + 1];
        palmPos[k * 3 + 2] = cur[j * 3 + 2];
      }
      (palmGeo.getAttribute("position") as BufferAttribute).needsUpdate = true;
      // The wrist: the forearm runs from the wrist away from the knuckles.
      at(0, pa);
      mid.set(0, 0, 0);
      for (const j of [5, 9, 13, 17]) {
        mid.x += cur[j * 3] / 4;
        mid.y += cur[j * 3 + 1] / 4;
        mid.z += cur[j * 3 + 2] / 4;
      }
      dir.subVectors(pa, mid);
      const dl = dir.length();
      if (dl > 1e-6) dir.multiplyScalar(1 / dl);
      else dir.set(0, -1, 0);
      const FORE = 0.7;
      pb.copy(pa).addScaledVector(dir, FORE / 2);
      q.setFromUnitVectors(yAxis, dir);
      sc.set(0.34, FORE, 0.34);
      forearm.position.copy(pb);
      forearm.quaternion.copy(q);
      forearm.scale.copy(sc);
      q.setFromUnitVectors(zAxis, dir); // the ring lies across the forearm
      wristRing.position.copy(pa);
      wristRing.quaternion.copy(q);
      wristRing.scale.set(0.34, 0.34, 0.34);
    }

    // ---- the view
    let yaw = 0;
    let pitch = DEFAULT_PITCH;
    let radius = 5;
    let yawT = yaw;
    let pitchT = pitch;
    let radiusT = radius;
    let userZoomed = false;
    let aspect = 1;
    const fit = () => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, fitDistance(FIT_RADIUS, FOV, aspect)));
    const place = () => {
      const cp = Math.cos(pitch);
      camera.position.set(radius * cp * Math.sin(yaw), radius * Math.sin(pitch), radius * cp * Math.cos(yaw));
      camera.lookAt(0, -0.33, 0);
    };
    const clampPitch = (p: number) => Math.min(TOP_PITCH + 0.1, Math.max(-0.35, p));
    const clampRadius = (r: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, r));
    propsRef.current.controlsRef.current = {
      reset: () => {
        yawT = 0;
        pitchT = DEFAULT_PITCH;
        userZoomed = false;
        radiusT = fit();
        dirty = true;
      },
      topView: () => {
        yawT = 0;
        pitchT = TOP_PITCH;
        dirty = true;
      },
    };

    // ---- size
    let dirty = true;
    const resize = () => {
      const w = Math.max(1, host.clientWidth);
      const h = Math.max(1, host.clientHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, w < 640 ? 1.5 : 2));
      renderer.setSize(w, h, false);
      aspect = w / h;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      if (!userZoomed) {
        radiusT = fit();
        if (first) radius = radiusT;
      }
      dirty = true;
    };
    let first = true;
    resize();
    first = false;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    ro?.observe(host);

    // ---- input
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchStart = 0;
    let radiusStart = radius;
    const spread = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const onDown = (e: PointerEvent) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* a pointer that is already gone */
      }
      if (pointers.size === 2) {
        pinchStart = Math.max(1, spread());
        radiusStart = radiusT;
      }
    };
    const onMove = (e: PointerEvent) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (pointers.size >= 2) {
        radiusT = clampRadius((radiusStart * pinchStart) / Math.max(1, spread()));
        userZoomed = true;
      } else {
        yawT -= dx * 0.008;
        if (e.pointerType !== "touch") pitchT = clampPitch(pitchT + dy * 0.008); // a finger's vertical drag is the page's
      }
      dirty = true;
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size === 1) radiusStart = radiusT;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      radiusT = clampRadius(radiusT * Math.exp(e.deltaY * 0.0015));
      userZoomed = true;
      dirty = true;
    };
    const onKey = (e: KeyboardEvent) => {
      const step = 0.12;
      switch (e.key) {
        case "ArrowLeft":
          yawT += step;
          break;
        case "ArrowRight":
          yawT -= step;
          break;
        case "ArrowUp":
          pitchT = clampPitch(pitchT + step);
          break;
        case "ArrowDown":
          pitchT = clampPitch(pitchT - step);
          break;
        case "+":
        case "=":
          radiusT = clampRadius(radiusT * 0.9);
          userZoomed = true;
          break;
        case "-":
          radiusT = clampRadius(radiusT / 0.9);
          userZoomed = true;
          break;
        case "Home":
          propsRef.current.controlsRef.current?.reset();
          break;
        default:
          return;
      }
      e.preventDefault();
      dirty = true;
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("keydown", onKey);

    // ---- context loss, visibility
    let lost = false;
    const onLost = (e: Event) => {
      e.preventDefault();
      lost = true;
      propsRef.current.onFail(MSG_LOST);
    };
    canvas.addEventListener("webglcontextlost", onLost);
    let onScreen = true;
    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((entries) => {
            onScreen = entries.some((en) => en.isIntersecting);
            if (onScreen) dirty = true;
          })
        : null;
    io?.observe(host);

    // ---- the loop
    let present = false;
    let reported: SceneHandState | null = null;
    let palmSide: boolean | null | undefined;
    let last = -1e9;
    let raf = 0;
    let ready = false;
    const report = (s: SceneHandState) => {
      if (reported && reported.present === s.present && reported.depth === s.depth && reported.handedness === s.handedness) return;
      reported = s;
      propsRef.current.onHand(s);
    };
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (lost || !onScreen || document.hidden || now - last < FRAME_MS) return;
      last = now;
      const world = propsRef.current.worldRef.current;
      let needsDraw = dirty;
      if (world && isUsableHand(world.points)) {
        const depth = toScene(world.points, propsRef.current.mirrored, target);
        if (!present) {
          cur.set(target);
          present = true;
          hand.forEach((o) => (o.visible = true));
        } else {
          smoothInto(cur, target, SMOOTH);
        }
        poseHand();
        const side = palmFacesCamera(world.points, world.handedness);
        if (side !== palmSide) {
          palmSide = side;
          palmMat.color.setHex(side === null ? PALM_NEUTRAL : side ? PALM_FRONT : PALM_BACK);
        }
        report({ present: true, depth, handedness: world.handedness });
        needsDraw = true;
      } else if (present) {
        present = false;
        hand.forEach((o) => (o.visible = false));
        report({ present: false, depth: true, handedness: null });
        needsDraw = true;
      } else {
        report({ present: false, depth: true, handedness: null });
      }
      // damping toward the requested view
      const k = 0.2;
      if (Math.abs(yawT - yaw) + Math.abs(pitchT - pitch) + Math.abs(radiusT - radius) > 1e-3) {
        yaw += (yawT - yaw) * k;
        pitch += (pitchT - pitch) * k;
        radius += (radiusT - radius) * k;
        needsDraw = true;
      }
      if (needsDraw) {
        place();
        try {
          renderer.render(scene, camera);
        } catch (err) {
          console.warn("3D landmark view: draw failed", err);
          lost = true;
          propsRef.current.onFail(MSG_FAILED);
          return;
        }
        dirty = false;
        if (!ready) {
          ready = true;
          propsRef.current.onReady();
        }
      }
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      io?.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("keydown", onKey);
      canvas.removeEventListener("webglcontextlost", onLost);
      if (propsRef.current.controlsRef.current) propsRef.current.controlsRef.current = null;
      sphere.dispose();
      cyl.dispose();
      palmGeo.dispose();
      gnomon.geometry.dispose();
      [joints, outlines, bones].forEach((o) => (o.material as MeshBasicMaterial).dispose());
      palmMat.dispose();
      (forearm.material as MeshBasicMaterial).dispose();
      forearm.geometry.dispose();
      (wristRing.material as MeshBasicMaterial).dispose();
      wristRing.geometry.dispose();
      (gnomon.material as LineBasicMaterial).dispose();
      grid.geometry.dispose();
      (grid.material as LineBasicMaterial).dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    };
  }, []);

  return <div className="lv-gl" ref={hostRef} />;
}
