// The EXPERIMENTAL board-capture page (dev only, /experiment/recon/): a guide, the live capture with the coverage dial,
// the reconstruction, the result and the local export. All state lives in useReconCapture. With `?validation`: the board
// print check and the test-run details before the camera, the live flatness warning, the validity of the result.
import { useEffect, useRef } from "react";
import { mmText, sizeCheckWording } from "../../densescan/page/coin";
import { CoverageDial } from "./CoverageDial";
import { binWords } from "./coverage";
import { ReconResult } from "./ReconResult";
import type { Capture } from "./types";
import { useReconCapture } from "./useReconCapture";
import { BoardPrintCheck, DeviceLogPanel, FlatnessSummary, RunDetailsPanel } from "./ValidationPanels";
import "./recon.css";

declare global {
  interface Window {
    __RECON__?: Record<string, unknown>;
  }
}

function Thumb({ data, label }: { data: ImageData | null; label: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !data) return;
    c.width = data.width;
    c.height = data.height;
    c.getContext("2d")?.putImageData(data, 0, 0);
  }, [data]);
  return <canvas ref={ref} className="rc-thumb-img" role="img" aria-label={label} />;
}

export function ReconPage() {
  const s = useReconCapture();
  const live = s.live;
  const showStage = s.phase === "starting" || s.phase === "live";

  // A read-only summary for the browser test and for looking at the page from the console (no pictures in it).
  useEffect(() => {
    const rec = s.outcome?.chain.reconstruction ?? null;
    window.__RECON__ = {
      phase: s.phase,
      coin: s.coin ? { id: s.coin.id, label: s.coin.label, diameter_mm: s.coin.diameter_mm } : null,
      captures: s.captures.map((c) => ({ id: c.id, bin: c.bin, width: c.width, height: c.height, markers: c.markers, elevation: c.elevationDeg, azimuth: c.azimuthDeg, landmarks: c.landmarks ? c.landmarks.length : 0, trigger: c.trigger })),
      filled: [...s.filled],
      missing: s.missing,
      live: live ? { ...live.analysis, gate: live.gate.code, bin: live.gate.bin, guidance: live.guidance } : null,
      progress: s.progressText,
      buildError: s.buildError,
      result: s.outcome
        ? {
            refused: s.outcome.chain.refused,
            calibration: s.outcome.chain.cameras ? { method: s.outcome.chain.cameras.calibration.method, fx: s.outcome.chain.cameras.intrinsics.fx, rmsPx: s.outcome.chain.cameras.calibration.assumed ? null : s.outcome.chain.cameras.calibration.rmsPx } : null,
            viewsWithPose: s.outcome.chain.cameras ? s.outcome.chain.cameras.views.filter((v) => v.pose && !v.rejected).length : 0,
            accepted: rec?.accepted ?? null,
            reasons: rec?.reasons ?? [],
            hasMesh: !!rec?.mesh,
            triangles: rec?.mesh ? rec.mesh.indices.length / 3 : 0,
            landmarkViews: s.captures.filter((c) => c.landmarks).length,
            handFrame: !!rec?.frame,
            measurements: rec?.measurements
              ? Object.fromEntries(
                  [
                    ["handLength", rec.measurements.handLength],
                    ["palmBreadth", rec.measurements.palmBreadth],
                    ["palmThickness", rec.measurements.palmThickness],
                    ["circumferenceKnuckle", rec.measurements.circumferenceKnuckle],
                    ["surfaceArea", rec.measurements.surfaceArea],
                    ...Object.entries(rec.measurements.fingerLengths),
                  ].map(([k, q]) => [k as string, { value: (q as { value: number | null }).value, basis: (q as { basis: string }).basis }]),
                )
              : null,
            supportShare: rec?.supportShare ?? null,
            coin: s.outcome.coin,
            timings: s.outcome.chain.timingsMs,
            workerMs: s.outcome.timingsMs,
            wallMs: s.buildWallMs,
            heap: s.buildHeap,
          }
        : null,
      exportInfo: s.exportInfo,
      debug: s.debugStats,
      validation: {
        mode: s.validationMode,
        ruler: s.ruler.verdict,
        checklistLeft: s.checklistLeft,
        runProblems: s.runLeft,
        startBlockers: s.startBlockers,
        captureIndex: s.run.captureIndex,
        liveFlatness: s.liveFlatness ? { verdict: s.liveFlatness.verdict, median: s.liveFlatness.medianMarkerRmsPx, worst: s.liveFlatness.worstMarkerRmsPx, views: s.liveFlatness.viewsUsed } : null,
        flatness: s.flatness ? { verdict: s.flatness.verdict, median: s.flatness.medianMarkerRmsPx, worst: s.flatness.worstMarkerRmsPx, ratio: s.flatness.edgeVsCentreRatio, views: s.flatness.viewsUsed } : null,
        valid: s.valid,
      },
      device: s.deviceSnapshot,
    };
  });

  const blockedReason = live && !live.gate.ok ? live.gate.words : null;
  const sizeCheck = s.coin?.size_check ? sizeCheckWording(s.coin) : null;

  return (
    <main className="rc-root">
      <header className="rc-head">
        <p className="rc-kicker">Experiment · dev only · not in the app</p>
        <h1>3D hand from a printed board</h1>
        <p className="rc-badge" role="note" data-testid="experimental-badge">
          <strong>EXPERIMENTAL</strong> · not validated · nothing leaves this device
        </p>
        <p className="rc-lede">
          Photos of your hand resting on a printed marker board, taken from straight above and from low all round, are turned into an experimental 3D shape (a visual hull)
          and measured in millimetres. It has never been compared with physical measurements.
        </p>
      </header>

      {s.configError && (
        <p className="rc-card rc-warn" role="alert">
          The settings (GET /api/config) could not be loaded: {s.configError}. The coin check needs them; capture still works.
        </p>
      )}
      {s.notice && (
        <p className="rc-card rc-warn" role="alert" data-testid="notice">
          {s.notice}
        </p>
      )}

      {s.phase === "guide" && (
        <section className="rc-card rc-guide" aria-label="Before you start" data-testid="guide">
          <h2>Before you start</h2>
          <ol className="rc-steps">
            <li>
              <button type="button" className="btn btn-primary" onClick={s.downloadBoard} data-testid="download-board">
                Download the board (A4, print at 100 % / actual size)
              </button>
              <span className="rc-small">Print it landscape on A4 at 100 % ("Actual size"), never "Fit to page".</span>
            </li>
            <li>
              <strong>Check:</strong> each black square must measure 30.0 mm with a ruler. If not, reprint at actual size.
            </li>
            <li>
              Put the coin between the four grey ticks:{" "}
              {s.coin ? (
                <strong data-testid="coin-label">
                  {s.coin.label}, {mmText(s.coin.diameter_mm)} mm
                </strong>
              ) : s.configError ? (
                "the coin from the settings (not loaded)"
              ) : (
                "loading the coin from the settings…"
              )}
              .{s.coinChoice?.note && <span className="rc-small"> {s.coinChoice.note}</span>}
              {sizeCheck && (
                <label className="rc-check">
                  <input type="checkbox" checked={s.coinConfirmed} onChange={(e) => s.setCoinConfirmed(e.target.checked)} />
                  {sizeCheck}
                </label>
              )}
            </li>
            <li>Rest your hand palm-down on the white middle: wrist at the open left edge (no markers there), fingers slightly apart toward the coin, fingertips short of the coin.</li>
            <li>Keep the hand completely still until every view is taken. Someone else holds the phone, or use your other hand.</li>
            <li>Plain background, even light, no glare on the paper. Keep the phone the same way round (portrait or landscape) for every view.</li>
            <li>Views: first one from straight above, then a low ring all round, about level with the fingertips. The dial shows what is still needed.</li>
          </ol>
          {s.validationMode ? (
            <>
              <p className="rc-badge rc-badge-val" data-testid="validation-badge">
                <strong>Validation mode</strong> · board check and test-run details are required before the camera starts
              </p>
              <BoardPrintCheck required text={s.rulerText} onText={s.setRulerText} ruler={s.ruler} checklist={s.checklist} onChecklist={s.setChecklist} conditions={s.run.conditions} />
              <RunDetailsPanel run={s.run} onRun={s.setRun} problems={s.runLeft} />
            </>
          ) : (
            <details className="rc-more">
              <summary>Check the print with a ruler (optional)</summary>
              <BoardPrintCheck required={false} text={s.rulerText} onText={s.setRulerText} ruler={s.ruler} checklist={s.checklist} onChecklist={s.setChecklist} conditions={[]} />
            </details>
          )}
          {s.cameraError && (
            <div className="rc-warn" role="alert" data-testid="camera-error">
              <strong>{s.cameraError.title}.</strong> {s.cameraError.message}
            </div>
          )}
          {s.startBlockers.length > 0 && (
            <div className="rc-blockers" role="note" data-testid="start-blockers">
              <strong>Before the camera can start:</strong>
              <ul>
                {s.startBlockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          )}
          <button type="button" className="btn btn-primary btn-lg" onClick={() => void s.startCamera()} disabled={s.startBlockers.length > 0} data-testid="start-camera">
            {s.captures.length ? "Back to the camera" : "Start camera (rear)"}
          </button>
        </section>
      )}

      <section className="rc-live" hidden={!showStage} aria-label="Live capture" data-testid="live">
        <div className="rc-stage-col">
          <div className="rc-stage" style={live ? { aspectRatio: `${live.size.width} / ${live.size.height}` } : undefined}>
            <video ref={s.videoRef} className="rc-video" playsInline muted data-testid="video" />
            <canvas ref={s.overlayRef} className="rc-overlay" aria-hidden="true" />
            {s.phase === "starting" && <p className="rc-stage-msg">Starting the camera…</p>}
          </div>
          <p className="rc-guidance" role="status" aria-live="polite" data-testid="guidance">
            {live ? live.guidance : "Point the camera at the printed board."}
          </p>
        </div>
        <div className="rc-side">
          <div className="rc-card rc-coverage">
            <CoverageDial
              filled={s.filled}
              current={live && live.analysis.elevationDeg !== null && live.analysis.azimuthDeg !== null ? { elevationDeg: live.analysis.elevationDeg, azimuthDeg: live.analysis.azimuthDeg } : null}
              currentBin={live?.gate.bin ?? null}
              thumb={s.thumbSide}
            />
            <dl className="rc-readout" data-testid="readout">
              <dt>Markers</dt>
              <dd>{live ? live.analysis.markers : "–"}</dd>
              <dt>Height</dt>
              <dd>{live?.analysis.elevationDeg != null ? `${Math.round(live.analysis.elevationDeg)}°` : "–"}</dd>
              <dt>Around</dt>
              <dd>{live?.analysis.azimuthDeg != null ? `${Math.round(live.analysis.azimuthDeg)}°` : "–"}</dd>
            </dl>
            <p className="rc-small">Live angles use an assumed focal length (guidance only); the camera is calibrated from all the photos afterwards.</p>
          </div>
          <div className="rc-card rc-controls">
            <button type="button" className="btn btn-primary" onClick={s.takeView} disabled={!live?.gate.ok || s.manualArmed} data-testid="take-view">
              Take this view
            </button>
            <p className="rc-small" data-testid="gate-reason">
              {blockedReason ?? (live ? live.gate.words : "Waiting for the camera.")}
            </p>
            <label className="rc-check">
              <input type="checkbox" checked={s.autoCapture} onChange={(e) => s.setAutoCapture(e.target.checked)} data-testid="auto-capture" />
              Capture automatically when a needed view is steady and sharp
            </label>
            {s.trackerNote && <p className="rc-warn">{s.trackerNote}</p>}
          </div>
          {s.liveFlatness && (
            <div className="rc-card rc-live-flat">
              <FlatnessSummary flatness={s.liveFlatness} live testId="live-flatness" />
              <p className="rc-small">From the views taken so far, with the camera calibrated from them (as the build will do). A warning only.</p>
            </div>
          )}
        </div>
      </section>

      {(showStage || s.phase === "guide") && s.captures.length > 0 && (
        <section className="rc-card" aria-label="Captured views" data-testid="captures">
          <h2 className="rc-h3">
            Views taken: {s.captures.length} <span className="rc-small">({s.captures.filter((c) => c.landmarks).length} with hand landmarks)</span>
          </h2>
          <ul className="rc-thumbs">
            {s.captures.map((c: Capture) => (
              <li key={c.id} className="rc-thumb" data-testid="capture-thumb">
                <Thumb data={c.thumb} label={`View ${c.id}`} />
                <span className="rc-thumb-text">
                  {binWords(c.bin, s.thumbSide)}
                  <br />
                  {c.markers} markers{c.landmarks ? "" : ", no landmarks"}
                </span>
                <button type="button" className="rc-remove" onClick={() => s.removeCapture(c.id)} aria-label={`Remove view ${c.id}`}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <p className="rc-small" data-testid="missing">
            {s.missingText || "Every required view is taken."}
          </p>
          <button type="button" className="btn btn-primary btn-lg" onClick={() => void s.build()} disabled={s.missing.length > 0} data-testid="build">
            Build 3D hand
          </button>
          {s.missing.length > 0 && <p className="rc-small">"Build 3D hand" needs the top view and all 12 low views.</p>}
        </section>
      )}

      {s.phase === "building" && (
        <section className="rc-card rc-building" aria-label="Building" data-testid="building">
          <p className="rc-status" role="status" aria-live="polite">
            <span className="rc-spin" aria-hidden="true" /> {s.progressText}
          </p>
          <p className="rc-small">
            Working on {s.captures.length} photos: about 20 to 60 s (longer on an older phone). The camera is off meanwhile. Nothing is uploaded.
          </p>
        </section>
      )}

      {s.phase === "result" && (
        <ReconResult
          outcome={s.outcome}
          error={s.buildError}
          captures={s.captures}
          coinLabel={s.coin?.label ?? "the coin"}
          binText={s.binText}
          wallMs={s.buildWallMs}
          heap={s.buildHeap}
          includePhotos={s.includePhotos}
          onIncludePhotos={s.setIncludePhotos}
          onExport={() => void s.exportZip()}
          exportInfo={s.exportInfo}
          photosLost={s.photosLost}
          validationMode={s.validationMode}
          ruler={s.rulerEntered || s.validationMode ? s.ruler : null}
          flatness={s.flatness}
          valid={s.valid}
          onBack={s.backToCapture}
          onStartOver={s.startOver}
        />
      )}

      {s.debug && (
        <section className="rc-card rc-debug" aria-label="Debug" data-testid="debug">
          <h2 className="rc-h3">Debug (live)</h2>
          {s.debugStats ? (
            <dl className="rc-dl">
              <dt>Analysed frames</dt>
              <dd>
                {s.debugStats.frames} ({s.debugStats.analysedFps.toFixed(1)} per s; camera {s.debugStats.cameraFps.toFixed(1)} fps)
              </dd>
              <dt>Marker detection</dt>
              <dd>
                {s.debugStats.detectMs?.toFixed(0)} ms (median {s.debugStats.detectMedianMs?.toFixed(0)} ms), whole analysis {s.debugStats.totalMs?.toFixed(0)} ms
              </dd>
              <dt>Pose RMS (assumed focal)</dt>
              <dd>{s.debugStats.poseRmsPx !== null ? `${s.debugStats.poseRmsPx.toFixed(2)} px` : "no pose"}</dd>
              <dt>Sharpness</dt>
              <dd>{live?.analysis.sharpness != null ? live.analysis.sharpness.toFixed(2) : "–"}</dd>
              <dt>Steadiness</dt>
              <dd>{live?.analysis.steady ? `${live.analysis.steady.rotDeg.toFixed(2)}°, ${live.analysis.steady.moveMm.toFixed(1)} mm` : "–"}</dd>
              <dt>Misread markers dropped</dt>
              <dd>{s.debugStats.inconsistent}</dd>
              <dt>Rejected candidates (this frame)</dt>
              <dd>{Object.entries(s.debugStats.rejectedLast).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}</dd>
              <dt>Rejected candidates (all frames)</dt>
              <dd>{Object.entries(s.debugStats.rejectedTotal).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}</dd>
              <dt>JS heap</dt>
              <dd>{s.debugStats.heapMb !== null ? `${s.debugStats.heapMb} MB` : "not available in this browser"}</dd>
            </dl>
          ) : (
            <p className="rc-small">Live figures start with the camera.</p>
          )}
          <DeviceLogPanel log={s.deviceSnapshot} />
        </section>
      )}

      <footer className="rc-foot">
        EXPERIMENTAL research page. Not validated: never use it for sizing. The only network request is GET /api/config; photos stay in this tab and are saved only if you
        download them.
      </footer>
    </main>
  );
}
