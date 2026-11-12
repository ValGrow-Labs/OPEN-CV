// MILLIMESH brand pieces: the wordmark, a generic metallic coin illustration, and the line icons of the flow.
import { useId } from "react";
import type { CoinTone } from "./coins";

/** The widely letter-spaced MILLIMESH™ wordmark (the client's own brand). */
export function Wordmark({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  return (
    <span className={`mm-wordmark mm-wordmark--${size}`} role="img" aria-label="MILLIMESH">
      <span aria-hidden="true">MILLIMESH</span>
      <sup aria-hidden="true">™</sup>
    </span>
  );
}

const TONES: Record<CoinTone, { hi: string; mid: string; lo: string; rim: string; ink: string }> = {
  silver: { hi: "#f6f8fb", mid: "#b3bac6", lo: "#6c7480", rim: "#dfe4ec", ink: "#4a5260" },
  steel: { hi: "#eef2f7", mid: "#a9b4c4", lo: "#626d7e", rim: "#d5dce8", ink: "#434c5c" },
  copper: { hi: "#f6c9a6", mid: "#c9794a", lo: "#7c3f1f", rim: "#efb48c", ink: "#5a2c14" },
};

/** A generic stylised metallic coin: a brushed disc, a rim of dots and the denomination. Not a copy of any real coin's art. */
export function CoinDisc({ mark, tone, size = 64 }: { mark: string; tone: CoinTone; size?: number }) {
  const id = useId().replace(/:/g, "");
  const t = TONES[tone];
  const dots = Array.from({ length: 28 }, (_, i) => {
    const a = (i / 28) * Math.PI * 2;
    return <circle key={i} cx={50 + 43.5 * Math.cos(a)} cy={50 + 43.5 * Math.sin(a)} r={1.35} fill={t.ink} opacity={0.45} />;
  });
  return (
    <svg className="mm-coin" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={`${id}-face`} cx="34%" cy="28%" r="85%">
          <stop offset="0" stopColor={t.hi} />
          <stop offset="0.55" stopColor={t.mid} />
          <stop offset="1" stopColor={t.lo} />
        </radialGradient>
        <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={t.rim} />
          <stop offset="0.5" stopColor={t.mid} />
          <stop offset="1" stopColor={t.lo} />
        </linearGradient>
        <linearGradient id={`${id}-sheen`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="0.45" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="48" fill={`url(#${id}-rim)`} />
      <circle cx="50" cy="50" r="46" fill="none" stroke="#000" strokeOpacity="0.28" strokeWidth="1" />
      <circle cx="50" cy="50" r="40.5" fill={`url(#${id}-face)`} />
      <circle cx="50" cy="50" r="40.5" fill="none" stroke={t.ink} strokeOpacity="0.35" strokeWidth="1.2" />
      {dots}
      <circle cx="50" cy="50" r="30" fill="none" stroke={t.ink} strokeOpacity="0.22" strokeWidth="1" />
      <text x="50" y="50" textAnchor="middle" dominantBaseline="central" fontSize={mark.length > 2 ? 21 : 26} fontWeight="700" fill={t.ink} fillOpacity="0.78" fontFamily="inherit">
        {mark}
      </text>
      <ellipse cx="38" cy="30" rx="30" ry="18" fill={`url(#${id}-sheen)`} transform="rotate(-28 50 50)" />
    </svg>
  );
}

export const CameraIcon = () => (
  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.2a1 1 0 0 0 .8-.4l.9-1.2a1 1 0 0 1 .8-.4h3.6a1 1 0 0 1 .8.4l.9 1.2a1 1 0 0 0 .8.4h1.2A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z" />
    <circle cx="12" cy="12.5" r="3.4" />
  </svg>
);

export const PhoneIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="7" y="3" width="10" height="18" rx="2.4" />
    <path d="M10.5 18h3" />
    <path d="M3.2 9.5c-.6 1.6-.6 3.4 0 5M20.8 9.5c.6 1.6.6 3.4 0 5" opacity=".7" />
  </svg>
);

export const ArrowRight = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

export const CloseIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const SwitchIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 9h12l-3-3M20 15H8l3 3" />
  </svg>
);

/** The circular progress ring with a percentage (the capture card). */
export function Ring({ percent, label }: { percent: number; label: string }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, percent));
  return (
    <div className="mm-ring" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)}>
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r={r} className="mm-ring-track" />
        <circle cx="32" cy="32" r={r} className="mm-ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - p / 100)} transform="rotate(-90 32 32)" />
      </svg>
      <span className="mm-ring-num">{Math.round(p)}%</span>
    </div>
  );
}
