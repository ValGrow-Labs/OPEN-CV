// The 3D drawing of the fitted hand (a lazily loaded chunk: three.js). Solid, Wireframe and Point Cloud are three drawings of
// ONE fitted model (millimesh/fitHand.ts), an estimate and not a measured scan. Orbit by dragging (or the arrow keys).
// The coloured markers show where each view's best frames looked at the hand from; they dim when they face away.
// The speed guard of the other 3D layers (hand3d/perfGuard.ts) is reused: a slow phone gets half the points and 20 frames a second.
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import { BONES, BONE_RADII, CAPSULE_BONES, handWire, poseSamples, sampleHand, type Vec3 } from "../hand3d/handModel";
import { PerfGuard } from "../hand3d/perfGuard";
import type { FittedHand, Marker } from "./fitHand";
import type { PhaseId } from "./coverage";

export type ReconMode = "solid" | "wireframe" | "points";

export const MARKER_COLORS: Record<PhaseId, string> = { palm: "#3ddc97", side: "#f2c14e", back: "#5aa9ff" };

export interface ReconSceneProps {
  fit: FittedHand;
  mode: ReconMode;
  /** Bumped to bring the hand back to its first view. */
  resetKey: number;
  onUnavailable?: (reason: string) => void;
}

const POINTS = 5200;
// Front-on and upright: the palm towards the viewer, fingers up. A gentle sway (about 17 degrees either way) shows it is 3D
// until the first touch; it never turns the hand away.
const START_YAW = 0.1;
const START_PITCH = -0.05;
const SWAY_RAD = 0.3;
const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

const V = (p: Vec3) => new THREE.Vector3(p.x, p.y, p.z);

let dotTex: THREE.CanvasTexture | null = null;
function dotTexture(): THREE.CanvasTexture {
  if (dotTex) return dotTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.3, "rgba(255,255,255,0.8)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  dotTex = new THREE.CanvasTexture(c);
  return dotTex;
}

/** The solid hand: a tapered capsule per bone, a ball at every joint, the palm slab and the forearm as convex hulls of the
 *  model's own sampled surface. */
function buildSolid(pose: readonly Vec3[], material: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const up = new THREE.Vector3(0, 1, 0);
  for (const b of CAPSULE_BONES) {
    const [ra, rb] = BONE_RADII[b]!;
    const A = V(pose[BONES[b][0]]);
    const B = V(pose[BONES[b][1]]);
    const len = A.distanceTo(B);
    if (len < 1e-5) continue;
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(rb, ra, len, 22, 1, true), material);
    cyl.position.copy(A).add(B).multiplyScalar(0.5);
    cyl.quaternion.setFromUnitVectors(up, B.clone().sub(A).normalize());
    g.add(cyl);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(rb, 22, 14), material);
    ball.position.copy(B);
    g.add(ball);
    if ([0, 5, 9, 13, 17].includes(b)) {
      const base = new THREE.Mesh(new THREE.SphereGeometry(ra, 22, 14), material);
      base.position.copy(A);
      g.add(base);
    }
  }
  const sampled = sampleHand(pose, 3200, 11);
  const out = new Float32Array(sampled.count * 3);
  poseSamples(sampled, pose, out);
  const palm: THREE.Vector3[] = [];
  const stub: THREE.Vector3[] = [];
  for (let i = 0; i < sampled.count; i++) {
    const b = sampled.bone[i];
    const p = new THREE.Vector3(out[3 * i], out[3 * i + 1], out[3 * i + 2]);
    if (b === 4 || b === 8 || b === 12) palm.push(p);
    else if (b === 16) stub.push(p);
  }
  for (const pts of [palm, stub]) {
    if (pts.length >= 8) {
      try {
        g.add(new THREE.Mesh(new ConvexGeometry(pts), material));
      } catch {
        /* a degenerate cloud: the hand is drawn without that piece */
      }
    }
  }
  return g;
}

