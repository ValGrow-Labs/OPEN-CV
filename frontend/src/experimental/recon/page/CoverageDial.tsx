// The coverage guide as a dial seen from above the board: the top view in the middle, the required low ring (8 to 22
// degrees above the board) in 12 sectors round it, the optional middle ring (25 to 45 degrees) in 6 sectors between. The
// radius follows the elevation (90 degrees at the centre, 0 at the rim), the angle the azimuth (0 = the fingertip side to
// the right, 90 = the top edge, as the printed sheet lies). Filled sectors are blue; the dot is the phone, live.
import { ALL_BINS, LOW_RING, MID_RING, TOP_MIN_ELEVATION_DEG, type BinId, type ThumbSide } from "./coverage";

const R = (elevationDeg: number) => (100 * (90 - Math.max(0, Math.min(90, elevationDeg)))) / 90;
const P = (r: number, azDeg: number) => [r * Math.cos((azDeg * Math.PI) / 180), -r * Math.sin((azDeg * Math.PI) / 180)] as const;

function sector(r0: number, r1: number, a0: number, a1: number): string {
  const [x0, y0] = P(r1, a0), [x1, y1] = P(r1, a1), [x2, y2] = P(r0, a1), [x3, y3] = P(r0, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  // SVG y points down, so increasing azimuth (counter-clockwise on the board) is sweep-flag 0
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r1},${r1} 0 ${large} 0 ${x1.toFixed(2)},${y1.toFixed(2)} L${x2.toFixed(2)},${y2.toFixed(2)} A${r0},${r0} 0 ${large} 1 ${x3.toFixed(2)},${y3.toFixed(2)} Z`;
}

export function CoverageDial(props: { filled: ReadonlySet<BinId>; current: { elevationDeg: number; azimuthDeg: number } | null; currentBin: BinId | null; thumb: ThumbSide }) {
  const { filled, current, currentBin, thumb } = props;
  const lowR = [R(LOW_RING.maxDeg), R(LOW_RING.minDeg)];
  const midR = [R(MID_RING.maxDeg), R(MID_RING.minDeg)];
  const topR = R(TOP_MIN_ELEVATION_DEG);
  const topLabel = thumb === "top" ? "thumb side" : thumb === "bottom" ? "little finger" : "top edge";
  const bottomLabel = thumb === "bottom" ? "thumb side" : thumb === "top" ? "little finger" : "bottom edge";
  const filledCount = ALL_BINS.filter((b) => b.required && filled.has(b.id)).length;
  const requiredCount = ALL_BINS.filter((b) => b.required).length;
  return (
    <figure className="rc-dial" aria-label={`Coverage: ${filledCount} of ${requiredCount} required views taken`} data-testid="coverage-dial">
      <svg viewBox="-150 -126 300 252" role="img" aria-hidden="true">
        <circle r="100" className="rc-dial-rim" />
        {ALL_BINS.map((b) => {
          const isFilled = filled.has(b.id);
          const cls = `rc-bin rc-bin-${b.ring}${isFilled ? " is-filled" : ""}${b.id === currentBin ? " is-current" : ""}`;
          if (b.ring === "top") return <circle key={b.id} r={topR} className={cls} data-bin={b.id} data-filled={isFilled ? "1" : "0"} />;
          const [r0, r1] = b.ring === "low" ? lowR : midR;
          return <path key={b.id} d={sector(r0, r1, b.fromDeg + 0.8, b.toDeg - 0.8)} className={cls} data-bin={b.id} data-filled={isFilled ? "1" : "0"} />;
        })}
        <text className="rc-dial-top" y="4">
          top
        </text>
        <text className="rc-dial-label" x="106" y="4" textAnchor="start">
          fingertips
        </text>
        <text className="rc-dial-label" x="-106" y="4" textAnchor="end">
          wrist
        </text>
        <text className="rc-dial-label" x="0" y="-108" textAnchor="middle">
          {topLabel}
        </text>
        <text className="rc-dial-label" x="0" y="117" textAnchor="middle">
          {bottomLabel}
        </text>
        {current && (
          <g className="rc-dial-phone" transform={`translate(${P(R(current.elevationDeg), current.azimuthDeg).map((v) => v.toFixed(1)).join(",")})`}>
            <circle r="9" className="rc-dial-halo" />
            <circle r="4.5" className="rc-dial-dot" />
          </g>
        )}
      </svg>
      <figcaption>
        <span className="rc-key rc-key-filled" /> taken <span className="rc-key rc-key-needed" /> needed <span className="rc-key rc-key-optional" /> optional
      </figcaption>
    </figure>
  );
}
