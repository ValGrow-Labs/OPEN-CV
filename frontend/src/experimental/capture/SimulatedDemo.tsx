// The SIMULATED reconstruction section: visually separate from the real captures, and labelled SIMULATED everywhere.
import { useState } from "react";
import { MeshViewer } from "../reconstruction";
import { runSimulatedReconstruction, SIMULATED_SENTENCE, SIMULATED_TITLE, SIMULATED_VIEWER_LABEL, type SimulatedResult } from "./simulated";

const sign = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(1);

export function SimulatedDemo() {
  const [result, setResult] = useState<SimulatedResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    await new Promise((r) => setTimeout(r, 30)); // let "Running" paint before the page is busy
    try {
      setResult(runSimulatedReconstruction());
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
    setRunning(false);
  };

  return (
    <section className="xp-card xp-sim" aria-labelledby="xp-sim-h" data-simulated="true">
      <h2 id="xp-sim-h">{SIMULATED_TITLE}</h2>
      <p className="xp-notice" role="note">
        <strong>SIMULATED.</strong> {SIMULATED_SENTENCE}
      </p>
      <div className="xp-row" style={{ marginTop: 10 }}>
        <button className="xp-btn xp-btn-primary" onClick={() => void run()} disabled={running}>
          {running ? "Running the SIMULATED reconstruction…" : "Run simulated reconstruction (synthetic hand, not your hand)"}
        </button>
      </div>
      {error && (
        <p className="xp-notice xp-error" role="alert">
          The simulation failed: {error}
        </p>
      )}
      {result && (
        <>
          {/* The viewer sizes its own stage and puts its controls under it, so the box grows with it instead of clipping. */}
          <div className="xp-viewer" style={{ height: "auto", minHeight: 0, overflow: "visible", background: "transparent" }}>
            <MeshViewer mesh={result.mesh} confidence={result.confidence} label={SIMULATED_VIEWER_LABEL} />
          </div>
          <p className="xp-small" role="status">
            SIMULATED: {result.views.length} views ({result.views.join(", ")}), {result.voxelMm} mm voxels, took {Math.round(result.timingMs)} ms.{" "}
            {result.accepted ? "The reconstruction passed its own quality gates." : `The reconstruction did not pass its quality gates: ${result.reasons.join("; ") || "n/a"}.`}
          </p>
          <div className="xp-table-wrap">
            <table className="xp-table" aria-label="SIMULATED truth versus estimate">
              <caption className="xp-small xp-muted" style={{ textAlign: "left", paddingBottom: 6 }}>
                SIMULATED results. Error = estimate minus the exact truth of the synthetic hand.
              </caption>
              <thead>
                <tr>
                  <th scope="col">SIMULATED measurement</th>
                  <th scope="col">Truth</th>
                  <th scope="col">Estimate</th>
                  <th scope="col">Error</th>
                  <th scope="col">Basis</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.metric}>
                    <td>{r.label}</td>
                    <td>
                      {r.truth.toFixed(r.unit === "mm2" ? 0 : 1)} {r.unit === "mm2" ? "mm²" : "mm"}
                    </td>
                    <td>{r.estimate === null ? "withheld" : `${r.estimate.toFixed(r.unit === "mm2" ? 0 : 1)} ${r.unit === "mm2" ? "mm²" : "mm"}`}</td>
                    <td>{r.error === null ? "n/a" : sign(r.error)}</td>
                    <td>{r.basis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
