// The EXPERIMENTAL guided multi-view capture prototype (dev-only page, see README.md). Nothing here is part of the customer
// app: it is not built into the production bundle, it is not linked from anywhere, and it uploads nothing.
import { useEffect, useRef, useState } from "react";
import { browserEnv, probeDepthSensing, type DepthProbeResult } from "../depth";
import { customerCoins } from "../../ui/settings";
import { MODEL_LABEL, NO_COIN_NOTE, reasonWords } from "./analysis";
import { drawAnalysis } from "./render";
import { AUTO_CAPTURE_FRAMES, MIN_SHARPNESS } from "./metrics";
import { SimulatedDemo } from "./SimulatedDemo";
import type { CapturedView } from "./types";
import { useCapture, type AnalysisState, type CaptureApi } from "./useCapture";
import "./capture.css";

const fmt = (v: number | null | undefined, digits = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "n/a" : v.toFixed(digits));

function Chip({ state, children }: { state: "ok" | "bad" | "na"; children: React.ReactNode }) {
  return (
    <span className={`xp-chip is-${state}`} role="status">
      <i aria-hidden="true" />
      {children}
    </span>
  );
}

const POSE_WORDS: Record<string, string> = {
  bones_changed: "the proportions of the fingers or palm differ from the other views",
  fingers_flexed: "the fingers are bent differently from the other views",
  palm_cupped: "the palm is cupped differently from the other views",
};

