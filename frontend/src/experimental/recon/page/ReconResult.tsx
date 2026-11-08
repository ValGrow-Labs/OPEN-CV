// The result of the EXPERIMENTAL board reconstruction, as words and tables: the 3D viewer, the measurements with their
// basis (never a number for a value that is not there), every quality reason, the refusal when the chain refused, the
// camera calibration, the coin print-scale check, the per-view table, support shares, timings and the local export.
import { useMemo } from "react";
import { MeshViewer } from "../../reconstruction/MeshViewer";
import { viewerFrameOf } from "../../reconstruction/meshViewerModel";
import { calibrationView, coinView, measurementRows, ms, reasonDetail, reasonWords, refusalWords, RESULT_CAPTION, supportShareRows, viewRows } from "./format";
import type { BoardFlatness } from "../boardFlatness";
import type { RulerCheck } from "./boardCheck";
import type { Capture, ReconOutcome } from "./types";
import { BoardCheckResult } from "./ValidationPanels";

export interface ReconResultProps {
  outcome: ReconOutcome | null;
  error: string | null;
  captures: readonly Capture[];
  coinLabel: string;
  binText: (c: Capture) => string;
  wallMs: number | null;
  heap: { before: number | null; after: number | null } | null;
  includePhotos: boolean;
  onIncludePhotos: (v: boolean) => void;
  onExport: () => void;
  exportInfo: { bytes: number; files: number; photos: boolean } | null;
  photosLost: boolean;
  onBack: () => void;
  onStartOver: () => void;
  validationMode?: boolean;
  ruler?: RulerCheck | null;
  flatness?: BoardFlatness | null;
  valid?: { valid: boolean; reasons: string[] } | null;
}

