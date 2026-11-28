// The fixed corner arrows on the screen: a solid box with a boxed arrow at each corner. They are the targets: the four arrows on
// the scan frame around the hand (ParticleField) are moved onto them, and each pair turns green when it lines up. Feedback
// only: it changes no threshold and rejects no frame (see alignment.ts).
import { type AlignResult, type Corner, CORNERS, guideBox } from "./alignment";

/** The arrow points out of the box, towards the corner the hand should reach. */
const ROTATE: Record<Corner, number> = { tr: 0, br: 90, bl: 180, tl: 270 };
const TAG = 30;

interface Props {
  align: AlignResult;
  view: { w: number; h: number };
}

export function AlignGuide({ align, view }: Props) {
  const t = view.w > 0 && view.h > 0 ? guideBox(view.w, view.h) : null;
  const at = (c: Corner) => (t ? { x: c === "tl" || c === "bl" ? t.x0 : t.x1, y: c === "tl" || c === "tr" ? t.y0 : t.y1 } : { x: 0, y: 0 });
  return (
    <svg
      className={`mm-align ${align.aligned ? "is-aligned" : ""}`}
      viewBox={t ? `0 0 ${view.w} ${view.h}` : undefined}
      aria-hidden="true"
      data-aligned={align.aligned ? "true" : "false"}
      data-corners={CORNERS.filter((c) => align.corners[c]).join(" ")}
    >
      {t && (
        <>
          <rect className="mm-align-under" x={t.x0} y={t.y0} width={t.x1 - t.x0} height={t.y1 - t.y0} rx={14} />
          <rect className="mm-align-box" x={t.x0} y={t.y0} width={t.x1 - t.x0} height={t.y1 - t.y0} rx={14} />
          {CORNERS.map((c) => {
            const p = at(c);
            return (
              <g key={c} className={`mm-align-tag ${align.corners[c] ? "is-on" : ""}`} transform={`translate(${p.x} ${p.y})`} data-corner={c}>
                <rect x={-TAG / 2} y={-TAG / 2} width={TAG} height={TAG} rx={8} />
                <path d="M-5 5 L5 -5 M-4.5 -5 H5 V4.5" transform={`rotate(${ROTATE[c]})`} />
              </g>
            );
          })}
        </>
      )}
    </svg>
  );
}