function LiveChips({ api }: { api: CaptureApi }) {
  const { live, current } = api;
  if (!current) return null;
  const chips = live?.chips ?? null;
  const running = live?.phase === "running";
  return (
    <>
      <div className="xp-chips" aria-label="Live checks for this view">
        <Chip state={chips ? "ok" : "bad"}>Hand: {chips ? "found" : running ? "not found" : "camera off"}</Chip>
        {chips && <Chip state={chips.inFrame ? "ok" : "bad"}>In the picture: {chips.inFrame ? "yes" : "no"}</Chip>}
        {chips &&
          (chips.coin.required ? (
            <Chip state={chips.coin.accepted ? "ok" : "bad"}>Coin: {chips.coin.accepted ? "accepted" : chips.coin.found ? "found, not accepted" : "not found"}</Chip>
          ) : (
            <Chip state="na">Coin: not needed in this view</Chip>
          ))}
        {chips && <Chip state={chips.posture.verdict === "n/a" ? "na" : chips.posture.ok ? "ok" : "bad"}>Posture: {chips.posture.verdict === "n/a" ? "not judged" : chips.posture.ok ? "right" : chips.posture.verdict === "unknown" ? "judging…" : "adjust"}</Chip>}
        {chips && (
          <Chip state={chips.steady.steady ? "ok" : "bad"}>
            Steady: {chips.steady.jitter === null ? "measuring…" : `${(chips.steady.jitter * 100).toFixed(1)} % jitter`}
          </Chip>
        )}
        {chips && (
          <Chip state={chips.sharpness.sharp ? "ok" : "bad"}>
            Sharp: {fmt(chips.sharpness.value, 4)} (min {MIN_SHARPNESS})
          </Chip>
        )}
        {chips && (
          <Chip state={live!.goodRun >= AUTO_CAPTURE_FRAMES ? "ok" : "na"}>
            Good frames: {Math.min(live!.goodRun, AUTO_CAPTURE_FRAMES)} / {AUTO_CAPTURE_FRAMES}
          </Chip>
        )}
      </div>
      {live && live.reasons.length > 0 && (
        <ul className="xp-reasons" aria-label="Why this frame is not good yet">
          {live.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function LiveSection({ api }: { api: CaptureApi }) {
  const { live, current, views, captured, skipped, config, includeObliques, reference } = api;
  const running = live?.phase === "running";
  const loading = live?.phase === "starting" || live?.phase === "loading";
  const aspect = live?.video ? `${live.video.width} / ${live.video.height}` : "4 / 3";
  const canCapture = running && !!live?.chips;
  const failing = !!live && live.reasons.length > 0;
  return (
    <section className="xp-card xp-live" aria-labelledby="xp-live-h">
      <div>
        <h2 id="xp-live-h">1. Capture the views</h2>
        <div className="xp-video" style={{ aspectRatio: aspect }}>
          <video ref={api.videoRef} className={live?.mirrored ? "xp-mirrored" : ""} playsInline muted aria-label="Live camera picture" />
          <canvas ref={api.overlayRef} className={live?.mirrored ? "xp-mirrored" : ""} aria-hidden="true" />
          {!running && (
            <div className="xp-video-note">
              {loading ? "Loading the camera and the hand and coin detectors…" : live?.phase === "error" ? "The camera could not start (see below)." : "The camera is off. Start it to begin."}
            </div>
          )}
        </div>
        {live?.phase === "error" && live.error && (
          <p className="xp-notice xp-error" role="alert">
            <strong>{live.error.title}.</strong> {live.error.message}
          </p>
        )}
        {running && live && (
          <p className="xp-small xp-muted" aria-label="Camera details">
            Camera {live.video ? `${live.video.width}x${live.video.height}` : ""}, {live.fps.toFixed(0)} frames per second, hand tracker: {live.engines?.tracker}, coin search: {live.engines?.coin}.
          </p>
        )}
        <div className="xp-row" style={{ marginTop: 10 }}>
          {!running ? (
            <button className="xp-btn xp-btn-primary" onClick={() => void api.startCamera()} disabled={!config || loading}>
              {loading ? "Starting…" : "Start camera"}
            </button>
          ) : (
            <button className="xp-btn" onClick={api.stopCamera}>
              Stop camera
            </button>
          )}
        </div>
        <div className="xp-row" style={{ marginTop: 8, alignItems: "end" }}>
          <label className="xp-field" htmlFor="xp-coin">
            Coin you will use
            <select id="xp-coin" value={api.refId} onChange={(e) => api.setRefId(e.target.value)} disabled={!config}>
              {config &&
                customerCoins(config).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}, {o.diameter_mm.toFixed(2)} mm
                  </option>
                ))}
            </select>
          </label>
          <label className="xp-check">
            <input type="checkbox" checked={includeObliques} onChange={(e) => api.setIncludeObliques(e.target.checked)} />
            Add the two optional 45-degree views
          </label>
          <label className="xp-check">
            <input type="checkbox" checked={api.autoCapture} onChange={(e) => api.setAutoCapture(e.target.checked)} />
            Capture automatically when every check passes
          </label>
        </div>
        {api.configError && (
          <p className="xp-notice xp-error" role="alert">
            Could not read the public settings (GET /api/config): {api.configError}. Start the backend (see the README) and reload.
          </p>
        )}
      </div>

      <div>
        <h2>Guide</h2>
        <ol className="xp-steps" aria-label="Views">
          {views.map((v, i) => {
            const c = captured[v.id];
            const done = !!c;
            const unchecked = done && !c.quality.passed;
            const isSkipped = skipped.includes(v.id);
            return (
              <li key={v.id} className={`xp-step ${current?.id === v.id ? "is-current" : ""} ${done && !unchecked ? "is-done" : ""} ${unchecked ? "is-unchecked" : ""}`} aria-current={current?.id === v.id ? "step" : undefined}>
                <span className="xp-step-num" aria-hidden="true">
                  {done ? (unchecked ? "!" : "✓") : i + 1}
                </span>
                <span className="xp-step-text">
                  {v.title}
                  {v.optional ? " (optional)" : ""}
                  {done ? (unchecked ? ": captured, checks not passed" : ": captured") : isSkipped ? ": skipped" : ""}
                </span>
              </li>
            );
          })}
        </ol>
        {current ? (
          <div aria-live="polite">
            <h3>{current.title}</h3>
            <p style={{ margin: "0 0 6px" }}>{current.instruction}</p>
            <p className="xp-small xp-muted" style={{ margin: 0 }}>
              <strong>What this view is for:</strong> {current.purpose}
            </p>
            <LiveChips api={api} />
            <div className="xp-row">
              <button className="xp-btn xp-btn-primary" onClick={api.captureNow} disabled={!canCapture}>
                {failing ? "Capture anyway (checks not passed)" : "Capture now"}
              </button>
              <button className="xp-btn" onClick={() => api.skip(current.id)}>
                Skip this view
              </button>
            </div>
            {failing && canCapture && <p className="xp-small xp-muted">A view captured while a check fails is kept and marked "checks not passed" with the reasons. Nothing is passed on your behalf.</p>}
          </div>
        ) : (
          <p className="xp-notice">Every view is captured or skipped. Look at the analysis below, then export or clear.</p>
        )}
      </div>
      <p className="xp-small xp-muted" style={{ gridColumn: "1 / -1", margin: 0 }}>
        Reference coin: {reference ? `${reference.label}, ${reference.diameter_mm.toFixed(2)} mm (read from the app's public settings)` : "loading…"}. Captured views live only in this page's memory: reloading the page
        or "Clear all captures" removes them.
      </p>
    </section>
  );
}

function ResultCard({ view, state, api }: { view: CapturedView; state: AnalysisState | undefined; api: CaptureApi }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvasRef.current) return;
    drawAnalysis(canvasRef.current, view.still.pixels, state?.state === "done" ? state.result : null, view.coin, 640);
  }, [view, state]);
  const a = view.analysis;
  const seg = a?.segmentation ?? null;
  const scale = a?.scale ?? null;
  const done = state?.state === "done" ? state : null;
  return (
    <article className="xp-card xp-result" aria-label={`Analysis of ${view.def.title}`}>
      <h3 style={{ marginTop: 0 }}>{view.def.title}</h3>
      <canvas ref={canvasRef} aria-label={`${view.def.title} with the experimental hand mask`} />
      <p className="xp-small" style={{ margin: "8px 0 0" }}>
        {view.quality.passed ? "Captured with every live check passed." : `Captured WITHOUT passing every check: ${view.quality.reasons.join(" ")}`}
      </p>
      {(!state || state.state === "running") && <p className="xp-notice">Analysing this view in the background (GrabCut hand segmentation)…</p>}
      {state?.state === "error" && (
        <p className="xp-notice xp-error" role="alert">
          The analysis failed: {state.message}
        </p>
      )}
      {done && seg && (
        <>
          <div className={`xp-notice ${seg.ok ? "" : "xp-notice-warn"}`} role="status">
            <strong>Segmentation {seg.ok ? "accepted by the quality gates" : "rejected by the quality gates"}.</strong>
            {seg.reasons.length > 0 && (
              <>
                {" "}
                Because:
                <ul style={{ margin: "4px 0 0", paddingLeft: "1.1em" }}>
                  {seg.reasons.map((r) => (
                    <li key={r}>{reasonWords(r)}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
          <dl className="xp-kv">
            <dt>Projected hand area (pixels)</dt>
            <dd>{seg.areaPx > 0 ? `${Math.round(seg.areaPx).toLocaleString("en-US")} px²` : "n/a"}</dd>
            <dt>Fingertips found in the mask</dt>
            <dd>{seg.fingertips.filter(Boolean).length} of 5</dd>
            <dt>Finger gaps kept open</dt>
            <dd>{seg.gapsPreserved.filter(Boolean).length} of 4</dd>
            <dt>Wrist cut width</dt>
            <dd>{seg.wristWidthPx > 0 ? `${Math.round(seg.wristWidthPx)} px` : "n/a"}</dd>
            <dt>Segmentation time</dt>
            <dd>
              {Math.round(done.wallMs)} ms ({done.where})
            </dd>
          </dl>
        </>
      )}
      {scale && (
        <>
          <h4 style={{ margin: "12px 0 4px", fontSize: "0.88rem" }}>Millimetre figures (model estimate)</h4>
          {scale.available ? (
            <dl className="xp-kv">
              <dt>Scale at the coin's plane</dt>
              <dd>{fmt(scale.mmPerPx, 3)} mm per pixel</dd>
              <dt>Coin plane tilt</dt>
              <dd>{fmt(scale.coinTiltDeg, 1)}° (sign unknown)</dd>
              <dt>Silhouette area at that scale</dt>
              <dd>{scale.areaMm2 === null ? "withheld (segmentation rejected)" : `${Math.round(scale.areaMm2).toLocaleString("en-US")} mm²`}</dd>
              <dt>Wrist to middle fingertip (landmarks)</dt>
              <dd>
                {fmt(scale.handLengthLandmarkMm, 0)} mm{scale.handLengthUncertaintyMm !== null ? ` ± ${fmt(scale.handLengthUncertaintyMm, 1)} mm` : ""}
              </dd>
            </dl>
          ) : null}
          <p className="xp-small xp-muted" style={{ margin: "6px 0 0" }}>
            {scale.available ? `${MODEL_LABEL} The ± is the model's own error budget, not a measured accuracy.` : scale.note || NO_COIN_NOTE}
          </p>
        </>
      )}
      <div className="xp-row" style={{ marginTop: 10 }}>
        <button className="xp-btn" onClick={() => api.reanalyse(view.def.id)} disabled={state?.state === "running"}>
          Run the analysis again
        </button>
        <button className="xp-btn" onClick={() => api.retake(view.def.id)}>
          Retake this view
        </button>
      </div>
    </article>
  );
}

function AnalysisSection({ api }: { api: CaptureApi }) {
  return (
    <section aria-labelledby="xp-an-h" className="xp-card">
      <h2 id="xp-an-h">2. Analysis of the captured views</h2>
      {api.capturedList.length === 0 ? (
        <p className="xp-muted xp-small">Nothing captured yet. After each capture the experimental hand segmentation runs on that frame, on this device.</p>
      ) : (
        <div className="xp-results">
          {api.capturedList.map((v) => (
            <ResultCard key={`${v.def.id}-${v.capturedAt}`} view={v} state={api.analysis[v.def.id]} api={api} />
          ))}
        </div>
      )}
    </section>
  );
}

function PoseSection({ api }: { api: CaptureApi }) {
  const { pose, capturedList } = api;
  const title = (id: string) => capturedList.find((v) => v.def.id === id)?.def.title ?? id;
  return (
    <section className="xp-card" aria-labelledby="xp-pose-h">
      <h2 id="xp-pose-h">3. Did the hand keep its pose between views?</h2>
      {!pose ? (
        <p className="xp-muted xp-small">This needs at least two captured views with 3D hand landmarks. It compares bone proportions, finger bend and palm cupping between views.</p>
      ) : (
        <>
          <p className={`xp-notice ${pose.flaggedIds.length ? "xp-notice-warn" : ""}`} role="status">
            {pose.flaggedIds.length === 0 ? "No view differs from the others by more than the (provisional) tolerances." : `Flagged: ${pose.flaggedIds.map(title).join(", ")}.`}
          </p>
          <ul className="xp-small" style={{ paddingLeft: "1.1em" }}>
            {pose.views.map((v) => (
              <li key={v.id}>
                <strong>{title(v.id)}:</strong> {v.flagged ? `differs, ${v.reasons.map((r) => POSE_WORDS[r] ?? r).join("; ")}` : "consistent with the others"}
              </li>
            ))}
          </ul>
          {pose.notes.map((n) => (
            <p key={n} className="xp-small xp-muted">
              {n}
            </p>
          ))}
        </>
      )}
    </section>
  );
}

function MarkerSection() {
  return (
    <section className="xp-card" aria-labelledby="xp-marker-h">
      <h2 id="xp-marker-h">4. Marker sheet and camera poses</h2>
      <p className="xp-notice xp-notice-warn" role="note">
        <strong>Marker-sheet pose estimation is NOT implemented yet.</strong> The OpenCV.js build in this app has no aruco, chessboard, cornerSubPix or calibrateCamera, so no camera pose is estimated, recorded or invented.
        These captures therefore <strong>cannot be reconstructed in 3D yet</strong>. The export says so in its manifest (<code>marker.implemented: false</code>).
      </p>
    </section>
  );
}

function DepthSection({ api }: { api: CaptureApi }) {
  const d = api.depth;
  const [probe, setProbe] = useState<DepthProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  return (
    <section className="xp-card" aria-labelledby="xp-depth-h">
      <h2 id="xp-depth-h">5. What depth can this phone give a web page?</h2>
      {!d ? (
        <p className="xp-muted xp-small">Checking…</p>
      ) : (
        <>
          <dl className="xp-kv">
            <dt>Platform</dt>
            <dd>{d.platform}</dd>
            <dt>Secure (HTTPS) page</dt>
            <dd>{d.secureContext ? "yes" : "no"}</dd>
            <dt>WebXR present</dt>
            <dd>{d.webxr ? "yes" : "no"}</dd>
            <dt>Immersive AR sessions</dt>
            <dd>{d.immersiveAr === null ? "not asked" : d.immersiveAr ? "supported" : "not supported"}</dd>
            <dt>AR depth sensing</dt>
            <dd>{d.depthSensing.status === "not_available" ? "not available" : "unknown until you tap Try"}</dd>
            <dt>Recommended path</dt>
            <dd>{d.recommendedPath === "rgb_only" ? "RGB only" : "RGB, with AR depth worth trying"}</dd>
          </dl>
          <p className="xp-small" style={{ margin: "8px 0 0" }}>
            {d.depthSensing.reason}
          </p>
          <p className="xp-notice" role="note" style={{ marginTop: 8 }}>
            <strong>iPhone and iPad:</strong> Safari cannot give a web page any depth (no WebXR AR). LiDAR and ARKit scene depth need a native app. The RGB camera is the baseline everywhere.
          </p>
          {d.notes.map((n) => (
            <p key={n} className="xp-small xp-muted">
              {n}
            </p>
          ))}
          <p className="xp-small xp-muted">{d.mediapipeWorld.note}</p>
          <div className="xp-row">
            <button
              className="xp-btn"
              disabled={probing || d.depthSensing.status !== "unknown_until_user_gesture"}
              onClick={async (e) => {
                setProbing(true);
                setProbe(await probeDepthSensing(browserEnv(), { isTrusted: e.nativeEvent.isTrusted }));
                setProbing(false);
              }}
            >
              Try an AR depth session (Android Chrome)
            </button>
          </div>
          {probe && (
            <p className="xp-notice" role="status" style={{ marginTop: 8 }}>
              Depth probe: <strong>{probe.status.replace(/_/g, " ")}</strong>
              {probe.usage ? `, usage ${probe.usage}` : ""}
              {probe.dataFormat ? `, format ${probe.dataFormat}` : ""}
              {probe.error ? `. ${probe.error}` : ""}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function ExportSection({ api }: { api: CaptureApi }) {
  const n = api.capturedList.length;
  return (
    <section className="xp-card" aria-labelledby="xp-export-h">
      <h2 id="xp-export-h">6. Export or clear</h2>
      <p className="xp-small xp-muted" style={{ marginTop: 0 }}>
        The bundle is an uncompressed ZIP built in this browser: <code>manifest.json</code> (landmarks, coin detection, camera settings, checks, analysis; no pixels), the captured frames, the masks and a
        README. It is a download to this device only. Photographs of a hand are personal data: keep them private.
      </p>
      <div className="xp-row">
        <button className="xp-btn xp-btn-primary" onClick={() => void api.exportBundle()} disabled={n === 0}>
          Download capture bundle (this device only)
        </button>
        <button className="xp-btn xp-btn-danger" onClick={api.clearAll} disabled={n === 0 && api.skipped.length === 0}>
          Clear all captures
        </button>
      </div>
      {api.exportError && (
        <p className="xp-notice xp-error" role="alert">
          {api.exportError}
        </p>
      )}
      {api.exportInfo && (
        <div role="status" aria-label="Last export">
          <p className="xp-small">
            Built <strong>{api.exportInfo.filename}</strong> ({(api.exportInfo.bytes / 1024).toFixed(0)} KB, {api.exportInfo.names.length} files):
          </p>
          <ul className="xp-small" aria-label="Files in the bundle" style={{ paddingLeft: "1.1em" }}>
            {api.exportInfo.names.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function CapturePage() {
  const api = useCapture();
  return (
    <div className="xp-root">
      <div className="xp-banner" role="note">
        <strong>EXPERIMENTAL research prototype, not the customer app.</strong> Images stay on this device; nothing is uploaded.
      </div>
      <main className="xp-wrap">
        <header className="xp-card">
          <h1 className="xp-title">Guided hand capture</h1>
          <p className="xp-small" style={{ margin: "6px 0 0" }}>
            A research tool for collecting multi-view captures (palm, two edge-on profiles, back of hand) with the hand and coin quality checks, an experimental hand outline, and a local export. It does not give a
            glove size and is not connected to the sizing service. Every millimetre figure is a model estimate and unvalidated.
          </p>
          <p className="xp-small xp-muted" style={{ margin: "6px 0 0" }}>
            Not yet done (see the README): marker-sheet camera poses, real 3D reconstruction of these captures, and any validation against physical measurements.
          </p>
          <div aria-live="polite" className="visually-hidden" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
            {api.announce}
          </div>
          {api.announce && (
            <p className="xp-notice" role="status" style={{ marginTop: 8 }}>
              {api.announce}
            </p>
          )}
        </header>
        <LiveSection api={api} />
        <AnalysisSection api={api} />
        <PoseSection api={api} />
        <MarkerSection />
        <DepthSection api={api} />
        <ExportSection api={api} />
        <SimulatedDemo />
      </main>
    </div>
  );
}
