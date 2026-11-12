import { describe, expect, it } from "vitest";
import { bestFrames, bestRotation, ESTIMATE_LABEL, fitHand, coinScaledHandLengthMm, MARKER_MIN_GAP, spreadMarkers, type Marker } from "./fitHand";
import { COIN_MM, flatHand, handFrame, HAND_LENGTH_M, sweep } from "./testHands";

const genericHand = flatHand; // the truth the synthetic frames were made from

const palm = () => sweep(30, [{}, { yaw: 8 }, { pitch: -8 }], { noiseM: 0.003, seed: 3 });
const side = () => sweep(20, [{ yaw: 90 }, { yaw: 80 }], { noiseM: 0.003, seed: 5, coin: false });
const back = () => sweep(30, [{}, { yaw: 8 }], { flip: 180, noiseM: 0.003, seed: 9 });

describe("fitHand", () => {
  it("is labelled as an estimate", () => {
    expect(ESTIMATE_LABEL).toMatch(/Estimated 3D model/);
    expect(ESTIMATE_LABEL).toMatch(/not a measured scan/);
  });

  it("recovers the pose of the hand from three noisy views, closer to the truth than the noise", () => {
    const fit = fitHand({ palm: palm(), side: side(), back: back(), referenceDiameterMm: COIN_MM })!;
    const truth = genericHand();
    const rms = Math.sqrt(fit.pose.reduce((s, p, i) => s + (p.x - truth[i].x) ** 2 + (p.y - truth[i].y) ** 2 + (p.z - truth[i].z) ** 2, 0) / 21);
    expect(rms).toBeLessThan(0.03); // hand lengths: about 6 mm on a 19 cm hand
    expect(Math.hypot(fit.pose[12].x, fit.pose[12].y, fit.pose[12].z)).toBeCloseTo(1, 5);
    expect(fit.pose[12].y).toBeGreaterThan(0.9); // fingers up, wrist at the origin, as the model wants
    expect(fit.hand).toBe("right");
  });

  it("scales the hand with the coin, not with anything else", () => {
    const fit = fitHand({ palm: palm(), side: side(), back: back(), referenceDiameterMm: COIN_MM })!;
    // the coin is 23 mm and the synthetic hand 190 mm: the 2D length of this slightly cupped hand is a bit shorter
    expect(fit.handLengthMm!).toBeGreaterThan(0.93 * HAND_LENGTH_M * 1000);
    expect(fit.handLengthMm!).toBeLessThan(1.02 * HAND_LENGTH_M * 1000);
    const bigger = fitHand({ palm: palm(), side: side(), back: back(), referenceDiameterMm: 2 * COIN_MM })!;
    expect(bigger.handLengthMm! / fit.handLengthMm!).toBeCloseTo(2, 5);
  });

  it("without a coin there is no size", () => {
    const noCoin = sweep(30, [{}], { coin: false });
    expect(fitHand({ palm: noCoin, side: [], back: [], referenceDiameterMm: COIN_MM })).toBeNull(); // the palm needs the coin
  });

  it("works from the palm alone and says the other views are missing", () => {
    const fit = fitHand({ palm: palm(), side: [], back: [], referenceDiameterMm: COIN_MM })!;
    expect(fit.phases.side).toBeNull();
    expect(fit.phases.back).toBeNull();
    expect(fit.agreementMm).toBeNull();
    expect(fit.markers.map((m) => m.phase)).toEqual(["palm"]);
  });

  it("puts each marker on the side of the hand its view looked from", () => {
    const fit = fitHand({ palm: palm(), side: side(), back: back(), referenceDiameterMm: COIN_MM })!;
    const m = Object.fromEntries(fit.markers.map((x) => [x.phase, x]));
    expect(m.palm.direction.z).toBeGreaterThan(0.9); // the palm faces the viewer (+z)
    expect(m.palm.position.z).toBeGreaterThan(0);
    expect(m.back.direction.z).toBeLessThan(-0.9);
    expect(m.back.position.z).toBeLessThan(0);
    expect(Math.abs(m.side.direction.z)).toBeLessThan(0.45); // edge-on: from the side of the hand
    expect(Math.abs(m.side.position.x)).toBeGreaterThan(0.1);
  });

  it("reports how well the views agree, and lets a view that disagrees count for less", () => {
    const good = fitHand({ palm: palm(), side: side(), back: back(), referenceDiameterMm: COIN_MM })!;
    expect(good.agreementMm!).toBeLessThan(15);
    // a "back" view that is really a different, much larger hand shape
    const bad = back().map((f) => ({ ...f, world_landmarks: f.world_landmarks!.map((p, i) => (i > 8 ? { ...p, x: p.x * 1.8 } : p)) }));
    const worse = fitHand({ palm: palm(), side: side(), back: bad, referenceDiameterMm: COIN_MM })!;
    expect(worse.agreementMm!).toBeGreaterThan(good.agreementMm!);
    const truth = genericHand();
    const err = (f: typeof good) => Math.sqrt(f.pose.reduce((s, p, i) => s + (p.x - truth[i].x) ** 2 + (p.y - truth[i].y) ** 2 + (p.z - truth[i].z) ** 2, 0) / 21);
    expect(err(worse)).toBeLessThan(0.12);
  });
});

