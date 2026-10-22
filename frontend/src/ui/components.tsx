import { CameraRotate, HandPalm, Question, X } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { CoinObservation, Point } from "../api/types";
import { HAND_CONNECTIONS } from "../vision/geometry";
import { computeHandOutline, outlineSvgPath } from "../vision/handOutline";
import type { Tone } from "./format";

export function Badge({ tone, children }: { tone: Tone | "demo"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <HandPalm size={18} weight="bold" />
    </span>
  );
}

// Phosphor icons, one weight across the app.
export const Icon = {
  close: <X size={20} weight="regular" aria-hidden="true" />,
  help: <Question size={20} weight="regular" aria-hidden="true" />,
  switchCamera: <CameraRotate size={20} weight="regular" aria-hidden="true" />,
};

/** Static diagram of the median landmarks with the main measurement lines. */
export function HandDiagram({
  landmarks,
  coin,
  mirrored,
  showLines = true,
}: {
  landmarks: Point[];
  coin: CoinObservation | null;
  mirrored?: boolean;
  showLines?: boolean;
}) {
  const xs = landmarks.map((p) => p.x);
  const ys = landmarks.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const size = Math.max(maxX - minX, maxY - minY);
  const pad = size * 0.14;
  const vb = `${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`;
  const s = size / 300;
  const line = (a: Point, b: Point, label: string, color: string, offset: number) => {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    return (
      <g className="dg-line">
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={3 * s} strokeDasharray={`${8 * s} ${5 * s}`} />
        <text
          x={mx + offset * s}
          y={my}
          fontSize={13 * s}
          fill={color}
          fontWeight={650}
          stroke="#1a1d22"
          strokeWidth={4 * s}
          paintOrder="stroke"
          transform={mirrored ? `translate(${2 * (mx + offset * s)} 0) scale(-1 1)` : undefined}
        >
          {label}
        </text>
      </g>
    );
  };
  const outline = computeHandOutline(landmarks).contour;

  return (
    <svg className="diagram" viewBox={vb} role="img" aria-label="Diagram of the detected hand landmarks and measurement lines">
      <g transform={mirrored ? `translate(${minX + maxX} 0) scale(-1 1)` : undefined}>
        {outline.length > 2 && (
          <path
            d={outlineSvgPath(outline)}
            fill="rgba(61, 220, 151, 0.08)"
            stroke="#3ddc97"
            strokeWidth={2.5 * s}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {coin && (
          // The pop animation lives on the group: CSS transform-origin would also shift the
          // ellipse's own rotate() attribute.
          <g className="dg-coin">
            <ellipse
              cx={coin.center_x}
              cy={coin.center_y}
              rx={coin.major_axis_px / 2}
              ry={coin.minor_axis_px / 2}
              transform={`rotate(${coin.angle_deg} ${coin.center_x} ${coin.center_y})`}
              fill="rgba(127,176,227,0.12)"
              stroke="#7fb0e3"
              strokeWidth={2 * s}
            />
          </g>
        )}
        {HAND_CONNECTIONS.map(([a, b], i) => (
          <line
            key={`${a}-${b}`}
            className="dg-bone"
            pathLength={1}
            style={{ ["--i" as string]: i }}
            x1={landmarks[a].x}
            y1={landmarks[a].y}
            x2={landmarks[b].x}
            y2={landmarks[b].y}
            stroke="#c3c7ce"
            strokeWidth={4 * s}
            strokeLinecap="round"
          />
        ))}
        {landmarks.map((p, i) => (
          <circle key={i} className="dg-joint" style={{ ["--i" as string]: i }} cx={p.x} cy={p.y} r={4.5 * s} fill="#eceef1" stroke="#0c0d10" strokeWidth={1.5 * s} />
        ))}
        {showLines && line(landmarks[0], landmarks[12], "Hand length", "#f4874b", 10)}
        {showLines && line(landmarks[5], landmarks[17], "Palm width", "#4cc38a", -40)}
      </g>
    </svg>
  );
}
