// The simple results page that follows an accepted scan: the fitted 3D hand (Point Cloud | Solid | Wireframe, "Drag to
// rotate"), then one compact card: hand length and hand width side by side, one row per finger, the suggested size as one small
// chip, the unvalidated-prototype line and "More details" (the detailed measurements page).
//
// Honest by construction:
//  * the 3D hand is an ESTIMATE fitted to the three views and scaled by the coin (millimesh/fitHand.ts), not a measured scan;
//  * the width is knuckle to knuckle (index to little-finger knuckle joint centres, `mcp_span_mm`): the palm breadth the glove
//    makers use is not measured by the camera and is not shown;
//  * a finger length is by default CREASE TO TIP (the glove-industry definition, as in the sample page): an ESTIMATE from the knuckle
//    joint with an assumed standard hand proportion (backend `crease_to_tip_mm`; not validated), always tagged "estimate". The
//    other choice is the knuckle (MCP joint centre) to fingertip length, which is longer;
//  * every number is the server's own; a finger the server would hide is shown with the wide interval and "Very uncertain"
//    (`info_*` fields), for information, never used for the size.
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Measurement, Recommendation, ScanResponse } from "../api/types";
import { webglAvailable } from "../hand3d/HandStage";
import { veryUncertainFinger } from "../ui/format";
import { ArrowRight, Wordmark } from "./Brand";
import { ESTIMATE_LABEL, type FittedHand } from "./fitHand";
import type { ReconMode } from "./ReconScene";
import { FlatHand, ReconBoundary } from "./ReconStep";

const Scene = lazy(() => import("./ReconScene"));

/** The three drawings, in this order, Point Cloud first. */
const MODES: { id: ReconMode; label: string }[] = [
  { id: "points", label: "Point Cloud" },
  { id: "solid", label: "Solid" },
  { id: "wireframe", label: "Wireframe" },
];

const DEFINITIONS: { id: FingerDefinition; label: string }[] = [
  { id: "crease", label: "Crease to tip (est.)" },
  { id: "knuckle", label: "Knuckle to tip" },
];

const FINGERS: { key: string; label: string }[] = [
  { key: "thumb_length_mm", label: "Thumb" },
  { key: "index_length_mm", label: "Index" },
  { key: "middle_length_mm", label: "Middle" },
  { key: "ring_length_mm", label: "Ring" },
  { key: "little_length_mm", label: "Little" },
];

/** Which finger length the rows show. */
export type FingerDefinition = "crease" | "knuckle";

export const CREASE_CAPTION =
  "Finger length from the crease at the base of the finger to the tip, estimated from your knuckle joint with a standard hand proportion; not validated.";
export const KNUCKLE_CAPTION = "Finger length is from the knuckle joint to the fingertip.";

export interface FingerRow {
  key: string;
  label: string;
  /** Millimetres, or null when the camera has no number for this finger at all. */
  mm: number | null;
  /** True for a finger the server would hide (shown for information; never used for the size). */
  veryUncertain: boolean;
  /** Where the tip of this length came from, by the commonest source over its frames. */
  tip: "outline" | "estimated" | "landmark" | null;
}

export interface SimpleNumbers {
  /** The definition the finger rows use: crease to tip when the server sent it and it was asked for, else knuckle to tip. */
  definition: FingerDefinition;
  /** Whether the server sent a crease-to-tip estimate at all (an older server does not). */
  creaseAvailable: boolean;
  handLengthCm: number | null;
  handWidthCm: number | null;
  fingers: FingerRow[];
  /** Median 95% half-width of the finger values the server reports, mm (null when none). */
  fingerHalfWidthMm: number | null;
  tipLine: string | null;
  sizeChip: string;
}

const by = (r: ScanResponse, key: string): Measurement | undefined => r.measurements.find((m) => m.key === key);
const usable = (m: Measurement | undefined): number | null => (m && m.value_mm !== null && m.status !== "invalid" && m.status !== "not_measured" ? m.value_mm : null);

function dominantTip(m: Measurement | undefined): FingerRow["tip"] {
  const t = m?.tip_source;
  if (!t) return null;
  const best = Object.entries(t).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? (best[0] as FingerRow["tip"]) : null;
}

