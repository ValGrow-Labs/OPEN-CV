// The EXPERIMENTAL dense surface-point scan page (dev-only, /experiment/dense/). Not part of the customer app: it is not in
// the production build, not linked from anywhere, and it uploads nothing. See README.md.
import { useState } from "react";
import { LIVE_MESSAGES } from "../../../vision/liveChecks";
import { AUTO_CAPTURE_FRAMES, MIN_SHARPNESS } from "../../capture/metrics";
import { MeshViewer } from "../../reconstruction/MeshViewer";
import type { Quantity } from "../../common";
import { sizeCheckWording } from "./coin";
import { GROUP_TITLES, type Group, type GroupStatus } from "./gate";
import { captionFor, liveGuidance, QUALITY_WORDS, rejectBreakdown, scanQuality } from "./helpers";
import { DEFAULT_SETTINGS, useDenseScan, type DenseApi, type DenseSettings } from "./useDenseScan";
import "./dense.css";

const DEBUG = typeof location !== "undefined" && new URLSearchParams(location.search).has("debug");

const fmt = (v: number | null | undefined, digits = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "n/a" : v.toFixed(digits));
const int = (v: number) => v.toLocaleString("en-GB");

// Short labels: seven of them must fit a 320 px screen (the list wraps onto two rows below about 400 px).
const PHASE_STEPS: { phase: string; label: string; title: string }[] = [
  { phase: "waiting_hand", label: "Hand", title: "Waiting for the hand" },
  { phase: "segmenting", label: "Outline", title: "Finding the hand's outline" },
  { phase: "sweeping", label: "Scan", title: "Scanning line" },
  { phase: "validating", label: "Check", title: "Checking the points" },
  { phase: "captured", label: "Freeze", title: "Snapshot frozen" },
  { phase: "processing", label: "Build", title: "Building the point cloud and mesh" },
  { phase: "done", label: "Done", title: "Scan complete" },
];

const BASIS_WORDS: Record<Quantity["basis"], string> = {
  direct: "Direct: read from the hand's pixels",
  model: "Model: rests on an assumption (see note)",
  none: "Not available from one photo",
};

const MEASURE_NAMES: Record<string, string> = {
  hand_length: "Hand length",
  palm_breadth: "Palm breadth",
  thumb_length: "Thumb length",
  index_length: "Index finger length",
  middle_length: "Middle finger length",
  ring_length: "Ring finger length",
  little_length: "Little finger length",
  projected_area: "Projected hand area",
  accepted_points: "Accepted points",
  thickness: "Hand thickness",
  circumference: "Circumference",
  surface_area_3d: "3D skin surface area",
};

const REGION_WORDS: Record<string, string> = {
  thumb: "Thumb",
  index: "Index finger",
  middle: "Middle finger",
  ring: "Ring finger",
  little: "Little finger",
  palm: "Palm",
  wrist: "Wrist",
  unknown: "Not assigned",
};

