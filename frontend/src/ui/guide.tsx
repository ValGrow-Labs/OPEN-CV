// Guidance visuals: the stage-driven hand scene (welcome page, pre-scan walkthrough) and the
// animated coaching icons shown with live instructions during a scan.
import { ArrowsIn, CheckCircle, Coin, CornersOut, HandPalm, Pause, Sun, type Icon } from "@phosphor-icons/react";
import { useId } from "react";
import { HAND_CONNECTIONS } from "../vision/geometry";
import type { LiveCode } from "../vision/liveChecks";
import { stagger } from "./motion";

export type GuideStage = 0 | 1 | 2;

export const GUIDE_STEPS: { title: string; text: string; short: string; caption: string }[] = [
  {
    title: "Open your palm",
    short: "Show palm",
    text: "Face your palm to the camera with fingers straight and together.",
    caption: "The camera finds 21 points on your open hand.",
  },
  {
    title: "Place the coin in the centre",
    short: "Place coin",
    text: "Lay a quarter flat in the middle of your palm, fully visible.",
    caption: "A US quarter (24.26 mm) gives the scale.",
  },
  {
    title: "Hold still for a few seconds",
    short: "Hold still",
    text: "Keep your hand inside the guide until the progress bar fills.",
    caption: "Hold still while your hand is measured.",
  },
];

// Joint positions of an open right palm facing the camera (viewBox 240 x 300), in MediaPipe
// landmark order: wrist, thumb CMC..tip, then index, middle, ring and little MCP..tip.
// The silhouette below is built from these same points, so every dot sits on its knuckle.
const JOINTS: [number, number][] = [
  [119, 262],
  [95, 240], [76, 218], [62, 197], [52, 177],
  [95, 151], [89, 117], [86, 95], [84, 75],
  [117, 146], [116, 106], [115, 82], [114, 60],
  [138, 151], [142, 115], [144, 93], [146, 74],
  [156, 162], [163, 135], [167, 118], [170, 102],
]; // fmt: skip

type Vec = [number, number];
const add = (a: Vec, b: Vec, k = 1): Vec => [a[0] + b[0] * k, a[1] + b[1] * k];
const f = (p: Vec) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;

/** Unit direction MCP -> tip and its right-hand normal, for finger `mcp`..`tip`. */
function axis(mcp: number, tip: number): { u: Vec; n: Vec } {
  const [ax, ay] = JOINTS[mcp];
  const [bx, by] = JOINTS[tip];
  const len = Math.hypot(bx - ax, by - ay);
  const u: Vec = [(bx - ax) / len, (by - ay) / len];
  return { u, n: [-u[1], u[0]] };
}

// Long fingers: MCP, tip, base and tip half-widths, and how far up the finger its webs sit.
const FINGERS = [
  { mcp: 5, tip: 8, rb: 9.5, rt: 7.5, web: 14 },
  { mcp: 9, tip: 12, rb: 9.8, rt: 8, web: 12 },
  { mcp: 13, tip: 16, rb: 9.4, rt: 7.6, web: 12 },
  { mcp: 17, tip: 20, rb: 8, rt: 6.4, web: 12 },
];

/**
 * One continuous silhouette traced clockwise from the wrist: thumb, finger edges with
 * rounded tips, curved skin webs between fingers, then the ulnar palm edge back down.
 */
