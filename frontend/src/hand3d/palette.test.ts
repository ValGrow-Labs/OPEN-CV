import { describe, expect, it } from "vitest";
import { LIGHT_HEX, PALETTE_SIZE, ROLES, approach, assemble, hexToLinear, lightRgb, roleAt, stepPalette, toneAccentRgb, toneMotion, toneTarget, type Tone } from "./palette";

const TONES: Tone[] = ["idle", "ok", "warn"];
const glow = (pal: Float32Array) => [pal[roleAt("glow")], pal[roleAt("glow") + 1], pal[roleAt("glow") + 2]];

describe("tone palettes", () => {
  it("every tone has every colour role, as finite linear components in 0..1", () => {
    for (const tone of TONES) {
      const pal = toneTarget(tone);
      expect(pal.length).toBe(PALETTE_SIZE);
      expect(PALETTE_SIZE).toBe(ROLES.length * 3);
      for (const v of pal) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("idle is the brand blue, ok a cool green-cyan, warn a paler soft blue (by the glow colour)", () => {
    const [ir, ig, ib] = glow(toneTarget("idle"));
    const [or, og, ob] = glow(toneTarget("ok"));
    const [wr, wg, wb] = glow(toneTarget("warn"));
    expect(ib).toBeGreaterThan(ig); // blue: blue highest, red lowest
    expect(ig).toBeGreaterThan(ir);
    expect(og).toBeGreaterThan(or); // green-led
    expect(og).toBeGreaterThan(ob);
    expect(wb).toBeGreaterThan(wg); // soft blue: still blue-led, never orange
    expect(wb).toBeGreaterThan(wr);
    expect(wr).toBeGreaterThan(ir); // but paler than idle
  });

  it("the three tones are different and an unknown tone is idle", () => {
    expect(Array.from(toneTarget("ok"))).not.toEqual(Array.from(toneTarget("idle")));
    expect(Array.from(toneTarget("warn"))).not.toEqual(Array.from(toneTarget("ok")));
    expect(toneTarget(undefined)).toBe(toneTarget("idle"));
    expect(toneTarget("nonsense" as Tone)).toBe(toneTarget("idle"));
  });

  it("converts hex to the linear components three.js holds", () => {
    const out = [0, 0, 0];
    hexToLinear("#ffffff", out);
    expect(out).toEqual([1, 1, 1]);
    hexToLinear("#000000", out);
    expect(out).toEqual([0, 0, 0]);
    hexToLinear("#808080", out);
    expect(out[0]).toBeCloseTo(0.2158, 3);
  });

  it("gives the labels an accent as r g b", () => {
    expect(toneAccentRgb("idle")).toBe("37 168 255");
    expect(toneAccentRgb("warn")).toBe("136 169 255");
    expect(toneAccentRgb(undefined)).toBe(toneAccentRgb("idle"));
  });
});

describe("easing", () => {
  it("approach reaches about 95% of the way after the settle time, and never overshoots", () => {
    let v = 0;
    for (let i = 0; i < 25; i++) v = approach(v, 1, 10, 250); // 250 ms in 10 ms steps
    expect(v).toBeGreaterThan(0.94);
    expect(v).toBeLessThan(1);
    expect(approach(0.3, 0.3, 16, 250)).toBe(0.3);
    expect(approach(0, 1, 0, 250)).toBe(0);
    expect(approach(0, 1, 16, 0)).toBe(1); // no settle time: straight there
    expect(approach(0, 1, -5, 250)).toBe(0); // a clock that ran backwards does nothing
  });

  it("stepPalette moves a palette to the next tone in about a quarter of a second and then reports it is still", () => {
    const cur = new Float32Array(toneTarget("idle"));
    const target = toneTarget("warn");
    let moving = true;
    let steps = 0;
    while (moving && steps < 1000) {
      moving = stepPalette(cur, target, 16.7, 250);
      steps++;
    }
    expect(moving).toBe(false);
    expect(Array.from(cur)).toEqual(Array.from(target)); // exact at rest: no endless tiny steps
    expect(steps).toBeGreaterThan(10); // not instant ...
    expect(steps).toBeLessThan(60); // ... and well under a second (16.7 ms frames)
  });

  it("a new target mid-way turns round without a jump", () => {
    const cur = new Float32Array(toneTarget("idle"));
    for (let i = 0; i < 6; i++) stepPalette(cur, toneTarget("warn"), 16.7, 250);
    const before = Array.from(cur);
    const ok = toneTarget("ok");
    stepPalette(cur, ok, 16.7, 250);
    // one frame moves each colour only a fraction (about 18%) of the way to the new target: no jump
    for (let i = 0; i < before.length; i++) expect(Math.abs(cur[i] - before[i])).toBeLessThanOrEqual(0.2 * Math.abs(ok[i] - before[i]) + 1e-6);
  });

  it("stepPalette on a palette already at its target changes nothing and is still", () => {
    const cur = new Float32Array(toneTarget("ok"));
    expect(stepPalette(cur, toneTarget("ok"), 16.7)).toBe(false);
  });
});

describe("how a tone moves", () => {
  it("a pose that needs fixing scans more slowly and dimmer", () => {
    const warn = toneMotion("warn");
    const idle = toneMotion("idle");
    expect(warn.sweepSpeed).toBeLessThan(idle.sweepSpeed);
    expect(warn.sweepGain).toBeLessThan(idle.sweepGain);
    expect(toneMotion(undefined)).toEqual(idle);
  });
});

describe("assemble (the points converge on a hand that has just appeared)", () => {
  it("starts fully apart, ends together, and only ever moves one way", () => {
    expect(assemble(0)).toBe(1);
    expect(assemble(300)).toBe(0);
    expect(assemble(5000)).toBe(0);
    let last = 1;
    for (let t = 10; t <= 300; t += 10) {
      const a = assemble(t);
      expect(a).toBeLessThanOrEqual(last);
      expect(a).toBeGreaterThanOrEqual(0);
      last = a;
    }
  });

  it("moves quickly at first, then settles", () => {
    expect(assemble(75)).toBeLessThan(0.5); // a quarter of the time: more than half the way
    expect(assemble(150) - assemble(225)).toBeLessThan(assemble(0) - assemble(75));
  });

  it("is quiet for nonsense", () => {
    expect(assemble(-10)).toBe(0);
    expect(assemble(Number.NaN)).toBe(0);
    expect(assemble(50, 0)).toBe(0);
  });
});

describe("light theme colours", () => {
  const luminance = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  };

  it("every colour is a 6-digit hex", () => {
    for (const hex of Object.values(LIGHT_HEX)) expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("the hologram blues climb from deep to bright and read on a white page; only the ring core is white", () => {
    expect(luminance(LIGHT_HEX.deep)).toBeLessThan(luminance(LIGHT_HEX.mid));
    expect(luminance(LIGHT_HEX.mid)).toBeLessThan(luminance(LIGHT_HEX.glow));
    for (const role of ["deep", "mid", "glow", "ink", "measure"] as const) expect(luminance(LIGHT_HEX[role])).toBeLessThan(215);
    expect(LIGHT_HEX.ringCore.toLowerCase()).toBe("#ffffff");
  });

  it("the label ink is the darkest colour (navy, readable on a pale stage)", () => {
    const darkest = Math.min(...Object.values(LIGHT_HEX).map(luminance));
    expect(luminance(LIGHT_HEX.ink)).toBe(darkest);
  });

  it("lightRgb gives r g b for CSS", () => {
    expect(lightRgb("ink")).toBe("11 31 74");
    expect(lightRgb("ringCore")).toBe("255 255 255");
    expect(lightRgb("glow").split(" ").map(Number).every((n) => n >= 0 && n <= 255)).toBe(true);
  });

  it("the live tones are not read from the light table", () => {
    expect(toneTarget("idle").length).toBe(PALETTE_SIZE);
    expect(toneAccentRgb("idle")).toBe("37 168 255");
  });
});
