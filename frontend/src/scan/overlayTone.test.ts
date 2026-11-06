import { describe, expect, it } from "vitest";
import { holdTone, INITIAL_TONE, rawTone, type ToneState } from "./overlayTone";

describe("the tone the 3D hand asks for", () => {
  it("is calm with no hand, green with a good pose and pale blue when the pose needs fixing", () => {
    expect(rawTone(false, undefined)).toBe("idle");
    expect(rawTone(false, true)).toBe("idle"); // nothing tracked: whatever the last live result said
    expect(rawTone(true, true)).toBe("ok");
    expect(rawTone(true, false)).toBe("warn");
    expect(rawTone(true, undefined)).toBe("warn");
  });
});

describe("holding a tone so the colour does not flicker", () => {
  const HOLD = 300;

  it("starts calm and takes the first request at once", () => {
    expect(INITIAL_TONE.tone).toBe("idle");
    expect(holdTone(INITIAL_TONE, "warn", 10, HOLD)).toEqual({ tone: "warn", since: 10 });
  });

  it("keeps a tone for at least the hold time before changing it", () => {
    const warn: ToneState = { tone: "warn", since: 1000 };
    expect(holdTone(warn, "ok", 1100, HOLD)).toBe(warn);
    expect(holdTone(warn, "ok", 1299, HOLD)).toBe(warn);
    expect(holdTone(warn, "ok", 1300, HOLD)).toEqual({ tone: "ok", since: 1300 });
  });

  it("a request for the tone already shown changes nothing and does not restart the hold", () => {
    const ok: ToneState = { tone: "ok", since: 1000 };
    expect(holdTone(ok, "ok", 5000, HOLD)).toBe(ok);
  });

  it("frames flipping every few milliseconds change the colour at most once per hold time", () => {
    let state: ToneState = { tone: "ok", since: 0 };
    const changes: number[] = [];
    for (let t = 0; t < 3000; t += 30) {
      const next = holdTone(state, Math.floor(t / 30) % 2 ? "warn" : "ok", t, HOLD);
      if (next !== state) changes.push(t);
      state = next;
    }
    for (let i = 1; i < changes.length; i++) expect(changes[i] - changes[i - 1]).toBeGreaterThanOrEqual(HOLD);
    expect(changes.length).toBeLessThanOrEqual(3000 / HOLD);
  });

  it("a hold of zero follows every request", () => {
    expect(holdTone({ tone: "ok", since: 100 }, "warn", 100, 0)).toEqual({ tone: "warn", since: 100 });
  });
});