function buildHandPath(): string {
  const parts: string[] = [];
  const tipArc = (r: number, to: Vec) => `A${r} ${r} 0 0 1 ${f(to)}`;

  // Wrist (radial side) up into the thumb's outer edge.
  const t = axis(2, 4);
  const cmcOut = add(JOINTS[1] as Vec, t.n, -15);
  const mcpOut = add(JOINTS[2] as Vec, t.n, -10.5);
  const thumbTipOut = add(JOINTS[4] as Vec, t.n, -8.5);
  const thumbTipIn = add(JOINTS[4] as Vec, t.n, 8.5);
  const thumbIn = add(JOINTS[2] as Vec, t.n, 10);
  parts.push(`M101 292 L100 268 C99 258 ${f(add(cmcOut, [6, 6]))} ${f(cmcOut)}`);
  // The thenar (thumb-side) edge bulges outward; the controls keep it tangent to the wrist
  // curve before it and to the straight thumb edge after it.
  const c1 = add(cmcOut, [-0.7, -0.7], 7);
  const c2 = add(mcpOut, t.u, -9);
  parts.push(`C${f(c1)} ${f(c2)} ${f(mcpOut)} L${f(thumbTipOut)} ${tipArc(8.5, thumbTipIn)} L${f(thumbIn)}`);

  // Thumb crotch: a valley curving down, then the palm's radial edge up to the index finger.
  const crotchEnd: Vec = [90, 206];
  parts.push(`C${f(add(thumbIn, [-t.u[0], -t.u[1]], 8))} ${f(add(crotchEnd, [0, 10]))} ${f(crotchEnd)}`);

  FINGERS.forEach((fg, i) => {
    const { u, n } = axis(fg.mcp, fg.tip);
    const mcp = JOINTS[fg.mcp] as Vec;
    const tip = JOINTS[fg.tip] as Vec;
    const webBase = add(mcp, u, fg.web);
    const left = i === 0 ? add(mcp, n, -fg.rb) : add(webBase, n, -fg.rb);
    if (i === 0) {
      parts.push(`L${f(add(left, [0.5, 8]))} L${f(left)}`);
    } else {
      // Skin web: a rounded valley from the previous finger's right edge to this left edge.
      const prev = FINGERS[i - 1];
      const pa = axis(prev.mcp, prev.tip);
      const prevRight = add(add(JOINTS[prev.mcp] as Vec, pa.u, prev.web), pa.n, prev.rb);
      parts.push(`C${f(add(prevRight, [0, 6]))} ${f(add(left, [0, 6]))} ${f(left)}`);
    }
    parts.push(`L${f(add(tip, n, -fg.rt))} ${tipArc(fg.rt, add(tip, n, fg.rt))}`);
    const isLast = i === FINGERS.length - 1;
    const right = isLast ? add(mcp, n, fg.rb) : add(webBase, n, fg.rb);
    parts.push(`L${f(right)}`);
  });

  // Ulnar palm edge back down to the wrist.
  parts.push("L165 182 C165 215 160 240 146 262 L141 270 L140 292 Z");
  return parts.join(" ");
}

const HAND_SILHOUETTE = buildHandPath();
const OUTLINE = 1.7;

const COIN = { x: 124, y: 200, r: 13 };