describe("pieces", () => {
  it("bestRotation recovers a known rotation", () => {
    const pts = genericHand().map((p) => [p.x, p.y, p.z] as [number, number, number]);
    const a = 0.7;
    const rot = (p: number[]) => [p[0] * Math.cos(a) + p[2] * Math.sin(a), p[1], -p[0] * Math.sin(a) + p[2] * Math.cos(a)] as [number, number, number];
    const turned = pts.map(rot);
    const r = bestRotation(turned, pts); // takes the turned set back onto the original
    const cT = [0, 1, 2].map((k) => turned.reduce((s, p) => s + p[k], 0) / 21);
    const cP = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / 21);
    const back = turned.map((q) => {
      const p = [q[0] - cT[0], q[1] - cT[1], q[2] - cT[2]];
      return [r[0][0] * p[0] + r[0][1] * p[1] + r[0][2] * p[2] + cP[0], r[1][0] * p[0] + r[1][1] * p[1] + r[1][2] * p[2] + cP[1], r[2][0] * p[0] + r[2][1] * p[1] + r[2][2] * p[2] + cP[2]];
    });
    for (let i = 0; i < 21; i++) for (let k = 0; k < 3; k++) expect(back[i][k]).toBeCloseTo(pts[i][k], 6);
  });

  it("bestFrames prefers frames closest to the view's own ideal and skips frames without an accepted coin", () => {
    const frames = [handFrame({ yaw: 30 }), handFrame({ yaw: 2 }), handFrame({ yaw: 10, coinAccepted: false }), handFrame({ yaw: 5 })];
    const best = bestFrames("palm", frames, -1, 2);
    expect(best).toHaveLength(2);
    expect(best[0]).toBe(frames[1]);
    expect(best[1]).toBe(frames[3]);
  });

  it("coinScaledHandLengthMm ignores frames without an accepted coin", () => {
    expect(coinScaledHandLengthMm([handFrame({ coin: false })], 23)).toBeNull();
    expect(coinScaledHandLengthMm([handFrame({ coinAccepted: false })], 23)).toBeNull();
    expect(coinScaledHandLengthMm([handFrame({})], 23)).toBeGreaterThan(150);
  });
});

describe("spreadMarkers", () => {
  const at = (phase: Marker["phase"], x: number, y: number, z: number): Marker => ({ phase, position: { x, y, z }, direction: { x: 0, y: 0, z: 1 }, frames: 5 });
  const gap = (a: Marker, b: Marker) => Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z);

  it("fans out markers that sit on the same spot, and keeps what each one stands for", () => {
    const out = spreadMarkers([at("palm", 0, 0.4, 0.07), at("side", 0, 0.4, 0.07), at("back", 0, 0.4, 0.07)]);
    expect(gap(out[0], out[1])).toBeGreaterThanOrEqual(MARKER_MIN_GAP - 1e-9);
    expect(gap(out[0], out[2])).toBeGreaterThanOrEqual(MARKER_MIN_GAP - 1e-9);
    expect(gap(out[1], out[2])).toBeGreaterThanOrEqual(MARKER_MIN_GAP - 1e-9);
    expect(out.map((m) => m.phase)).toEqual(["palm", "side", "back"]);
    expect(out[0].position).toEqual({ x: 0, y: 0.4, z: 0.07 }); // the first one stays where it is
    expect(out.every((m) => m.direction.z === 1)).toBe(true);
  });

  it("pushes close markers apart along the line between them, and leaves distant ones alone", () => {
    const close = spreadMarkers([at("palm", 0, 0.4, 0), at("side", 0.04, 0.4, 0)]);
    expect(close[1].position.x).toBeCloseTo(MARKER_MIN_GAP, 6);
    const far = spreadMarkers([at("palm", 0, 0.4, 0.07), at("back", 0.3, 0.4, -0.07)]);
    expect(far[1].position).toEqual({ x: 0.3, y: 0.4, z: -0.07 });
  });

  it("does not change the markers it was given", () => {
    const input = [at("palm", 0, 0, 0), at("side", 0, 0, 0)];
    spreadMarkers(input);
    expect(input[1].position).toEqual({ x: 0, y: 0, z: 0 });
  });
});
