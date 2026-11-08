// An interactive viewer for an EXPERIMENTAL reconstruction: a triangle mesh and/or a point cloud, turned freely (a full
// 360 degrees about any axis, so the underside can be seen), zoomed, panned and reset; named preset views (anatomical when
// a hand frame is given); Surface / Wireframe / Point cloud; plain shading, colour by support label or by observation
// confidence, each with a legend in words; an optional 21-landmark skeleton overlay (diagnostic); a millimetre grid and the
// bounding size. This is the light wrapper: it decides whether WebGL can be used, loads the scene lazily (three.js is its
// own chunk) and owns everything that is not the canvas (loading, empty and error states, buttons, legends, captions).
//
// Display only. It shows geometry it is given; it measures nothing and feeds nothing back. The scene was looked at in
// headless Chromium (e2e/experiment-viewer.spec.ts saves screenshots of every mode and preset of the demo page); the
// wrapper's states and controls are unit-tested in jsdom with the scene stubbed.
import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Mesh } from "../common";
import {
  boundsOf,
  cleanFrame,
  cleanLandmarks,
  COLOUR_LABELS,
  CONFIDENCE_HIGH,
  CONFIDENCE_LOW,
  DISPLAY_LABELS,
  fmtSize,
  frameExtents,
  gridFor,
  gridWords,
  isPalmDown,
  PLAIN_SURFACE,
  POINT_PLAIN,
  shareAtLeast,
  SKELETON_COLOUR,
  SUPPORT_LEGEND,
  supportCounts,
  viewPresets,
  type Bounds,
  type CleanFrame,
  type ColourMode,
  type DisplayMode,
  type GridSpec,
  type ViewerHandFrame,
  type ViewPreset,
  type ViewPresetId,
} from "./meshViewerModel";
import "./meshViewer.css";

export type { ColourMode, DisplayMode, ViewerHandFrame, ViewPresetId } from "./meshViewerModel";

export interface MeshViewerProps {
  mesh?: Mesh | null;
  /** A separate point cloud: x, y, z triples (millimetres). Without one, Point cloud mode shows the mesh's vertices. */
  points?: Float32Array | null;
  /** Per-point colour of the separate cloud, r, g, b in 0..1 (3 per point); used by plain colouring. */
  pointColors?: Float32Array | null;
  /** Per-point support label of the separate cloud (codes as `support`). */
  pointLabels?: Uint8Array | null;
  /** Per-vertex observation confidence in 0..1 (same length as the mesh vertices), for the colour mode. */
  confidence?: Float32Array | null;
  /** Per-vertex support label (quality.ts vertexSupport): 0 observed, 1 implied, 2 support plane (board), 3 volume cut,
   *  4 truncated. Same length as the mesh vertices. */
  support?: Uint8Array | null;
  /** 21 MediaPipe-topology landmarks in the mesh's frame (21 triples or 63 numbers): an optional diagnostic overlay. */
  landmarks?: Float32Array | readonly ArrayLike<number>[] | null;
  /** Anatomical hand frame in the mesh's frame: views are then named anatomically. Without it, by the board axes. */
  handFrame?: ViewerHandFrame | null;
  /** The honesty label under the view. Say what the data is (synthetic, unvalidated, ...). */
  label?: string;
  /** Unit of the coordinates, for the size readout and the grid (default "mm"). */
  unit?: string;
  defaultDisplay?: DisplayMode;
  defaultColour?: ColourMode;
  className?: string;
  /** Called once if 3D cannot run, with a human-readable reason. */
  onUnavailable?: (message: string) => void;
}

export const DEFAULT_LABEL = "Experimental, not a validated measurement";
export const SKELETON_LABEL = "Landmark skeleton (diagnostic)";
export const BOARD_NOTE = "Bounded by the board, not observed";

export interface MeshSceneControls {
  /** Back to the framed home view. */
  reset(): void;
  /** Look from a preset direction. */
  view(preset: ViewPreset): void;
}

export interface MeshSceneProps {
  mesh: Mesh | null;
  /** The separate cloud (null: Point cloud mode uses the mesh's vertices). */
  points: Float32Array | null;
  pointColors: Float32Array | null;
  pointLabels: Uint8Array | null;
  confidence: Float32Array | null;
  support: Uint8Array | null;
  landmarks: Float32Array | null;
  frame: CleanFrame | null;
  bounds: Bounds;
  grid: GridSpec;
  display: DisplayMode;
  /** The effective colour mode (already checked to be available for this display). */
  colour: ColourMode;
  skeleton: boolean;
  controlsRef: { current: MeshSceneControls | null };
  onReady: () => void;
  onFail: (message: string) => void;
  /** The view changed outside the preset buttons: "free" when turned by hand, "home" when reset from the keyboard. */
  onViewChange: (state: "home" | "free") => void;
}

