// The three.js scene of the experimental mesh viewer (a lazy chunk: three.js is not in the main bundle).
//
// A triangle mesh (plain, wireframe, or coloured by observation confidence) and/or a point cloud, lit softly, over a
// reference grid. OrbitControls rotate and zoom; the card's Reset view button returns to the framed view. Rendering is on
// demand (only when the view changes) and stops while the card is off screen or the tab is hidden. Not looked at in a
// browser when written: see MeshViewer.tsx.
import { useEffect, useRef } from "react";
import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  Mesh as ThreeMesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { MeshSceneProps } from "./MeshViewer";

const LOW = new Color("#f08c00");
const HIGH = new Color("#1f5eea");

function confidenceColors(conf: Float32Array): Float32Array {
  const out = new Float32Array(conf.length * 3);
  const c = new Color();
  for (let i = 0; i < conf.length; i++) {
    c.copy(LOW).lerp(HIGH, Math.max(0, Math.min(1, conf[i])));
    out[i * 3] = c.r;
    out[i * 3 + 1] = c.g;
    out[i * 3 + 2] = c.b;
  }
  return out;
}

export default function MeshViewerGL(props: MeshSceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  live.current = props;
  const api = useRef<{ setWireframe(on: boolean): void; setColours(on: boolean): void } | null>(null);

  // build the scene once per geometry
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const { mesh, points, confidence } = live.current;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    } catch (err) {
      live.current.onFail(`3D view unavailable: ${String((err as Error)?.message ?? err).slice(0, 80)}`);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);
    renderer.domElement.style.cssText = "display:block;width:100%;height:100%;touch-action:none";

    const scene = new Scene();
    scene.add(new AmbientLight(0xffffff, 1.1));
    const sun = new DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.6, 1, 0.8);
    scene.add(sun);

    const disposables: { dispose(): void }[] = [];
    let geometry: BufferGeometry | null = null;
    let material: MeshStandardMaterial | null = null;
    const bounds = new Sphere();
    const all: number[] = [];
    if (mesh && mesh.indices.length > 0) {
      geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(mesh.vertices, 3));
      geometry.setIndex(new BufferAttribute(mesh.indices, 1));
      geometry.computeVertexNormals();
      if (confidence) geometry.setAttribute("color", new BufferAttribute(confidenceColors(confidence), 3));
      material = new MeshStandardMaterial({ color: 0x9db8ee, roughness: 0.65, metalness: 0.0, side: DoubleSide, vertexColors: false, wireframe: live.current.wireframe });
      scene.add(new ThreeMesh(geometry, material));
      disposables.push(geometry, material);
      geometry.computeBoundingSphere();
      bounds.copy(geometry.boundingSphere!);
    }
    if (points && points.length > 0) {
      const pg = new BufferGeometry();
      pg.setAttribute("position", new BufferAttribute(points, 3));
      const pm = new PointsMaterial({ color: 0x1f5eea, size: 1.6, sizeAttenuation: true });
      scene.add(new Points(pg, pm));
      disposables.push(pg, pm);
      pg.computeBoundingSphere();
      if (!geometry) bounds.copy(pg.boundingSphere!);
      else bounds.union(pg.boundingSphere!);
    }
    void all;
    const radius = Math.max(bounds.radius, 1);
    const grid = new GridHelper(radius * 3, 24, 0x9fb2d6, 0xcdd8ee);
    grid.position.set(bounds.center.x, bounds.center.y - radius * 1.05, bounds.center.z);
    scene.add(grid);
    disposables.push(grid.geometry as BufferGeometry);

    const camera = new PerspectiveCamera(40, 1, radius * 0.05, radius * 40);
    const home = new Vector3(bounds.center.x + radius * 0.6, bounds.center.y + radius * 0.5, bounds.center.z + radius * 3.1);
    const frame = () => {
      camera.position.copy(home);
      controls.target.copy(bounds.center);
      controls.update();
      dirty = true;
    };
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.screenSpacePanning = true;
    let dirty = true;
    let visible = true;
    controls.addEventListener("change", () => (dirty = true));
    frame();

    const resize = () => {
      const w = Math.max(1, el.clientWidth);
      const h = Math.max(1, el.clientHeight);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      dirty = true;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    const io = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
      if (visible) dirty = true;
    });
    io.observe(el);

    const onLost = (e: Event) => {
      e.preventDefault();
      live.current.onFail("3D view stopped: the browser reset the graphics. Reload the page to see it again.");
    };
    renderer.domElement.addEventListener("webglcontextlost", onLost);

    renderer.setAnimationLoop(() => {
      if (!dirty || !visible || document.hidden) return;
      dirty = false;
      renderer.render(scene, camera);
    });

    live.current.controlsRef.current = { reset: frame };
    api.current = {
      setWireframe(on) {
        if (material) material.wireframe = on;
        dirty = true;
      },
      setColours(on) {
        if (!material || !geometry) return;
        const has = !!geometry.getAttribute("color");
        material.vertexColors = on && has;
        material.color.set(on && has ? 0xffffff : 0x9db8ee);
        material.needsUpdate = true;
        dirty = true;
      },
    };
    api.current.setColours(live.current.colorByConfidence);
    live.current.onReady();

    return () => {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      io.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener("webglcontextlost", onLost);
      for (const d of disposables) d.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      if (live.current.controlsRef.current) live.current.controlsRef.current = null;
      api.current = null;
    };
  }, [props.mesh, props.points, props.confidence]);

  useEffect(() => api.current?.setWireframe(props.wireframe), [props.wireframe]);
  useEffect(() => api.current?.setColours(props.colorByConfidence), [props.colorByConfidence]);

  return <div ref={host} className="mv-canvas" />;
}