export function sizeChipText(rec: Recommendation | null | undefined): string {
  if (rec?.size) return `Suggested size ${rec.size}`;
  if (rec?.closest_size) return `Closest size ${rec.closest_size} (not a firm size)`;
  return "Size needs a tape measurement";
}

/** Everything the page shows, from the server's response. Pure, so it is tested without drawing. */
export function simpleNumbers(r: ScanResponse, wanted: FingerDefinition = "crease"): SimpleNumbers {
  const hand = usable(by(r, "hand_length_mm"));
  const width = usable(by(r, "mcp_span_mm"));
  const creaseAvailable = FINGERS.some(({ key }) => by(r, key)?.crease_to_tip_mm != null);
  const definition: FingerDefinition = wanted === "crease" && creaseAvailable ? "crease" : "knuckle";
  const fingers: FingerRow[] = FINGERS.map(({ key, label }) => {
    const m = by(r, key);
    if (definition === "crease") {
      // The estimate is shown for every finger (also one the server hides for the knuckle length); "Very uncertain" when its own
      // interval is over the limit every length is held to, or when the knuckle length was hidden.
      const mm = m?.crease_to_tip_mm ?? null;
      return { key, label, mm, veryUncertain: mm !== null && (m?.crease_status === "invalid" || m?.status === "invalid"), tip: dominantTip(m) };
    }
    const shown = usable(m);
    const info = shown === null ? veryUncertainFinger(m) : null;
    return { key, label, mm: shown ?? info?.mm ?? null, veryUncertain: shown === null && info !== null, tip: dominantTip(m) };
  });
  const sigmaOf = (m: Measurement | undefined): number | null =>
    definition === "crease"
      ? (m?.crease_uncertainty_mm ?? null)
      : (m?.uncertainty_mm ?? m?.info_uncertainty_mm ?? null);
  const halves = FINGERS.map(({ key }) => sigmaOf(by(r, key)))
    .filter((v): v is number => v !== null)
    .map((v) => 1.96 * v)
    .sort((a, b) => a - b);
  const counts = { outline: 0, estimated: 0, landmark: 0 };
  for (const f of fingers) if (f.tip) counts[f.tip]++;
  let tipLine: string | null = null;
  if (counts.outline + counts.estimated + counts.landmark > 0) {
    if (counts.outline + counts.estimated === 0) tipLine = "Fingertips: the hand model's tip points (the outline was not used).";
    else
      tipLine =
        "Fingertips: " +
        [counts.outline ? `found on the hand outline for ${counts.outline}` : "", counts.estimated ? `estimated for ${counts.estimated}` : "", counts.landmark ? `model tip point for ${counts.landmark}` : ""]
          .filter(Boolean)
          .join(", ") +
        ".";
  }
  return {
    definition,
    creaseAvailable,
    handLengthCm: hand === null ? null : hand / 10,
    handWidthCm: width === null ? null : width / 10,
    fingers,
    fingerHalfWidthMm: halves.length ? halves[halves.length >> 1] : null,
    tipLine,
    sizeChip: sizeChipText(r.recommendation),
  };
}

export interface SimpleResultsProps {
  /** The fitted 3D hand; null when the views could not be fitted (the numbers still show). */
  fit: FittedHand | null;
  response: ScanResponse;
  unvalidated?: boolean;
  onMore: () => void;
  onRescan: () => void;
}