function Chip({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  return (
    <span className={`ds-chip ${ok === null ? "is-na" : ok ? "is-ok" : "is-bad"}`}>
      <i aria-hidden="true" />
      {children}
    </span>
  );
}

function Stage({ api }: { api: DenseApi }) {
  const { live, scan, frozen } = api;
  const running = live?.phase === "running";
  const loading = live?.phase === "starting" || live?.phase === "loading";
  const w = frozen?.frame.width ?? live?.video?.width;
  const h = frozen?.frame.height ?? live?.video?.height;
  const aspect = w && h ? `${w} / ${h}` : "4 / 3";
  const mirror = live?.mirrored ? "ds-mirrored" : "";
  const frozenShown = scan.phase !== "waiting_hand" && !!frozen;
  return (
    <div ref={api.stageRef} className="ds-stage" style={{ aspectRatio: aspect }} data-frame={w && h ? `${w}x${h}` : undefined}>
      <video ref={api.videoRef} className={mirror} playsInline muted aria-label="Live camera picture" />
      <canvas ref={api.stillRef} className={`${mirror} ds-still ${frozenShown ? "is-on" : ""}`} aria-label="Frozen frame being scanned" />
      <canvas ref={api.liveRef} className={`${mirror} ds-live ${frozenShown ? "" : "is-on"}`} aria-hidden="true" />
      <canvas ref={api.dotsRef} className={`${mirror} ds-dots`} aria-hidden="true" data-testid="dots-canvas" />
      <canvas ref={api.lineRef} className={`${mirror} ds-line`} aria-hidden="true" data-testid="line-canvas" />
      {!running && !frozenShown && (
        <div className="ds-stage-note">{loading ? "Loading the camera and the hand and coin detectors…" : live?.phase === "error" ? "The camera could not start (see below)." : "The camera is off. Start it to begin."}</div>
      )}
      {running && scan.phase === "waiting_hand" && api.gate?.waitingForCoinOnly && <CoinIndicator api={api} />}
      <div className="ds-pill" role="status" aria-live="polite">
        {running && scan.phase === "waiting_hand" && live?.chips
          ? api.gate && !api.gate.allowed && api.gate.blocking && !api.gate.waitingForCoinOnly
            ? api.gate.blocking.todo
            : liveGuidance(live.chips, live.goodRun, AUTO_CAPTURE_FRAMES, api.reference?.label ?? null)
          : scan.message}
      </div>
    </div>
  );
}

/** On the camera picture: everything passes except the coin. Says what the coin engine reports and where the coin goes. */
function CoinIndicator({ api }: { api: DenseApi }) {
  const coin = api.gate!.groups.coin;
  const first = coin.reasons[0];
  return (
    <div className="ds-coinwait" role="status" data-testid="coin-indicator">
      <strong>Waiting for coin acceptance</strong>
      <span>{first ? `Coin: ${first.words}.` : "Coin: checking."}</span>
      <span>
        Put the {api.reference?.label ?? "coin"} flat in the centre of your palm, fully visible{first && first.todo && first.todo !== LIVE_MESSAGES.coin_not_found ? ` (${first.todo.toLowerCase()})` : ""}.
      </span>
    </div>
  );
}

const STATUS_WORDS: Record<GroupStatus, string> = { ok: "OK", waiting: "Waiting", failed: "Failed" };

/** The four groups of prerequisites, each with its status and the detectors' own reasons in words. */
function ReasonsPanel({ api }: { api: DenseApi }) {
  const g = api.gate;
  const groups: Group[] = g ? [g.groups.hand, g.groups.coin, g.groups.calibration, api.segGroup] : [api.segGroup];
  return (
    <section className="ds-reasonspanel" aria-label="Why a scan can or cannot start" data-testid="reasons-panel">
      {groups.map((grp) => (
        <div key={grp.id} className={`ds-group is-${grp.status}`} data-group={grp.id} data-status={grp.status}>
          <div className="ds-group-head">
            <span className="ds-group-title">{grp.title}</span>
            <span className="ds-group-status">{STATUS_WORDS[grp.status]}</span>
          </div>
          {grp.reasons.length > 0 && (
            <ul>
              {grp.reasons.map((r) => (
                <li key={r.code} data-code={r.code}>
                  {r.words}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}

/** The coin: chosen from the served settings, with its size, the size allowance, the source and the hint. */
function CoinPanel({ api }: { api: DenseApi }) {
  const ref = api.reference;
  const locked = api.scan.phase !== "waiting_hand" && api.scan.phase !== "done" && api.scan.phase !== "rejected";
  return (
    <section className="ds-coinpanel" aria-label="Coin" data-testid="coin-panel">
      <label className="ds-field" htmlFor="ds-coin">
        Coin on the palm
        <select id="ds-coin" value={api.refId} onChange={(e) => api.setRefId(e.target.value)} disabled={!api.config || locked}>
          {api.coins.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
              {o.availability === "pilot" ? " (pilot)" : ""}, {o.diameter_mm.toFixed(2)} mm
            </option>
          ))}
        </select>
      </label>
      {api.coinNote && (
        <p className="ds-notice ds-small" role="status" data-testid="coin-note">
          {api.coinNote}
        </p>
      )}
      {ref && (
        <dl className="ds-facts ds-small" data-testid="coin-facts">
          <div>
            <dt>Coin</dt>
            <dd data-testid="coin-label">{ref.label}</dd>
          </div>
          <div>
            <dt>Diameter</dt>
            <dd data-testid="coin-diameter">
              {ref.diameter_mm.toFixed(2)} mm ± {ref.diameter_uncertainty_mm.toFixed(2)} mm <span className="ds-muted">(the ± is an assumed allowance)</span>
            </dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd data-testid="coin-source">{ref.source}</dd>
          </div>
          {ref.customer_hint && (
            <div>
              <dt>Check</dt>
              <dd data-testid="coin-hint">{ref.customer_hint}</dd>
            </div>
          )}
        </dl>
      )}
      {ref?.size_check && (
        <label className="ds-check ds-sizecheck">
          <input type="checkbox" checked={api.sizeConfirmed} onChange={(e) => api.setSizeConfirmed(e.target.checked)} disabled={locked} />
          {sizeCheckWording(ref)}
        </label>
      )}
      <p className="ds-small ds-muted">
        From the served settings (GET /api/config).{api.coinVia === "preferred" ? " This experiment prefers this coin when the settings enable it; ?coin=<id> in the address chooses another." : ""}
      </p>
    </section>
  );
}

function Steps({ phase }: { phase: string }) {
  const at = PHASE_STEPS.findIndex((s) => s.phase === phase);
  return (
    <ol className="ds-steps" aria-label="Scan phases">
      {PHASE_STEPS.map((s, i) => (
        <li key={s.phase} title={s.title} className={phase === "rejected" ? "" : i < at ? "is-done" : i === at ? "is-now" : ""} aria-current={i === at ? "step" : undefined}>
          {s.label}
        </li>
      ))}
    </ol>
  );
}

function DisplayNote({ api }: { api: DenseApi }) {
  const d = api.display;
  if (!d || !api.pointSet) return null;
  return (
    <p className="ds-small ds-muted ds-displaynote" data-testid="display-note">
      {d.k > 1
        ? `Showing 1 in ${d.k * d.k} dots on this screen (${int(d.shownAccepted)} of ${int(d.totalAccepted)} accepted dots drawn); all ${int(d.totalAccepted)} are kept for processing and export.`
        : `Showing every dot (${int(d.totalAccepted)} accepted).`}
    </p>
  );
}

/** Before the camera starts: is this page allowed to use it at all? */
function Readiness({ api }: { api: DenseApi }) {
  const r = api.readiness;
  if (!r.secure) {
    return (
      <div className="ds-notice ds-error" role="alert" data-testid="insecure">
        <strong>This page is not secure, so the browser will not open the camera.</strong> Phones only allow the camera on https (or on localhost). On the PC run{" "}
        <code>npm run dev:https</code> and open <code>https://&lt;PC address&gt;:5173/experiment/dense/</code> on the phone (see the README).
      </div>
    );
  }
  if (!r.hasCamera) {
    return (
      <p className="ds-notice ds-error" role="alert">
        This browser has no camera access (no getUserMedia). Use a recent Chrome on Android.
      </p>
    );
  }
  if (r.permission === "denied" && api.live?.phase !== "running") {
    return (
      <div className="ds-notice ds-error" role="alert" data-testid="blocked">
        <strong>Camera access is blocked for this site.</strong> In Chrome on Android: tap the icon left of the address, then Permissions, Camera, Allow. Then press Start camera again.
      </div>
    );
  }
  return null;
}

function LiveChecks({ api }: { api: DenseApi }) {
  const { live, scan } = api;
  if (live?.phase !== "running" || scan.phase !== "waiting_hand") return null;
  const c = live.chips;
  return (
    <div className="ds-chips" aria-label="Live checks">
      <Chip ok={!!c}>Hand: {c ? "detected" : "not found"}</Chip>
      {c && <Chip ok={c.coin.accepted}>Coin: {c.coin.accepted ? "accepted" : c.coin.found ? "found, not accepted" : "not found"}</Chip>}
      {c && <Chip ok={c.steady.steady}>Steady: {c.steady.jitter === null ? "measuring…" : `${(c.steady.jitter * 100).toFixed(1)} % jitter`}</Chip>}
      {c && (
        <Chip ok={c.sharpness.sharp}>
          Sharp: {fmt(c.sharpness.value, 4)} (min {MIN_SHARPNESS})
        </Chip>
      )}
      {c && (
        <Chip ok={live.goodRun >= AUTO_CAPTURE_FRAMES ? true : null}>
          Ready frames: {Math.min(live.goodRun, AUTO_CAPTURE_FRAMES)} / {AUTO_CAPTURE_FRAMES}
        </Chip>
      )}
    </div>
  );
}

function Counters({ api }: { api: DenseApi }) {
  const { scan, counts, frozen, pointSet } = api;
  const [showReasons, setShowReasons] = useState(false);
  const segOk = frozen?.seg ? frozen.seg.ok : null;
  const segWords = scan.phase === "waiting_hand" ? "waiting" : !frozen?.seg ? "running…" : frozen.seg.ok ? "accepted" : "rejected";
  const span = scan.bottom - scan.top;
  const progress = scan.phase === "waiting_hand" || scan.phase === "segmenting" ? 0 : scan.phase === "sweeping" && span > 0 ? (scan.sweepY - scan.top) / span : scan.phase === "rejected" && !pointSet ? 0 : 1;
  const quality = scanQuality(counts, segOk);
  const breakdown = rejectBreakdown(pointSet);
  const handWords = scan.phase === "waiting_hand" ? (scan.handSeen ? "detected" : "not yet") : "detected (frozen)";
  return (
    <section className="ds-card" aria-labelledby="ds-counters-h">
      <h2 id="ds-counters-h">Scan status</h2>
      <dl className="ds-counters" aria-label="Scan counters">
        <div>
          <dt>Hand</dt>
          <dd data-testid="c-hand">{handWords}</dd>
        </div>
        <div>
          <dt>Segmentation</dt>
          <dd data-testid="c-seg">{segWords}</dd>
        </div>
        <div>
          <dt>Generated points</dt>
          <dd data-testid="c-generated">{int(counts.generated)}</dd>
        </div>
        <div className="is-ok">
          <dt>Accepted</dt>
          <dd data-testid="c-accepted">{int(counts.accepted)}</dd>
        </div>
        <div className="is-bad">
          <dt>Rejected</dt>
          <dd data-testid="c-rejected">
            <button type="button" className="ds-linkbtn" onClick={() => setShowReasons((v) => !v)} aria-expanded={showReasons} disabled={!breakdown.length}>
              {int(counts.rejected)}
            </button>
          </dd>
        </div>
        <div>
          <dt>Progress</dt>
          <dd data-testid="c-progress">{Math.round(progress * 100)} %</dd>
        </div>
        <div>
          <dt>Quality</dt>
          <dd data-testid="c-quality">{QUALITY_WORDS[quality]}</dd>
        </div>
      </dl>
      <div className="ds-progress" aria-hidden="true">
        <i style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      {showReasons && breakdown.length > 0 && (
        <ul className="ds-reasons" aria-label="Rejected points by reason">
          {breakdown.map((r) => (
            <li key={r.reason}>
              {r.words}: {int(r.count)}
            </li>
          ))}
        </ul>
      )}
      {scan.phase === "rejected" && (
        <div className="ds-notice ds-error" role="alert">
          <strong>Scan not accepted.</strong> {scan.reasons.join(" ")}
        </div>
      )}
      <p className="ds-small ds-muted">Counts are the real point arrays of this frame: the points the line has passed so far, then all of them. Quality is the accepted share (provisional thresholds, not validated).</p>
    </section>
  );
}

function Results({ api }: { api: DenseApi }) {
  const { processed, pointSet, frozen } = api;
  if (!processed || !pointSet || !frozen) return null;
  const regions = Object.entries(processed.regions).sort((a, b) => b[1] - a[1]);
  const measurements = Object.entries(processed.measurements);
  const mmPerPx = pointSet.mmPerPx;
  const depthWords =
    processed.cloud.zUnit === "relative"
      ? "Estimated relative depth from MediaPipe landmarks, not measured."
      : processed.cloud.zUnit === "mm"
        ? "Measured depth (mm) from a depth sensor."
        : "No depth: a flat 2D map of the visible hand.";
  return (
    <>
      <section className="ds-card" aria-labelledby="ds-snap-h">
        <h2 id="ds-snap-h">Snapshot</h2>
        <dl className="ds-facts">
          <div>
            <dt>Accepted points (frozen)</dt>
            <dd>{int(pointSet.counts.accepted)}</dd>
          </div>
          <div>
            <dt>Depth</dt>
            <dd data-testid="depth-label">{depthWords}</dd>
          </div>
          <div>
            <dt>Point cloud</dt>
            <dd>
              {int(processed.cloud.count)} points, x and y in {mmPerPx ? "mm (coin-plane scale, a model)" : "pixels"}
            </dd>
          </div>
          <div>
            <dt>Lattice mesh</dt>
            <dd data-testid="mesh-facts">
              {int(processed.mesh.triangles)} triangles in {processed.mesh.components} piece{processed.mesh.components === 1 ? "" : "s"}, covers {Math.round(processed.mesh.completeness * 100)} % of the hand's
              area
            </dd>
          </div>
        </dl>
        <p className="ds-small ds-muted">{processed.mesh.note}</p>
        <h3>Regions</h3>
        <table className="ds-table" aria-label="Accepted points by region">
          <thead>
            <tr>
              <th>Region</th>
              <th>Points</th>
            </tr>
          </thead>
          <tbody>
            {regions.map(([r, n]) => (
              <tr key={r}>
                <td>{REGION_WORDS[r] ?? r}</td>
                <td>{int(n)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="ds-small ds-muted">Regions come from the 21 hand landmarks (nearest finger bone, palm polygon, below the wrist).</p>
      </section>

      <SpacingPanel api={api} />

      <section className="ds-card" aria-labelledby="ds-meas-h">
        <h2 id="ds-meas-h">Measurements and how each was obtained</h2>
        {!mmPerPx && <p className="ds-notice">No accepted coin in this frame, so millimetre values are not available.</p>}
        <div className="ds-tablewrap">
          <table className="ds-table" aria-label="Measurements">
            <thead>
              <tr>
                <th>Value</th>
                <th>Result</th>
                <th>Basis</th>
              </tr>
            </thead>
            <tbody>
              {measurements.map(([k, q]) => {
                const base = k.replace(/_(px2?|mm2?)$/, "");
                const unit = k.match(/_(px2?|mm2?)$/)?.[1] ?? "";
                const name = MEASURE_NAMES[base] ?? base.replace(/_/g, " ");
                const digits = q.unit === "mm" || q.unit === "px" ? 1 : 0;
                return (
                  <tr key={k}>
                    <td>
                      {name}
                      {unit ? <span className="ds-muted"> ({unit === "px2" ? "px²" : unit === "mm2" ? "mm²" : unit})</span> : null}
                    </td>
                    <td className="ds-nowrap">{q.value === null ? "—" : q.unit === "ratio" ? int(q.value) : `${q.value.toFixed(digits)} ${q.unit.replace("2", "²")}`}</td>
                    <td>
                      <strong className={`ds-basis is-${q.basis}`}>{BASIS_WORDS[q.basis]}</strong>
                      <span className="ds-small ds-muted"> {q.note}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="ds-small ds-muted">Not validated: nothing here has been compared with physical reference measurements.</p>
      </section>

      <Preview api={api} />
      <ExportPanel api={api} />
    </>
  );
}

function SpacingPanel({ api }: { api: DenseApi }) {
  const set = api.pointSet!;
  const mmPerPx = set.mmPerPx;
  const pxPerMm = mmPerPx ? 1 / mmPerPx : null;
  return (
    <section className="ds-card" aria-labelledby="ds-spacing-h">
      <h2 id="ds-spacing-h">Dot spacing</h2>
      <dl className="ds-facts">
        <div>
          <dt>Step in the image</dt>
          <dd data-testid="spacing-px">{fmt(set.spacing.px, 2)} px</dd>
        </div>
        <div>
          <dt>Step at the coin's plane</dt>
          <dd data-testid="spacing-mm">{set.spacing.mm.value === null ? "not available (no coin scale)" : `${set.spacing.mm.value.toFixed(3)} mm (model)`}</dd>
        </div>
        <div>
          <dt>Image resolution at the coin</dt>
          <dd>{pxPerMm ? `${pxPerMm.toFixed(2)} px per mm (${mmPerPx!.toFixed(3)} mm per px)` : "unknown"}</dd>
        </div>
      </dl>
      {set.spacing.note && <p className="ds-small">{set.spacing.note}</p>}
      <p className="ds-notice ds-small" data-testid="tenth-mm-note">
        About 0.1 mm: a 0.1 mm step needs at least 10 pixels per millimetre at the hand
        {pxPerMm ? `; this frame has ${pxPerMm.toFixed(2)}, so its finest meaningful step is 1 px = ${mmPerPx!.toFixed(2)} mm` : ""}. A step below one pixel only interpolates the same pixels. And a dot
        spacing is a sampling step, not an accuracy: no 0.1 mm accuracy is claimed or possible from this photo.
      </p>
    </section>
  );
}

function Preview({ api }: { api: DenseApi }) {
  const p = api.processed!;
  const [view, setView] = useState<"points" | "mesh">("points");
  const caption = captionFor(view, p.cloud.zUnit, p.mesh.measured);
  return (
    <section className="ds-card" aria-labelledby="ds-3d-h">
      <h2 id="ds-3d-h">3D preview</h2>
      <div className="ds-toggle" role="group" aria-label="What to show">
        <button type="button" aria-pressed={view === "points"} onClick={() => setView("points")}>
          Points
        </button>
        <button type="button" aria-pressed={view === "mesh"} onClick={() => setView("mesh")} disabled={!p.mesh.viewer}>
          Mesh
        </button>
      </div>
      <MeshViewer key={view} className="ds-viewer" points={view === "points" ? p.viewerPoints : null} mesh={view === "mesh" ? p.mesh.viewer : null} label={caption} unit={api.pointSet?.mmPerPx ? "mm" : "px"} />
      <p className="ds-small ds-muted">Drag to turn, pinch or scroll to zoom. Units: {api.pointSet?.mmPerPx ? "mm at the coin's plane (model)" : "pixels"}.</p>
    </section>
  );
}

function ExportPanel({ api }: { api: DenseApi }) {
  const [photo, setPhoto] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <section className="ds-card" aria-labelledby="ds-export-h">
      <h2 id="ds-export-h">Export</h2>
      <p className="ds-small">A ZIP with the points as JSON and CSV (every generated point with its check result), the camera settings, the coin calibration and the settings including the seed. It is saved on this device only; nothing is uploaded.</p>
      <label className="ds-check">
        <input type="checkbox" checked={photo} onChange={(e) => setPhoto(e.target.checked)} />
        Include the photo of my hand in the file (off by default)
      </label>
      <div className="ds-row">
        <button
          type="button"
          className="ds-btn ds-btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.exportZip(photo);
            } finally {
              setBusy(false);
            }
          }}
        >
          Download point set (this device only)
        </button>
      </div>
      {api.exportInfo && (
        <p className="ds-small ds-muted" role="status">
          Saved {api.exportInfo.filename}: {api.exportInfo.names.join(", ")} ({int(api.exportInfo.bytes)} bytes).
        </p>
      )}
    </section>
  );
}

function SettingsDrawer({ api }: { api: DenseApi }) {
  const { settings, setSettings, scan } = api;
  const busy = scan.phase !== "waiting_hand" && scan.phase !== "done" && scan.phase !== "rejected";
  const num = (key: keyof DenseSettings, min: number, max: number, step: number, label: string, help: string) => (
    <label className="ds-field">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={settings[key] ?? ""}
        disabled={busy}
        onChange={(e) => {
          const raw = e.target.value;
          const v = raw === "" ? null : Number(raw);
          setSettings((s) => ({ ...s, [key]: key === "targetMm" ? (v && v > 0 ? v : null) : Number.isFinite(v) && v !== null ? Math.min(max, Math.max(min, v)) : DEFAULT_SETTINGS[key] }));
        }}
      />
      <span className="ds-small ds-muted">{help}</span>
    </label>
  );
  return (
    <details className="ds-card ds-drawer">
      <summary>Settings</summary>
      <p className="ds-small ds-muted">Used by the next scan.</p>
      <div className="ds-grid">
        {num("spacingPx", 1, 32, 0.5, "Dot spacing (px)", "Step of the dot lattice in camera pixels (1 px minimum).")}
        {num("targetMm", 0, 20, 0.1, "Target spacing (mm)", "Optional; needs the coin. Clamped to 1 px.")}
        {num("jitter", 0, 0.45, 0.05, "Jitter", "Seeded random shift of each dot, as a share of the step.")}
        {num("edgeMarginPx", 0, 20, 1, "Edge margin (px)", "Dots closer to the hand's edge are rejected.")}
        {num("sweepMs", 300, 8000, 100, "Sweep duration (ms)", "How long the scan line takes.")}
        {num("seed", 0, 1_000_000, 1, "Seed", "Same seed and frame give the same dots.")}
      </div>
    </details>
  );
}

function DebugPanel({ api }: { api: DenseApi }) {
  const p = api.perf;
  const rows: [string, string][] = [
    ["Segmentation (wall)", `${fmt(p.segmentationMs, 0)} ms (${p.segmentationWhere ?? "n/a"})`],
    ["Dots, wall time", `${fmt(p.pointsWallMs, 0)} ms (${p.pointsWhere ?? "n/a"})`],
    ["Dot generation", `${fmt(p.stages?.generateMs, 1)} ms`],
    ["Dot validation", `${fmt(p.stages?.validateMs, 1)} ms`],
    ["Duplicates / isolated", `${fmt(p.stages?.filterMs, 1)} ms`],
    ["Regions + depth labels", `${fmt(p.stages ? p.stages.regionsMs + p.stages.depthMs : null, 1)} ms`],
    ["Points", int(p.points)],
    ["Render per frame (median / p95 / max)", `${fmt(p.render.medianMs, 2)} / ${fmt(p.render.p95Ms, 2)} / ${fmt(p.render.maxMs, 2)} ms over ${p.render.frames} frames`],
    ["Frame interval (median / p95)", `${fmt(p.frameInterval.medianMs, 1)} / ${fmt(p.frameInterval.p95Ms, 1)} ms; ${p.longFrames} frames over 50 ms`],
    ["Point cloud / mesh / measurements", p.processing ? `${fmt(p.processing.cloudMs, 1)} / ${fmt(p.processing.meshMs, 1)} / ${fmt(p.processing.measureMs, 1)} ms (${p.processWhere}, wall ${fmt(p.processWallMs, 0)} ms)` : "n/a"],
    ["Camera loop when taken", p.cameraFps === null ? "n/a" : `${fmt(p.cameraFps, 0)} frames per second`],
    ["Idle, live camera (median frame)", p.idleLive?.medianMs ? `${fmt(p.idleLive.medianMs, 1)} ms (${fmt(1000 / p.idleLive.medianMs, 0)} fps), p95 ${fmt(p.idleLive.p95Ms, 1)} ms` : "n/a"],
    ["Idle, after the scan (median frame)", p.idleAfter?.medianMs ? `${fmt(p.idleAfter.medianMs, 1)} ms (${fmt(1000 / p.idleAfter.medianMs, 0)} fps), p95 ${fmt(p.idleAfter.p95Ms, 1)} ms` : "n/a"],
    [
      "Main-thread long tasks: outline / dots / sweep / build",
      !p.longTasks
        ? "n/a"
        : !p.longTasks.supported
          ? "not reported by this browser"
          : [p.longTasks.segmentation, p.longTasks.points, p.longTasks.sweep, p.longTasks.processing].map((t) => `${t.count} (max ${t.maxMs} ms)`).join(" / "),
    ],
    [
      "JS heap: taken / dots / built",
      p.memory ? `${fmt(p.memory.atCaptureMb, 1)} / ${fmt(p.memory.afterPointsMb, 1)} / ${fmt(p.memory.afterProcessingMb, 1)} MB (${p.memory.source})` : "not exposed by this browser",
    ],
    ["Dots drawn", api.display ? `1 in ${api.display.k * api.display.k} (on-screen pitch ${fmt(api.display.pitchCss, 2)} CSS px, shown ${fmt(api.display.shownPitchCss, 1)} px)` : "n/a"],
    ["Frame", api.frozen ? `${api.frozen.frame.width} x ${api.frozen.frame.height} (${api.frozen.frame.height > api.frozen.frame.width ? "portrait" : "landscape"})` : "n/a"],
  ];
  const ok = p.frameInterval.medianMs !== null && p.frameInterval.medianMs <= 34;
  return (
    <section className="ds-card ds-debug" aria-labelledby="ds-debug-h">
      <h2 id="ds-debug-h">Debug timings</h2>
      <dl className="ds-facts">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {p.frameInterval.frames > 0 && (
        <p className="ds-small" data-testid="perf-summary">
          Performance: the sweep ran at a median {fmt(p.frameInterval.medianMs ? 1000 / p.frameInterval.medianMs : null, 0)} frames per second with {fmt(p.render.medianMs, 2)} ms of dot drawing per frame
          {ok ? " (smooth on this device)" : " (below 30 frames per second on this device)"}. These are this device's numbers, not a phone's.
        </p>
      )}
    </section>
  );
}

export function DenseScanPage() {
  const api = useDenseScan();
  const { live, scan, config } = api;
  const running = live?.phase === "running";
  const loading = live?.phase === "starting" || live?.phase === "loading";
  const ended = scan.phase === "done" || scan.phase === "rejected";
  const scanning = !ended && scan.phase !== "waiting_hand";
  return (
    <main className="ds-root">
      <p className="ds-banner" role="note">
        EXPERIMENTAL dense scan, not the customer app. Images stay on this device.
      </p>
      <header className="ds-head">
        <h1>Dense hand surface scan</h1>
        <p className="ds-small ds-muted">A dot lattice over the segmented hand in one camera frame: a 2D surface-point map, not a measured 3D scan.</p>
      </header>

      <section className="ds-card ds-camera" aria-labelledby="ds-cam-h">
        <h2 id="ds-cam-h" className="ds-visually-hidden">
          Camera
        </h2>
        <Stage api={api} />
        <DisplayNote api={api} />
        <Steps phase={scan.phase} />
        <Readiness api={api} />
        <LiveChecks api={api} />
        {live?.phase === "error" && live.error && (
          <p className="ds-notice ds-error" role="alert" data-testid="camera-error">
            <strong>{live.error.title}.</strong> {live.error.message}
          </p>
        )}
        {api.configError && (
          <p className="ds-notice ds-error" role="alert">
            Could not read the public settings (GET /api/config): {api.configError}. Start the backend (see the README) and reload.
          </p>
        )}
        {api.error && (
          <p className="ds-notice ds-error" role="alert">
            {api.error}
          </p>
        )}
        <div className="ds-row">
          {ended ? (
            <button type="button" className="ds-btn ds-btn-primary" onClick={api.scanAgain}>
              Scan again
            </button>
          ) : scanning ? (
            <button type="button" className="ds-btn ds-btn-primary" disabled>
              Scanning…
            </button>
          ) : !running ? (
            <button type="button" className="ds-btn ds-btn-primary" onClick={() => void api.startCamera()} disabled={!config || loading || !api.readiness.secure || !api.readiness.hasCamera}>
              {loading ? "Starting…" : live?.phase === "error" ? "Try the camera again" : "Start camera"}
            </button>
          ) : (
            <button type="button" className="ds-btn ds-btn-primary" onClick={api.scanNow} disabled={scan.phase !== "waiting_hand" || !api.gate?.allowed} aria-describedby="ds-scan-why">
              Scan
            </button>
          )}
          {running && (
            <button type="button" className="ds-btn" onClick={api.stopCamera}>
              Stop camera
            </button>
          )}
        </div>
        {running && scan.phase === "waiting_hand" && api.gate && !api.gate.allowed && api.gate.blocking && (
          <p id="ds-scan-why" className="ds-small ds-blocked" data-testid="scan-blocked">
            Scan is off until this passes: <strong>{GROUP_TITLES[api.gate.blocking.group]}</strong>: {api.gate.blocking.words}. {api.gate.blocking.todo}.
          </p>
        )}
        {api.discarded && (
          <p className="ds-notice" role="status" data-testid="discarded">
            {api.discarded}
          </p>
        )}
        <ReasonsPanel api={api} />
        <CoinPanel api={api} />
        <div className="ds-row">
          <label className="ds-field" htmlFor="ds-facing">
            Camera
            <select id="ds-facing" value={api.facing} onChange={(e) => api.setFacing(e.target.value as "user" | "environment")}>
              <option value="environment">Back (rear) camera</option>
              <option value="user">Front (selfie) camera</option>
            </select>
          </label>
          <label className="ds-check">
            <input type="checkbox" checked={api.autoStart} onChange={(e) => api.setAutoStart(e.target.checked)} />
            Start by itself when every check passes for {AUTO_CAPTURE_FRAMES} frames
          </label>
        </div>
      </section>

      <Counters api={api} />
      <Results api={api} />
      <SettingsDrawer api={api} />
      {DEBUG && <DebugPanel api={api} />}

      <footer className="ds-small ds-muted ds-foot">
        Real: the camera frame, the hand outline (GrabCut segmentation), the dots and their checks, the counts. Estimated: depth (MediaPipe), millimetres (coin-plane model). Missing: measured depth, the back and sides of the hand,
        any accuracy check against physical measurements.
      </footer>
    </main>
  );
}