/** Illustrated hand that acts out a guide stage: 0 palm, 1 coin, 2 hold still / measuring. */
export function HandScene({ stage, className = "" }: { stage: GuideStage; className?: string }) {
  const uid = useId().replace(/:/g, "");
  const skin = `sc-skin-${uid}`;
  const fade = `sc-fade-${uid}`;
  const dots = `sc-dots-${uid}`;
  const beam = `sc-beam-${uid}`;
  return (
    <div className={`scene ${className}`} data-stage={stage} aria-hidden="true">
      <svg viewBox="0 0 240 300" fill="none">
        <defs>
          <pattern id={dots} width="12" height="12" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.7" fill="rgba(255,255,255,0.14)" />
          </pattern>
          <linearGradient id={skin} x1="0" y1="50" x2="0" y2="290" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#2a2e35" />
            <stop offset="1" stopColor="#17191e" />
          </linearGradient>
          <linearGradient id={fade} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0.82" stopColor="#fff" />
            <stop offset="0.96" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <mask id={`${fade}-m`} maskUnits="userSpaceOnUse" x="0" y="0" width="240" height="300">
            <rect width="240" height="300" fill={`url(#${fade})`} />
          </mask>
          <linearGradient id={beam} x1="0" x2="1">
            <stop offset="0" stopColor="#f08a4b" stopOpacity="0" />
            <stop offset="0.5" stopColor="#f08a4b" stopOpacity="0.9" />
            <stop offset="1" stopColor="#f08a4b" stopOpacity="0" />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="240" height="300" fill={`url(#${dots})`} />
        <path className="sc-frame" d="M22 44V24h20M218 44V24h-20M22 256v20h20M218 256v20h-20" stroke="rgba(255,255,255,0.4)" strokeWidth="2" strokeLinecap="round" />

        <g className="sc-hand" mask={`url(#${fade}-m)`}>
          <path d={HAND_SILHOUETTE} fill={`url(#${skin})`} stroke="rgba(255,255,255,0.86)" strokeWidth={OUTLINE} strokeLinejoin="round" />
        </g>

        <g className="sc-bones" stroke="rgba(255,255,255,0.32)" strokeWidth="1.2" strokeLinecap="round">
          {HAND_CONNECTIONS.map(([a, b], i) => (
            <line key={`${a}-${b}`} pathLength={1} x1={JOINTS[a][0]} y1={JOINTS[a][1]} x2={JOINTS[b][0]} y2={JOINTS[b][1]} style={stagger(i)} />
          ))}
        </g>
        <line className="sc-length" pathLength={1} x1={JOINTS[0][0]} y1={JOINTS[0][1]} x2={JOINTS[12][0]} y2={JOINTS[12][1] - 8} stroke="#f08a4b" strokeWidth="1.6" />
        {JOINTS.map(([x, y], i) => (
          <circle key={i} className="sc-dot" cx={x} cy={y} r="2.5" fill="#ffffff" style={stagger(i)} />
        ))}
        <circle className="sc-ring" cx={COIN.x} cy={COIN.y} r={COIN.r} stroke="#f08a4b" strokeWidth="1.5" />
        <g className="sc-coin">
          <circle cx={COIN.x} cy={COIN.y} r={COIN.r} fill="#9ea3a8" stroke="#d9dde0" strokeWidth="2" />
          <circle cx={COIN.x} cy={COIN.y} r={COIN.r - 5} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1" />
        </g>
        <rect className="sc-beam" x="22" y="24" width="196" height="2" fill={`url(#${beam})`} />
        <rect x="40" y="286" width="160" height="4" rx="2" fill="rgba(255,255,255,0.12)" />
        <rect className="sc-progress" x="40" y="286" width="160" height="4" rx="2" fill="#f08a4b" />
      </svg>
    </div>
  );
}

export type CoachKind = "palm" | "frame" | "closer" | "coin" | "light" | "still" | "ok";

export function coachKind(code: LiveCode | undefined): CoachKind {
  switch (code) {
    case undefined:
      return "ok";
    case "hand_out_of_frame":
    case "too_close":
      return "frame";
    case "hand_too_small":
    case "coin_too_small":
      return "closer";
    case "coin_missing":
    case "coin_not_found":
    case "coin_not_on_palm":
    case "coin_occluded":
    case "coin_irregular_boundary":
    case "coin_tilted":
      return "coin";
    case "too_dark":
    case "too_bright":
    case "coin_glare":
    case "coin_low_contrast":
      return "light";
    case "hold_still":
    case "coin_blurry":
    case "coin_low_confidence":
      return "still";
    default:
      return "palm";
  }
}

const COACH_ICONS: Record<CoachKind, Icon> = {
  palm: HandPalm,
  frame: CornersOut,
  closer: ArrowsIn,
  coin: Coin,
  light: Sun,
  still: Pause,
  ok: CheckCircle,
};

/** Phosphor pictogram for the current capture problem; the wrapper class animates it. */
export function CoachIcon({ kind }: { kind: CoachKind }) {
  const Glyph = COACH_ICONS[kind];
  return (
    <span className={`coach-icon coach-${kind}`} aria-hidden="true">
      <Glyph size={22} weight="regular" />
    </span>
  );
}

/** Which guide step the live result corresponds to (0 palm, 1 coin, 2 hold still). */
export function liveStage(codes: readonly LiveCode[]): GuideStage {
  const hand: LiveCode[] = ["no_hand", "hand_out_of_frame", "hand_too_small", "fingers_bent", "palm_not_flat", "too_close"];
  if (codes.some((c) => hand.includes(c))) return 0;
  if (codes.some((c) => c.startsWith("coin_") && c !== "coin_blurry" && c !== "coin_low_confidence")) return 1;
  return 2;
}