export function SimpleResults({ fit, response, unvalidated = true, onMore, onRescan }: SimpleResultsProps) {
  const [mode, setMode] = useState<ReconMode>("points");
  const [wanted, setWanted] = useState<FingerDefinition>("crease");
  const [gl, setGl] = useState(() => webglAvailable());
  const h1 = useRef<HTMLHeadingElement>(null);
  const onUnavailable = useCallback(() => setGl(false), []);
  useEffect(() => h1.current?.focus({ preventScroll: true }), []);
  const n = simpleNumbers(response, wanted);
  // The markers of the three captures are dropped here: a plain hand, as in the sample.
  const plain = fit ? { ...fit, markers: [] } : null;
  const noGl = (
    <>
      {plain && <FlatHand fit={plain} mode={mode} />}
      <p className="mm-flat-note small">This device cannot draw in 3D right now, so this is a flat drawing of the same fitted hand.</p>
    </>
  );
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = MODES.findIndex((m) => m.id === mode);
    const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? i + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? i - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const m = MODES[(next + MODES.length) % MODES.length];
    setMode(m.id);
    (e.currentTarget.querySelector(`[data-mode="${m.id}"]`) as HTMLElement | null)?.focus();
  };
  const cm = (v: number | null) => (v === null ? "not measured" : `≈ ${v.toFixed(1)} cm`);

  return (
    <main className="mm-screen mm-simple">
      <header className="mm-top">
        <Wordmark />
      </header>
      <h1 ref={h1} tabIndex={-1} className="mm-h2">
        Your hand
      </h1>

      {plain && (
        <>
          <div className="mm-recon-stage" aria-label="Estimated 3D hand">
            {gl ? (
              <ReconBoundary fallback={noGl}>
                <Suspense fallback={<FlatHand fit={plain} mode={mode} />}>
                  <Scene fit={plain} mode={mode} resetKey={0} onUnavailable={onUnavailable} />
                </Suspense>
              </ReconBoundary>
            ) : (
              noGl
            )}
          </div>
          {gl && <p className="mm-drag">Drag to rotate</p>}
          <div className="mm-seg" role="radiogroup" aria-label="How to draw the model" onKeyDown={onKey}>
            {MODES.map((m) => (
              <button key={m.id} role="radio" aria-checked={mode === m.id} data-mode={m.id} tabIndex={mode === m.id ? 0 : -1} className={mode === m.id ? "is-on" : ""} onClick={() => setMode(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
          <p className="mm-simple-note" role="note">
            {ESTIMATE_LABEL}
          </p>
        </>
      )}

      <section className="mm-simple-card" aria-label="Your measurements">
        <div className="mm-simple-pair">
          <div>
            <span className="mm-simple-k">Hand length</span>
            <b data-testid="hand-length">{cm(n.handLengthCm)}</b>
          </div>
          <div>
            <span className="mm-simple-k">Hand width</span>
            <b data-testid="hand-width">{cm(n.handWidthCm)}</b>
          </div>
        </div>
        <p className="mm-simple-cap">Width is knuckle to knuckle (index to little-finger joint), not the palm breadth glove makers use.</p>
        <div className="mm-simple-def">
          <span className="mm-simple-k">Finger length</span>
          {n.definition === "crease" && <em className="mm-tag mm-tag--est">estimate</em>}
        </div>
        {n.creaseAvailable && (
          <div className="mm-seg mm-seg--two" role="radiogroup" aria-label="Finger length definition">
            {DEFINITIONS.map((d) => (
              <button key={d.id} role="radio" aria-checked={n.definition === d.id} data-definition={d.id} tabIndex={n.definition === d.id ? 0 : -1} className={n.definition === d.id ? "is-on" : ""} onClick={() => setWanted(d.id)}>
                {d.label}
              </button>
            ))}
          </div>
        )}
        <ul className="mm-simple-fingers">
          {n.fingers.map((f) => (
            <li key={f.key} data-finger={f.key}>
              <span>{f.label}</span>
              <span className="mm-simple-val">
                {f.mm === null ? "not measured" : `≈ ${Math.round(f.mm)} mm`}
                {f.veryUncertain && <em className="mm-tag">Very uncertain</em>}
              </span>
            </li>
          ))}
        </ul>
        <p className="mm-simple-cap">
          {n.definition === "crease" ? CREASE_CAPTION : KNUCKLE_CAPTION}
          {n.fingerHalfWidthMm !== null && ` Each is uncertain by about ±${Math.round(n.fingerHalfWidthMm)} mm.`}
          {n.fingers.some((f) => f.veryUncertain) && " Very uncertain values are shown for information; they are not used for your size."}
        </p>
        {n.tipLine && <p className="mm-simple-cap">{n.tipLine}</p>}
        <p className="mm-simple-chip-row">
          <span className="mm-chip" data-testid="size-chip">
            {n.sizeChip}
          </span>
        </p>
      </section>

      <p className="mm-fine">{unvalidated ? "Unvalidated prototype · camera-based estimate" : "Camera-based estimate"} · not a guarantee of fit</p>

      <div className="mm-actions">
        <button className="mm-btn" onClick={onMore}>
          More details
          <ArrowRight />
        </button>
        <button className="mm-btn mm-btn--quiet" onClick={onRescan}>
          Scan again
        </button>
      </div>
    </main>
  );
}