export function ReconResult(p: ReconResultProps) {
  const { outcome } = p;
  const chain = outcome?.chain ?? null;
  const rec = chain?.reconstruction ?? null;
  const refusal = chain ? refusalWords(chain.refused, chain.refusalWords) : null;
  const coin = coinView(outcome?.coin ?? null, p.coinLabel);
  const usedViews = rec ? rec.views.filter((v) => v.used).length : 0;
  const rows = useMemo(
    () => (rec ? measurementRows(rec.measurements, { missingNote: rec.measurementBasis, withheld: coin.scaleWrong ? `Withheld: ${coin.words}` : null }) : []),
    [rec, coin.scaleWrong, coin.words],
  );
  const landmarks = useMemo(() => {
    const pts = rec?.landmarks?.points;
    if (!pts || pts.length !== 21 || pts.some((q) => !q)) return null;
    return Float32Array.from(pts.flatMap((q) => [q!.x, q!.y, q!.z]));
  }, [rec]);
  const handFrame = useMemo(() => (rec?.frame ? viewerFrameOf(rec.frame) : null), [rec]);
  const views = useMemo(() => viewRows(p.captures, outcome, p.binText), [p.captures, outcome, p.binText]);
  const cal = chain?.cameras ? calibrationView(chain.cameras.calibration) : null;
  // The measurements stay visible but are marked when the capture is not valid for validation (in validation mode), or
  // whenever the pictures show a sheet that is not flat.
  const notValid = p.validationMode ? !!p.valid && !p.valid.valid : p.flatness?.verdict === "fail";
  const notValidWords = p.validationMode
    ? `Not valid for validation: ${(p.valid?.reasons ?? []).join(" ")}`
    : "Not valid for validation: the board is probably not flat in the pictures (see Board check below). The numbers are shown for research only.";

  let verdict: { kind: "refused" | "failed" | "accepted" | "rejected"; title: string; words: string };
  if (p.error) verdict = { kind: "failed", title: "The reconstruction stopped with an error", words: p.error };
  else if (!chain) verdict = { kind: "failed", title: "No result", words: "Nothing was reconstructed." };
  else if (refusal) verdict = { kind: "refused", title: "Refused: no 3D hand and no measurements", words: refusal };
  else if (!rec || !rec.ok || !rec.mesh) verdict = { kind: "failed", title: "No surface could be built", words: rec?.failure ? reasonWords(rec.failure) : "The reconstruction produced no mesh." };
  else if (rec.accepted && rec.reasons.length === 0)
    verdict = { kind: "accepted", title: "Passed its own quality checks", words: "The experimental quality checks found no problem. That is not a validation: nothing here has been compared with a physical measurement." };
  else if (rec.accepted)
    verdict = { kind: "accepted", title: "The shape passed its own quality checks, with a note", words: "The experimental checks of the surface found no problem, but see below. That is not a validation: nothing here has been compared with a physical measurement." };
  else verdict = { kind: "rejected", title: "Did not pass its own quality checks", words: "The surface is shown for research, but treat every number below as unreliable." };

  return (
    <div className="rc-result" data-testid="recon-result">
      <section className={`rc-card rc-verdict rc-verdict-${verdict.kind}`} role={verdict.kind === "accepted" ? "status" : "alert"} data-testid="recon-verdict" data-kind={verdict.kind}>
        <p className="rc-eyebrow">EXPERIMENTAL result</p>
        <h2>{verdict.title}</h2>
        <p>{verdict.words}</p>
        {rec && rec.reasons.length > 0 && (
          <ul className="rc-reasons" data-testid="recon-reasons">
            {rec.reasons.map((r) => (
              <li key={r} data-code={r}>
                {reasonWords(r)}
                {reasonDetail(r, rec.quality) && <span className="rc-detail"> {reasonDetail(r, rec.quality)}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {rec?.mesh && (
        <section className="rc-card rc-viewer-card" aria-label="3D view">
          <MeshViewer
            className="rc-viewer"
            mesh={rec.mesh}
            confidence={rec.confidence}
            support={rec.support}
            points={rec.pointCloud?.points ?? null}
            pointLabels={rec.pointCloud?.labels ?? null}
            landmarks={landmarks}
            handFrame={handFrame}
            label={RESULT_CAPTION(usedViews)}
            unit="mm"
          />
          {!landmarks && <p className="rc-small">No landmark skeleton: not all 21 landmarks could be placed in 3D.</p>}
        </section>
      )}

      {rec && !refusal && (
        <section className="rc-card" aria-label="Measurements" data-testid="recon-measurements">
          <h3>Measurements</h3>
          {coin.scaleWrong && (
            <p className="rc-warn" role="alert" data-testid="print-scale-warning">
              {coin.words}
            </p>
          )}
          {notValid && (
            <p className="rc-warn" role="alert" data-testid="not-valid-warning">
              {notValidWords}
            </p>
          )}
          <p className="rc-small">How they are obtained: {rec.measurementBasis}.</p>
          <div className="rc-scroll">
            <table className={`rc-table${notValid ? " rc-table-invalid" : ""}`} data-valid={notValid ? "0" : "1"}>
              <thead>
                <tr>
                  <th scope="col">Measurement</th>
                  <th scope="col">Value</th>
                  <th scope="col">Basis</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} data-key={r.key} data-shown={r.shown ? "1" : "0"}>
                    <th scope="row">{r.label}</th>
                    <td className={r.shown ? "rc-num" : "rc-na"}>
                      <span className="rc-value">{r.value}</span>
                      {r.bound === "upper" && <span className="rc-bound">upper bound</span>}
                      {notValid && r.shown && <span className="rc-invalid-tag">not valid</span>}
                    </td>
                    <td>
                      {r.basis}
                      {r.flag && <span className="rc-flag">{r.flag}</span>}
                      {r.note && (
                        <details className="rc-note">
                          <summary>why</summary>
                          {r.note}
                        </details>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rec.measurements?.notes?.length ? (
            <ul className="rc-small">
              {rec.measurements.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
          {rec.accepted && rec.freeSurfaceAreaMm2 !== null && !coin.scaleWrong && (
            <p className="rc-small">
              Hull surface above the board (without the faces on the board and at the forearm cut; an upper bound): {Math.round(rec.freeSurfaceAreaMm2).toLocaleString("en-GB")} mm².
            </p>
          )}
        </section>
      )}

      <BoardCheckResult validationMode={!!p.validationMode} ruler={p.ruler ?? null} flatness={p.flatness ?? null} valid={p.valid ?? null} />

      <section className="rc-card" aria-label="Print scale check" data-testid="coin-check">
        <h3>Print scale (the coin)</h3>
        <dl className="rc-dl">
          <dt>Measured coin</dt>
          <dd>{coin.measured}</dd>
          <dt>Implied print scale</dt>
          <dd>{coin.printScale ?? "not available"}</dd>
        </dl>
        <p className={coin.scaleWrong ? "rc-warn" : "rc-small"}>{coin.words}</p>
      </section>

      {cal && (
        <section className="rc-card" aria-label="Camera calibration" data-testid="calibration">
          <h3>Camera calibration</h3>
          {cal.assumed && <p className="rc-warn">The focal length is ASSUMED, not measured: millimetres cannot be trusted.</p>}
          <dl className="rc-dl">
            <dt>Method</dt>
            <dd>{cal.method}</dd>
            <dt>Focal length</dt>
            <dd>
              {cal.focalPx}
              {cal.focalStd && ` ${cal.focalStd}`}
            </dd>
            <dt>Lens distortion k1</dt>
            <dd>
              {cal.k1}
              {cal.k2 !== null && ` (k2 ${cal.k2})`}
            </dd>
            <dt>Reprojection RMS</dt>
            <dd>{cal.rmsPx}</dd>
          </dl>
          {cal.warnings.length > 0 && (
            <ul className="rc-small">
              {cal.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="rc-card" aria-label="Views" data-testid="view-table">
        <h3>Views ({p.captures.length})</h3>
        <p className="rc-small">Markers, elevation and azimuth from the calibrated camera (or "live", from the assumed focal length at capture time).</p>
        <div className="rc-scroll">
          <table className="rc-table rc-table-views">
            <thead>
              <tr>
                <th scope="col">View</th>
                <th scope="col">Position</th>
                <th scope="col">Markers</th>
                <th scope="col">Elevation</th>
                <th scope="col">Azimuth</th>
                <th scope="col">Landmarks</th>
                <th scope="col">Used</th>
                <th scope="col">Hand-moved check</th>
              </tr>
            </thead>
            <tbody>
              {views.map((v) => (
                <tr key={v.id}>
                  <th scope="row">{v.id}</th>
                  <td>{v.position}</td>
                  <td>{v.markers}</td>
                  <td>{v.elevation}</td>
                  <td>{v.azimuth}</td>
                  <td>{v.landmarks}</td>
                  <td>{v.used}</td>
                  <td>{v.handMoved}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {(rec?.supportShare || chain) && (
        <section className="rc-card" aria-label="Support and timings" data-testid="timings">
          {rec?.supportShare && (
            <>
              <h3>Where the surface comes from</h3>
              <ul className="rc-share">
                {supportShareRows(rec.supportShare).map((s) => (
                  <li key={s.label}>
                    <span>{s.label}</span>
                    <strong>{s.percent}</strong>
                  </li>
                ))}
              </ul>
            </>
          )}
          {chain && (
            <>
              <h3>Timings (this device)</h3>
              <dl className="rc-dl">
                <dt>Find markers</dt>
                <dd>{ms(chain.timingsMs.detect)}</dd>
                <dt>Calibrate</dt>
                <dd>{ms(chain.timingsMs.calibrate)}</dd>
                <dt>Place cameras</dt>
                <dd>{ms(chain.timingsMs.pose)}</dd>
                <dt>Reconstruct</dt>
                <dd>
                  {ms(chain.timingsMs.reconstruct)}
                  {rec && ` (outlines ${ms(rec.timingsMs.segment)}, carving ${ms(rec.timingsMs.carve)}, mesh ${ms(rec.timingsMs.mesh)}, checks ${ms(rec.timingsMs.quality)})`}
                </dd>
                <dt>Coin check</dt>
                <dd>{ms(outcome?.timingsMs.coin)}</dd>
                <dt>Whole build</dt>
                <dd>{ms(p.wallMs)}</dd>
                <dt>JS heap (page)</dt>
                <dd>{p.heap && (p.heap.before !== null || p.heap.after !== null) ? `${p.heap.before ?? "?"} MB before, ${p.heap.after ?? "?"} MB after` : "not available in this browser"}</dd>
              </dl>
            </>
          )}
        </section>
      )}

      <section className="rc-card" aria-label="Export" data-testid="export">
        <h3>Save (this device only)</h3>
        <p className="rc-small">A ZIP with reconstruction.json, the mesh (PLY), the point cloud (CSV), device.json (this device's performance log) and a README. Nothing is uploaded.</p>
        <label className="rc-check">
          <input type="checkbox" checked={p.includePhotos} disabled={p.photosLost} onChange={(e) => p.onIncludePhotos(e.target.checked)} data-testid="include-photos" />
          Include the photos of my hand
        </label>
        {p.photosLost && <p className="rc-small">The photos were lost when the reconstruction stopped; they cannot be included.</p>}
        <button type="button" className="btn btn-primary" onClick={p.onExport} disabled={!outcome} data-testid="export-zip">
          Download ZIP
        </button>
        {p.exportInfo && (
          <p className="rc-small" role="status" data-testid="export-info">
            Saved {(p.exportInfo.bytes / 1048576).toFixed(1)} MB, {p.exportInfo.photos ? "with" : "without"} photos.
          </p>
        )}
      </section>

      <div className="rc-actions">
        <button type="button" className="btn btn-ghost" onClick={p.onBack}>
          Back to the camera (add or retake views)
        </button>
        <button type="button" className="btn btn-ghost" onClick={p.onStartOver}>
          Start over
        </button>
      </div>
    </div>
  );
}