function buildPoints(pose: readonly Vec3[]): THREE.Points {
  const sampled = sampleHand(pose, POINTS, 5);
  const pos = new Float32Array(POINTS * 3);
  poseSamples(sampled, pose, pos);
  const col = new Float32Array(POINTS * 3);
  const lo = new THREE.Color("#2f78ff");
  const hi = new THREE.Color("#d6ecff");
  const c = new THREE.Color();
  for (let i = 0; i < POINTS; i++) {
    c.copy(lo).lerp(hi, Math.min(1, sampled.glow[i] * 1.15));
    col.set([c.r, c.g, c.b], 3 * i);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return new THREE.Points(
    geo,
    new THREE.PointsMaterial({ size: 0.022, sizeAttenuation: true, vertexColors: true, map: dotTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
}

function buildMarker(m: Marker): { group: THREE.Group; mats: THREE.Material[] } {
  const color = new THREE.Color(MARKER_COLORS[m.phase]);
  const group = new THREE.Group();
  group.position.copy(V(m.position));
  // Drawn on top of the hand (a marker on the far side shows through, dimmer): they say where each view looked from.
  const core = new THREE.MeshBasicMaterial({ color, transparent: true, depthTest: false });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.032, 20, 14), core);
  sphere.renderOrder = 20;
  const halo = new THREE.SpriteMaterial({ map: dotTexture(), color, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
  const sprite = new THREE.Sprite(halo);
  sprite.renderOrder = 19;
  sprite.scale.setScalar(0.16);
  group.add(sphere, sprite);
  return { group, mats: [core, halo] };
}

export default function ReconScene({ fit, mode, resetKey, onUnavailable }: ReconSceneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const api = useRef<{ setMode: (m: ReconMode) => void; reset: () => void } | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    } catch (e) {
      onUnavailable?.(e instanceof Error ? e.message : "WebGL could not start");
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    const canvas = renderer.domElement;
    canvas.className = "mm-recon-canvas";
    host.appendChild(canvas);

    const still = reduced();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 20);
    scene.add(new THREE.AmbientLight(0x7fa6ff, 0.5));
    const key = new THREE.DirectionalLight(0xe4f0ff, 2.6);
    key.position.set(1.5, 2.5, 3);
    const fill = new THREE.DirectionalLight(0x4b93ff, 0.9);
    fill.position.set(-2.5, 0.5, 2);
    const rim = new THREE.DirectionalLight(0x6fb4ff, 2.2);
    rim.position.set(-2, 1, -3);
    scene.add(key, fill, rim);

    const hand = new THREE.Group();
    hand.position.set(0, -0.29, 0); // the middle of the hand (forearm stub to fingertips) is the pivot
    const pivot = new THREE.Group(); // rotates about the middle of the hand
    pivot.add(hand);
    scene.add(pivot);

    const solidMat = new THREE.MeshStandardMaterial({ color: 0x2457c9, emissive: 0x08266f, emissiveIntensity: 0.5, roughness: 0.5, metalness: 0.1, transparent: true, opacity: 0.9 });
    const solid = buildSolid(fit.pose, solidMat);
    const wire = new THREE.LineSegments(
      (() => {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(handWire(fit.pose, { dense: true }), 3));
        return g;
      })(),
      new THREE.LineBasicMaterial({ color: 0x74bcff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    const points = buildPoints(fit.pose);
    const markers = fit.markers.map((m) => ({ m, ...buildMarker(m) }));
    hand.add(solid, wire, points);
    for (const k of markers) hand.add(k.group);

    let yaw = START_YAW;
    let pitch = START_PITCH;
    let vYaw = 0;
    let vPitch = 0;
    let dragging = false;
    let touched = false;
    let sway = 0;
    let dirty = true;
    let lastX = 0;
    let lastY = 0;
    let fraction = 1;

    const applyMode = (m: ReconMode) => {
      solid.visible = m === "solid";
      (wire.material as THREE.LineBasicMaterial).opacity = m === "solid" ? 0.32 : 0.85;
      wire.visible = m !== "points";
      points.visible = m === "points";
      dirty = true;
    };
    applyMode(modeRef.current);

    const size = () => {
      const r = host.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      renderer.setSize(w, h, false);
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      camera.aspect = w / h;
      const t = Math.tan((camera.fov * Math.PI) / 360);
      const dist = Math.max(0.74 / t, 0.56 / (t * camera.aspect)) * 1.03;
      camera.position.set(0, 0, dist);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
      dirty = true;
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(host);

    const down = (e: PointerEvent) => {
      dragging = true;
      touched = true;
      lastX = e.clientX;
      lastY = e.clientY;
      vYaw = vPitch = 0;
      host.setPointerCapture?.(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      yaw += dx * 0.009;
      pitch = Math.max(-1.3, Math.min(1.3, pitch + dy * 0.009));
      vYaw = dx * 0.009;
      vPitch = dy * 0.009;
      dirty = true;
    };
    const up = () => {
      dragging = false;
    };
    const keydown = (e: KeyboardEvent) => {
      const step = 0.18;
      if (e.key === "ArrowLeft") yaw -= step;
      else if (e.key === "ArrowRight") yaw += step;
      else if (e.key === "ArrowUp") pitch = Math.max(-1.3, pitch - step);
      else if (e.key === "ArrowDown") pitch = Math.min(1.3, pitch + step);
      else return;
      touched = true;
      e.preventDefault();
      dirty = true;
    };
    host.addEventListener("pointerdown", down);
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerup", up);
    host.addEventListener("pointercancel", up);
    host.addEventListener("keydown", keydown);

    const lost = (e: Event) => {
      e.preventDefault();
      onUnavailable?.("The browser took back the graphics memory used for the 3D view.");
    };
    canvas.addEventListener("webglcontextlost", lost);

    api.current = {
      setMode: applyMode,
      reset: () => {
        yaw = START_YAW;
        pitch = START_PITCH;
        vYaw = vPitch = 0;
        touched = false;
        sway = 0;
        dirty = true;
      },
    };

    const guard = new PerfGuard({ maxFrameMs: 14, minFps: 20 });
    const camDir = new THREE.Vector3();
    const q = new THREE.Quaternion();
    let raf = 0;
    let last = 0;
    let lastDraw = 0;
    let stopped = false;
    const frame = (now: number) => {
      if (stopped) return;
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const plan = guard.tick(now);
      // a hand that never goes away: the cheapest level (half the points, 20 frames a second) is the floor
      const level = plan.disabled ? 4 : plan.level;
      const nf = level >= 3 ? 0.5 : 1;
      if (nf !== fraction) {
        fraction = nf;
        points.geometry.setDrawRange(0, Math.floor(POINTS * fraction));
        dirty = true;
      }
      const fps = level >= 4 ? 20 : 60;
      if (now - lastDraw < 1000 / fps - 3) return;
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
      last = now;
      lastDraw = now;
      if (!dragging) {
        if (!still && !touched) {
          sway += dt;
          yaw = START_YAW + SWAY_RAD * Math.sin(sway * 0.7); // a gentle sway, front-on, until the first touch
          dirty = true;
        }
        if (Math.abs(vYaw) > 1e-4 || Math.abs(vPitch) > 1e-4) {
          yaw += vYaw;
          pitch = Math.max(-1.3, Math.min(1.3, pitch + vPitch));
          vYaw *= 0.92;
          vPitch *= 0.92;
          dirty = true;
        }
      }
      if (!dirty) return;
      dirty = false;
      const t0 = performance.now();
      pivot.rotation.set(pitch, yaw, 0, "XYZ");
      // markers fade when they face away from the viewer
      q.copy(pivot.quaternion).invert();
      camDir.set(0, 0, 1).applyQuaternion(q);
      for (const k of markers) {
        const f = camDir.x * k.m.direction.x + camDir.y * k.m.direction.y + camDir.z * k.m.direction.z;
        const o = 0.5 + 0.5 * Math.min(1, Math.max(0, (f + 0.15) / 0.5));
        for (const mat of k.mats) (mat as THREE.Material & { opacity: number }).opacity = o;
      }
      renderer.render(scene, camera);
      guard.frame(performance.now() - t0);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeEventListener("pointerdown", down);
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerup", up);
      host.removeEventListener("pointercancel", up);
      host.removeEventListener("keydown", keydown);
      canvas.removeEventListener("webglcontextlost", lost);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose?.();
      });
      renderer.dispose();
      canvas.remove();
      api.current = null;
    };
  }, [fit, onUnavailable]);

  useEffect(() => api.current?.setMode(mode), [mode]);
  useEffect(() => {
    if (resetKey > 0) api.current?.reset();
  }, [resetKey]);

  return (
    <div
      ref={hostRef}
      className="mm-recon-host"
      data-mode={mode}
      tabIndex={0}
      role="group"
      aria-label="Estimated 3D hand model. Drag, or use the arrow keys, to turn it."
    />
  );
}
