// Dev-only demo of the experimental mesh viewer (frontend/experiment/viewer/). It builds a SIMULATED reconstruction of the
// synthetic capsule hand in a worker and shows it with every viewer mode. Nothing here is a real scan.
//   ?data=stress   a procedural 500k-triangle mesh and 200k-point cloud (not a hand), for the performance check
//   ?frame=0       do not pass the hand frame (views fall back to the board axes)
//   ?cloud=0       do not pass the separate point cloud (Point cloud mode shows the mesh's vertices)
import { useEffect, useMemo, useState } from "react";
import type { Mesh } from "../../common";
import { MeshViewer } from "../MeshViewer";
import { DEMO_LABEL, type DemoData } from "./buildDemo";
import "./viewerDemo.css";

type Stress = { mesh: Mesh; points: Float32Array; pointLabels: Uint8Array };
type Loaded = { kind: "hand"; data: DemoData; wallMs: number } | { kind: "stress"; data: Stress; wallMs: number };

const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
const KIND: "hand" | "stress" = params.get("data") === "stress" ? "stress" : "hand";
const WITH_FRAME = params.get("frame") !== "0";
const WITH_CLOUD = params.get("cloud") !== "0";
const STRESS_LABEL = "SIMULATED stress test: a procedural shape, not a hand and not a scan";

const link = (patch: Record<string, string | null>) => {
  const q = new URLSearchParams(params);
  for (const [k, v] of Object.entries(patch)) (v === null ? q.delete(k) : q.set(k, v));
  const s = q.toString();
  return s ? `?${s}` : "./";
};

export function ViewerDemoPage() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t0 = performance.now();
    let worker: Worker;
    try {
      worker = new Worker(new URL("./demo.worker.ts", import.meta.url), { type: "module" });
    } catch (err) {
      setError(`Could not start the worker: ${String((err as Error)?.message ?? err)}`);
      return;
    }
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { ok: boolean; kind: "hand" | "stress"; data: unknown; error?: string };
      if (!m.ok) setError(m.error ?? "the simulation failed");
      else setLoaded({ kind: m.kind, data: m.data, wallMs: performance.now() - t0 } as Loaded);
      worker.terminate();
    };
    worker.onerror = (e) => setError(`The simulation worker failed: ${e.message || "unknown error"}`);
    worker.postMessage({ kind: KIND });
    return () => worker.terminate();
  }, []);

  const handFrame = useMemo(() => (loaded?.kind === "hand" && WITH_FRAME ? loaded.data.handFrame : null), [loaded]);

  return (
    <main className="vd-root">
      <header className="vd-head">
        <p className="vd-kicker">Experiment · dev only · not in the app</p>
        <h1>3D reconstruction viewer</h1>
        <p className="vd-sim" role="note" data-testid="vd-sim">
          <strong>SIMULATED:</strong> synthetic capsule hand, not a real scan
        </p>
        <p className="vd-lede">
          A computer-made hand with known dimensions rests palm-down on a board. {KIND === "hand" ? "13" : "No"} simulated cameras (a low ring 12° above the board plus one from
          straight above, perfect masks, perfect poses) feed the experimental visual-hull pipeline. The result is labelled per vertex: observed, implied, bounded by the board,
          cut at the forearm, truncated. It shows the viewer and the mathematics on perfect inputs, nothing about real hands or real accuracy.
        </p>
        <nav className="vd-nav" aria-label="Demo data">
          <a href={link({ data: null })} aria-current={KIND === "hand" ? "page" : undefined}>
            Simulated hand
          </a>
          <a href={link({ data: "stress" })} aria-current={KIND === "stress" ? "page" : undefined}>
            Stress test (500k triangles, 200k points)
          </a>
          {KIND === "hand" && (
            <>
              <a href={link({ frame: WITH_FRAME ? "0" : null })}>{WITH_FRAME ? "Without the hand frame" : "With the hand frame"}</a>
              <a href={link({ cloud: WITH_CLOUD ? "0" : null })}>{WITH_CLOUD ? "Without the point cloud" : "With the point cloud"}</a>
            </>
          )}
        </nav>
      </header>

      <section className="vd-card" aria-label="Viewer">
        {!loaded && !error && (
          <p className="vd-status" role="status" data-testid="vd-status">
            <span className="vd-spin" aria-hidden="true" /> Building the simulated reconstruction…
          </p>
        )}
        {error && (
          <p className="vd-status vd-error" role="alert">
            {error}
          </p>
        )}
        {loaded?.kind === "hand" && (
          <MeshViewer
            className="vd-viewer"
            mesh={loaded.data.mesh}
            confidence={loaded.data.confidence}
            support={loaded.data.support}
            points={WITH_CLOUD ? loaded.data.points : null}
            pointLabels={WITH_CLOUD ? loaded.data.pointLabels : null}
            pointColors={WITH_CLOUD ? loaded.data.pointColors : null}
            landmarks={loaded.data.landmarks}
            handFrame={handFrame}
            label={DEMO_LABEL}
          />
        )}
        {loaded?.kind === "stress" && <MeshViewer className="vd-viewer" mesh={loaded.data.mesh} points={loaded.data.points} pointLabels={loaded.data.pointLabels} label={STRESS_LABEL} />}
      </section>

      {loaded && (
        <section className="vd-card vd-small" aria-label="About this data" data-testid="vd-info">
          {loaded.kind === "hand" ? (
            <p>
              SIMULATED: {loaded.data.info.views} views of {loaded.data.info.maskPx} × {loaded.data.info.maskPx} px, {loaded.data.info.voxelMm} mm voxels; built in{" "}
              {Math.round(loaded.wallMs)} ms (render {Math.round(loaded.data.info.ms.render)} ms, reconstruct {Math.round(loaded.data.info.ms.reconstruct)} ms).{" "}
              {loaded.data.info.accepted ? "Its own quality gates accepted it." : `Its own quality gates did not accept it (${loaded.data.info.reasons.join(", ") || "n/a"}); shown anyway, research only.`}{" "}
              {WITH_CLOUD ? `The point cloud is ${(loaded.data.points.length / 3).toLocaleString("en-GB")} points sampled on the reconstructed surface (each with its triangle's label; plain colour = height above the board).` : "No separate point cloud is passed."}{" "}
              The landmark skeleton is placed on the synthetic hand's own finger axes (what a perfect detector might give).
            </p>
          ) : (
            <p>
              SIMULATED stress set: {(loaded.data.mesh.indices.length / 3).toLocaleString("en-GB")} triangles and {(loaded.data.points.length / 3).toLocaleString("en-GB")} points,
              built in {Math.round(loaded.wallMs)} ms. A procedural shape for the performance check, not a hand.
            </p>
          )}
        </section>
      )}
    </main>
  );
}