const Scene = lazy(() => import("./MeshViewerGL"));

let webgl: boolean | null = null;

/** True when a WebGL context can be created here (false in jsdom and on some old phones). Asked once. */
function webglAvailable(): boolean {
  if (webgl) return true;
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") || c.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return false;
    gl.getExtension?.("WEBGL_lose_context")?.loseContext();
    webgl = true;
    return true;
  } catch {
    return false;
  }
}

/** Forget the answer (tests). */
export function resetMeshViewerWebglCheck(): void {
  webgl = null;
}

export const MV_NO_WEBGL = "3D view unavailable: this browser or device cannot draw WebGL graphics.";
export const MV_FAILED = "3D view unavailable: it could not start on this device.";
export const MV_LOST = "3D view stopped: the browser reset the graphics. Reload the page to see it again.";

class SceneBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

type Phase = "loading" | "ready" | "error";
const DISPLAYS: DisplayMode[] = ["surface", "wireframe", "points"];
const COLOURS: ColourMode[] = ["plain", "support", "confidence"];
const pct = (n: number, total: number) => (total > 0 ? `${Math.round((100 * n) / total)} %` : "0 %");
const int = (n: number) => n.toLocaleString("en-GB");

export function MeshViewer({
  mesh = null,
  points = null,
  pointColors = null,
  pointLabels = null,
  confidence = null,
  support = null,
  landmarks = null,
  handFrame = null,
  label = DEFAULT_LABEL,
  unit = "mm",
  defaultDisplay,
  defaultColour = "plain",
  className = "",
  onUnavailable,
}: MeshViewerProps) {
  const available = webglAvailable();
  const [phase, setPhase] = useState<Phase>(available ? "loading" : "error");
  const [message, setMessage] = useState<string>(available ? "" : MV_NO_WEBGL);
  const controlsRef = useRef<MeshSceneControls | null>(null);
  const told = useRef(false);
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  // --- validate the inputs once per identity (wrong lengths are ignored rather than colouring the wrong vertices)
  const meshOk = !!mesh && mesh.indices.length > 0 && mesh.vertices.length >= 9;
  const nv = meshOk ? mesh!.vertices.length / 3 : 0;
  const cloud = points && points.length >= 3 ? points : null;
  const np = cloud ? Math.floor(cloud.length / 3) : 0;
  const conf = meshOk && confidence && confidence.length === nv ? confidence : null;
  const sup = meshOk && support && support.length === nv ? support : null;
  const pCols = cloud && pointColors && pointColors.length === np * 3 ? pointColors : null;
  const pLabs = cloud && pointLabels && pointLabels.length === np ? pointLabels : null;
  const lm = useMemo(() => cleanLandmarks(landmarks), [landmarks]);
  const frame = useMemo(() => cleanFrame(handFrame), [handFrame]);
  const presets = useMemo(() => viewPresets(frame), [frame]);
  const hasGeometry = meshOk || !!cloud;

  const bounds = useMemo(() => {
    const a = meshOk ? boundsOf(mesh!.vertices) : null;
    const b = cloud ? boundsOf(cloud) : null;
    if (a && b) {
      const min: [number, number, number] = [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])];
      const max: [number, number, number] = [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])];
      return boundsOf(Float32Array.from([...min, ...max]));
    }
    return a ?? b;
  }, [meshOk, mesh, cloud]);
  const sizeBounds = useMemo(() => (meshOk ? boundsOf(mesh!.vertices) : cloud ? boundsOf(cloud) : null), [meshOk, mesh, cloud]);
  const grid = useMemo(() => (bounds ? gridFor(bounds) : null), [bounds]);
  const extents = useMemo(() => (frame ? frameExtents(meshOk ? mesh!.vertices : (cloud ?? new Float32Array()), frame) : null), [frame, meshOk, mesh, cloud]);

  // --- modes
  const [displayChoice, setDisplay] = useState<DisplayMode>(defaultDisplay ?? (meshOk ? "surface" : "points"));
  const display: DisplayMode = !meshOk && displayChoice !== "points" ? "points" : displayChoice;
  const [colourChoice, setColour] = useState<ColourMode>(defaultColour);
  const usesCloud = display === "points" && !!cloud;
  const colourAvailable = (c: ColourMode): boolean => (c === "plain" ? true : c === "support" ? (usesCloud ? !!pLabs : !!sup) : usesCloud ? false : !!conf);
  const colour: ColourMode = colourAvailable(colourChoice) ? colourChoice : "plain";
  const [skeleton, setSkeleton] = useState(false);
  const [viewState, setViewState] = useState<ViewPresetId | "home" | "free">("home");

  const activeLabels = colour === "support" ? (usesCloud ? pLabs : sup) : null;
  const counts = useMemo(() => (activeLabels ? supportCounts(activeLabels) : null), [activeLabels]);
  const boardCount = useMemo(() => (sup ? supportCounts(sup)[2] : pLabs ? supportCounts(pLabs)[2] : 0), [sup, pLabs]);
  const confShare = useMemo(() => (conf ? shareAtLeast(conf, 0.5) : 0), [conf]);

  const fail = useCallback((text: string) => {
    setPhase("error");
    setMessage(text);
    if (!told.current) {
      told.current = true;
      onUnavailableRef.current?.(text);
    }
  }, []);

  useEffect(() => {
    if (!available) fail(MV_NO_WEBGL);
  }, [available, fail]);

  const onReady = useCallback(() => setPhase((p) => (p === "error" ? p : "ready")), []);
  const onViewChange = useCallback((state: "home" | "free") => setViewState(state), []);
  const showScene = available && phase !== "error" && hasGeometry && !!bounds && !!grid;
  const ready = phase === "ready";

  const preset = presets.find((p) => p.id === viewState) ?? null;
  const palmDown = isPalmDown(frame);
  const boardNote = !!preset && preset.facesBoard && (palmDown || boardCount > 0);
  const viewName = preset ? `${preset.label} view` : viewState === "free" ? "Free view" : "Home view";

  const pickView = (p: ViewPreset) => {
    controlsRef.current?.view(p);
    setViewState(p.id);
  };
  const resetView = () => {
    controlsRef.current?.reset();
    setViewState("home");
  };

  return (
    <div className={`mv ${className}`} role="group" aria-label="Experimental 3D reconstruction viewer">
      <div className="mv-stage">
        {showScene && (
          <SceneBoundary onError={() => fail(MV_FAILED)}>
            <Suspense fallback={null}>
              <Scene
                mesh={meshOk ? mesh : null}
                points={cloud}
                pointColors={pCols}
                pointLabels={pLabs}
                confidence={conf}
                support={sup}
                landmarks={lm}
                frame={frame}
                bounds={bounds!}
                grid={grid!}
                display={display}
                colour={colour}
                skeleton={skeleton && !!lm}
                controlsRef={controlsRef}
                onReady={onReady}
                onFail={fail}
                onViewChange={onViewChange}
              />
            </Suspense>
          </SceneBoundary>
        )}
        {phase === "loading" && hasGeometry && (
          <div className="mv-note mv-loading" role="status">
            <span className="mv-spinner" aria-hidden="true" />
            Loading 3D view…
          </div>
        )}
        {phase !== "error" && !hasGeometry && (
          <div className="mv-note mv-empty" role="status">
            No reconstruction to show
          </div>
        )}
        {phase === "error" && (
          <div className="mv-note mv-error" role="status">
            {message}
          </div>
        )}
        {ready && hasGeometry && (
          <div className="mv-hud">
            <span className="mv-viewname" data-testid="mv-viewname">
              {viewName}
            </span>
            {skeleton && lm && (
              <span className="mv-chip mv-chip-skeleton">
                <i aria-hidden="true" /> {SKELETON_LABEL}
              </span>
            )}
          </div>
        )}
        {ready && boardNote && (
          <div className="mv-board-note" role="note" data-testid="mv-board-note">
            <strong>{preset!.id === "bottom" ? "Underside" : `${preset!.label} side`}: {BOARD_NOTE.toLowerCase()}.</strong>{" "}
            <span className="mv-wide-only">{colour === "support" ? "Grey marks it." : "The flat face here is the board plane, not seen by any camera."}</span>
            {colour !== "support" && colourAvailable("support") && (
              <button type="button" className="mv-link" onClick={() => setColour("support")}>
                Show support colours
              </button>
            )}
          </div>
        )}
        {phase !== "error" && hasGeometry && (
          <button type="button" className="mv-btn mv-reset" onClick={resetView} disabled={!ready}>
            Reset view
          </button>
        )}
      </div>

      {phase !== "error" && hasGeometry && (
        <div className="mv-panel">
          <div className="mv-row" role="group" aria-label="Preset views">
            <span className="mv-row-label" aria-hidden="true">
              View
            </span>
            {presets.map((p) => (
              <button key={p.id} type="button" className="mv-btn mv-chipbtn" aria-pressed={viewState === p.id} onClick={() => pickView(p)} disabled={!ready}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="mv-row" role="group" aria-label="Display mode">
            <span className="mv-row-label" aria-hidden="true">
              Display
            </span>
            {DISPLAYS.map((d) => {
              const ok = d === "points" || meshOk;
              return (
                <button key={d} type="button" className="mv-btn mv-chipbtn" aria-pressed={display === d} onClick={() => setDisplay(d)} disabled={!ready || !ok} title={ok ? undefined : "No mesh was supplied"}>
                  {DISPLAY_LABELS[d]}
                </button>
              );
            })}
          </div>
          <div className="mv-row" role="group" aria-label="Colour mode">
            <span className="mv-row-label" aria-hidden="true">
              Colour
            </span>
            {COLOURS.map((c) => {
              const ok = colourAvailable(c);
              const why = c === "support" ? "No support labels were supplied for what is shown" : "No observation confidence was supplied for what is shown";
              return (
                <button key={c} type="button" className="mv-btn mv-chipbtn" aria-pressed={colour === c} onClick={() => setColour(c)} disabled={!ready || !ok} title={ok ? undefined : why}>
                  {COLOUR_LABELS[c]}
                </button>
              );
            })}
          </div>
          <div className="mv-row" role="group" aria-label="Overlay">
            <span className="mv-row-label" aria-hidden="true">
              Overlay
            </span>
            <button type="button" className="mv-btn mv-chipbtn mv-skeleton-btn" aria-pressed={skeleton && !!lm} onClick={() => setSkeleton((s) => !s)} disabled={!ready || !lm} title={lm ? undefined : "No 21-landmark skeleton was supplied"}>
              {SKELETON_LABEL}
            </button>
          </div>

          <div className="mv-legend" aria-label="Colour legend" data-testid="mv-legend">
            {colour === "plain" && (
              <p className="mv-legend-line">
                <i className="mv-sw" style={{ background: usesCloud && pCols ? "linear-gradient(90deg, #c9a27e, #8fa7d8)" : display === "points" ? POINT_PLAIN : PLAIN_SURFACE }} aria-hidden="true" />
                Plain shading{usesCloud && pCols ? " (the points' own colours)" : ""}: shape only, no quality information.
              </p>
            )}
            {colour === "support" && counts && (
              <ul className="mv-legend-list" aria-label="Support labels">
                {SUPPORT_LEGEND.map((s) => (
                  <li key={s.code} className={counts[s.code] === 0 ? "mv-legend-zero" : undefined} title={s.detail}>
                    <i className="mv-sw" style={{ background: s.colour }} aria-hidden="true" />
                    <span className="mv-legend-word">{s.words}</span> <span className="mv-legend-num">{pct(counts[s.code], activeLabels!.length)}</span>
                  </li>
                ))}
              </ul>
            )}
            {colour === "confidence" && (
              <div className="mv-legend-ramp">
                <span>weakly observed (0)</span>
                <i className="mv-ramp" style={{ background: `linear-gradient(90deg, ${CONFIDENCE_LOW}, ${CONFIDENCE_HIGH})` }} aria-hidden="true" />
                <span>directly observed (1)</span>
                <span className="mv-legend-num">{Math.round(confShare * 100)} % of vertices at 0.5 or more</span>
              </div>
            )}
            {skeleton && lm && (
              <p className="mv-legend-line">
                <i className="mv-sw" style={{ background: SKELETON_COLOUR }} aria-hidden="true" />
                {SKELETON_LABEL}: 21 points drawn on top, not part of the mesh.
              </p>
            )}
          </div>

          <dl className="mv-facts" data-testid="mv-facts">
            {sizeBounds && (
              <div>
                <dt>Size (bounding box)</dt>
                <dd>
                  {fmtSize(sizeBounds.size[0])} × {fmtSize(sizeBounds.size[1])} × {fmtSize(sizeBounds.size[2])} {unit} (x × y × z)
                </dd>
              </div>
            )}
            {extents && (
              <div>
                <dt>Along the hand frame</dt>
                <dd>
                  length {fmtSize(extents.length)}, breadth {fmtSize(extents.breadth)}, thickness {fmtSize(extents.thickness)} {unit} (bounding extents, not measurements)
                </dd>
              </div>
            )}
            <div>
              <dt>Geometry</dt>
              <dd>
                {meshOk ? `${int(mesh!.indices.length / 3)} triangles, ${int(nv)} vertices` : "no mesh"}
                {cloud ? `; ${int(np)} points` : ""}
                {display === "points" && !cloud ? "; Point cloud shows the mesh's vertices" : ""}
              </dd>
            </div>
            {grid && (
              <div>
                <dt>Scale</dt>
                <dd>{gridWords(grid, unit)}</dd>
              </div>
            )}
            <div>
              <dt>Views</dt>
              <dd>{frame ? "Named from the hand frame (anatomical)." : "No hand frame given: named by the board axes (+z up out of the board, +x roughly along the fingers)."}</dd>
            </div>
          </dl>
          <p className="mv-help">Drag to turn in any direction (all the way round), scroll or pinch to zoom, right-drag or two fingers to pan. With the view focused: arrow keys turn, + and − zoom, 0 resets.</p>
        </div>
      )}
      <p className="mv-caption">{label}</p>
    </div>
  );
}
