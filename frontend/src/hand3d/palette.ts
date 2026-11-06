// Colours and timing of the camera-view overlay (pure: no DOM, no three.js, so it is tested without WebGL).
//
// The hologram has three tones: "idle" (cyan and blue: nothing to judge yet), "ok" (the pose is right: a cool
// green-cyan that still reads as the same hologram) and "warn" (the pose needs fixing: amber). Every colour the
// layer draws comes from this one table; the layer eases from one tone to another instead of jumping.

export type Tone = "ok" | "warn" | "idle";

/** The colour roles of the overlay, in the order they are stored in a palette array (3 numbers each). */
export const ROLES = ["deep", "mid", "glow", "spark", "wire", "rail", "pale"] as const;
export type Role = (typeof ROLES)[number];
export const PALETTE_SIZE = ROLES.length * 3;

const HEX: Record<Tone, Record<Role, string>> = {
  idle: { deep: "#0a3a8c", mid: "#2b8cff", glow: "#19e6e6", spark: "#dcfeff", wire: "#1fb4ff", rail: "#19e6e6", pale: "#d4fbff" },
  ok: { deep: "#0b5f5a", mid: "#1fc7a8", glow: "#3ddc97", spark: "#e4fff1", wire: "#2fd6b0", rail: "#5bf0b0", pale: "#e4fff1" },
  warn: { deep: "#7a3f06", mid: "#ff9a1f", glow: "#ffb020", spark: "#fff0d0", wire: "#ffa31a", rail: "#ffc04d", pale: "#fff0d0" },
};

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** A hex colour as three linear components (what three.js's ``Color.set(hex)`` holds, which the shaders use as
 *  they are, so the look of a tone does not depend on the table's spelling). */
export function hexToLinear(hex: string, out: ArrayLike<number> & { [i: number]: number }, at = 0): void {
  const n = parseInt(hex.slice(1), 16);
  out[at] = srgbToLinear(((n >> 16) & 255) / 255);
  out[at + 1] = srgbToLinear(((n >> 8) & 255) / 255);
  out[at + 2] = srgbToLinear((n & 255) / 255);
}

const TARGETS: Record<Tone, Float32Array> = { idle: new Float32Array(PALETTE_SIZE), ok: new Float32Array(PALETTE_SIZE), warn: new Float32Array(PALETTE_SIZE) };
for (const tone of Object.keys(TARGETS) as Tone[]) ROLES.forEach((role, i) => hexToLinear(HEX[tone][role], TARGETS[tone], i * 3));

/** The palette of a tone, as ROLES.length * 3 numbers. Shared: do not write to it. */
export function toneTarget(tone: Tone | undefined): Float32Array {
  return TARGETS[tone ?? "idle"] ?? TARGETS.idle;
}

/** The accent of a tone as "r g b" (0-255), for CSS ``rgb(var(--tag-rgb) / a)``: the labels follow the tone. */
export function toneAccentRgb(tone: Tone | undefined): string {
  const n = parseInt(HEX[tone ?? "idle"].glow.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/** Index of a role's first number in a palette array. */
export const roleAt = (role: Role): number => ROLES.indexOf(role) * 3;

/** Move ``value`` towards ``target`` so that about 95% of the way is done after ``settleMs`` (exponential, so a
 *  new target mid-way never jumps). Returns the new value. */
export function approach(value: number, target: number, dtMs: number, settleMs: number): number {
  if (!(settleMs > 0)) return target;
  const k = 1 - Math.exp((-3 * Math.max(0, dtMs)) / settleMs);
  return value + (target - value) * k;
}

/** Ease a palette array towards a target tone in place. Returns true while it is still moving. */
export function stepPalette(cur: Float32Array, target: Float32Array, dtMs: number, settleMs = 250): boolean {
  let moving = false;
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const d = target[i] - cur[i];
    if (Math.abs(d) < 5e-4) {
      cur[i] = target[i];
      continue;
    }
    cur[i] = approach(cur[i], target[i], dtMs, settleMs);
    moving = true;
  }
  return moving;
}

export interface ToneMotion {
  /** Multiplier on the speed of the scanning sweep. */
  sweepSpeed: number;
  /** Multiplier on how bright the sweep is. */
  sweepGain: number;
}

/** How a tone moves: a pose that needs fixing scans more slowly and dimmer, so it reads as "waiting". */
export function toneMotion(tone: Tone | undefined): ToneMotion {
  if (tone === "warn") return { sweepSpeed: 0.65, sweepGain: 0.6 };
  if (tone === "ok") return { sweepSpeed: 1.2, sweepGain: 1 };
  return { sweepSpeed: 1, sweepGain: 1 };
}

/** How far the points still are from the hand when it has just appeared: 1 at ``ageMs`` 0, easing out to 0 at
 *  ``durMs`` (the points converge quickly at first, then settle). */
export function assemble(ageMs: number, durMs = 300): number {
  if (!(durMs > 0) || !(ageMs >= 0)) return 0;
  const u = Math.min(1, ageMs / durMs);
  return (1 - u) * (1 - u) * (1 - u);
}
