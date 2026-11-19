// Evaluation of the outline fingertip on RENDERED fingers with a known skin tip (SIMULATED; not real hands).
// Prints the tables quoted in docs/FINGER_ACCURACY_AUDIT.md. The thresholds in TIP_PARAMS were set on these same
// scenes (in-sample), so the numbers are optimistic.
import { describe, expect, it } from "vitest";
import { BACKGROUNDS, renderFinger, rng, SKIN_TONES, type Background } from "./fingerRender";
import { measureTip } from "./fingertip";

const CAP = 0.5;
const PX_PER_MM = 2.8; // about a phone picture of an adult hand

interface Row {
  bg: Background;
  skin: string;
  blur: number;
  noise: number;
  nail: boolean;
  ok: boolean;
  reason?: string;
  errMm: number;
  trueMm: number;
}

function run(): Row[] {
  const rows: Row[] = [];
  const rand = rng(11);
  let seed = 1;
  for (const [skinName, skin] of Object.entries(SKIN_TONES)) {
    for (const bg of BACKGROUNDS) {
      for (const blur of [0, 1.5, 3]) {
        for (const noise of [0, 6]) {
          for (const nail of [false, true]) {
            for (let rep = 0; rep < 3; rep++) {
              const insideMm = 2 + rand() * 4; // the landmark is 2-6 mm inside the skin tip (ASSUMED)
              const r = renderFinger({
                size: 150, skin, background: bg, pxPerMm: PX_PER_MM, distalSkinMm: 24, insideMm, widthMm: 17,
                angleDeg: rand() * 360, blurSigma: blur, noise, nail: nail ? [190, 40, 70] : null, seed: seed++,
              });
              const est = measureTip(r.image, r.dip, r.tip, CAP);
              rows.push({ bg, skin: skinName, blur, noise, nail, ok: est.ok, reason: est.reason, errMm: (est.extensionPx - r.trueExtensionPx) / PX_PER_MM, trueMm: insideMm });
            }
          }
        }
      }
    }
  }
  return rows;
}

const pct = (v: number[], q: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
};
const f = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");

function table(title: string, groups: Map<string, Row[]>): string {
  const lines = [`### ${title}`, "", "| group | scenes | outline found | fallback | error mm mean | SD | p95 abs | wrong (>2 mm) |", "|---|---|---|---|---|---|---|---|"];
  for (const [name, rs] of groups) {
    const ok = rs.filter((r) => r.ok);
    const errs = ok.map((r) => r.errMm);
    const mean = errs.reduce((a, b) => a + b, 0) / (errs.length || 1);
    const sd = Math.sqrt(errs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, errs.length - 1));
    const wrong = ok.filter((r) => Math.abs(r.errMm) > 2).length;
    lines.push(`| ${name} | ${rs.length} | ${ok.length} (${((100 * ok.length) / rs.length).toFixed(0)}%) | ${((100 * (rs.length - ok.length)) / rs.length).toFixed(0)}% | ${f(mean)} | ${f(sd)} | ${f(pct(errs.map(Math.abs), 0.95))} | ${wrong} |`);
  }
  return lines.join("\n");
}

function groupBy(rows: Row[], key: (r: Row) => string): Map<string, Row[]> {
  const m = new Map<string, Row[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return m;
}

describe("outline fingertip on rendered fingers (SIMULATED)", () => {
  const rows = run();

  it("prints the evaluation tables", () => {
    const out = [
      `SIMULATED, ${rows.length} rendered fingers: 3 skin tones x 7 backgrounds x blur 0/1.5/3 px x noise 0/6 x nail polish no/yes x 3 placements; ${PX_PER_MM} px/mm, finger 17 mm wide, landmark 2-6 mm inside the skin tip (ASSUMED); cap ${CAP} x distal segment.`,
      table("By background (nail polish included)", groupBy(rows, (r) => r.bg)),
      table("By skin tone", groupBy(rows, (r) => r.skin)),
      table("By blur sigma, px (clean backgrounds only: white, grey, dark, green, wood)", groupBy(rows.filter((r) => ["white", "grey", "dark", "green", "wood"].includes(r.bg)), (r) => `blur ${r.blur}`)),
      table("By nail polish (clean backgrounds only)", groupBy(rows.filter((r) => ["white", "grey", "dark", "green", "wood"].includes(r.bg)), (r) => (r.nail ? "nail polish" : "no polish"))),
      table("Clean backgrounds (white, grey, dark, green), no polish, by skin tone", groupBy(rows.filter((r) => ["white", "grey", "dark", "green"].includes(r.bg) && !r.nail), (r) => r.skin)),
      table("Clean backgrounds (white, grey, dark, green), no polish, by sensor noise", groupBy(rows.filter((r) => ["white", "grey", "dark", "green"].includes(r.bg) && !r.nail), (r) => `noise ${r.noise}`)),
      table("Everything together", new Map([["all", rows]])),
    ];
    const byBg = new Map<string, Map<string, number>>();
    for (const r of rows.filter((x) => !x.nail && !x.ok)) {
      const m = byBg.get(r.bg) ?? new Map<string, number>();
      m.set(r.reason ?? "?", (m.get(r.reason ?? "?") ?? 0) + 1);
      byBg.set(r.bg, m);
    }
    out.push(`Fallback reasons without nail polish, by background: ${[...byBg].map(([bg, m]) => `${bg}: ${[...m].map(([k, v]) => `${k} ${v}`).join(", ")}`).join(" | ")}`);
    const reasons = new Map<string, number>();
    for (const r of rows) if (!r.ok) reasons.set(r.reason ?? "?", (reasons.get(r.reason ?? "?") ?? 0) + 1);
    out.push(`Fallback reasons: ${[...reasons].map(([k, v]) => `${k} ${v}`).join(", ")}`);
    const bad = rows.filter((r) => r.ok && Math.abs(r.errMm) > 2).slice(0, 8);
    out.push(`First wrong-boundary cases: ${bad.map((r) => `${r.bg}/${r.skin}/blur${r.blur}/noise${r.noise}/${r.nail ? "nail" : "plain"} err ${f(r.errMm)} mm`).join("; ") || "none"}`);
    console.log("\n" + out.join("\n\n"));
    expect(rows.length).toBeGreaterThan(300);
  });

  it("finds the tip on clean backgrounds, and gives up on a skin-coloured one", () => {
    const clean = rows.filter((r) => ["white", "grey", "dark", "green"].includes(r.bg) && r.blur <= 1.5 && !r.nail);
    const found = clean.filter((r) => r.ok);
    expect(found.length / clean.length).toBeGreaterThan(0.9);
    expect(pct(found.map((r) => Math.abs(r.errMm)), 0.5)).toBeLessThan(1.0);
    const skinBg = rows.filter((r) => r.bg === "skin");
    expect(skinBg.filter((r) => r.ok).length / skinBg.length).toBeLessThan(0.15);
    // a boundary that is accepted should rarely be wrong by more than 2 mm
    const ok = rows.filter((r) => r.ok);
    expect(ok.filter((r) => Math.abs(r.errMm) > 2).length / ok.length).toBeLessThan(0.1);
  });
});
