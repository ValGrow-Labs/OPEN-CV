import { describe, expect, it } from "vitest";
import { FINGER_TIPS, labelAnchor } from "../vision/liveLengths";
import { formatLabel, labelInputs, LABEL_FINGERS, leaderEnd, LengthSmoother, PLAUSIBLE_MM, placeLabels, type LabelInput, type PlacedLabel, type Rect } from "./fingerLabels";
import { videoToCanvas } from "./swarm";

const lengths = (thumb: number, index: number, middle: number, ring: number, little: number) => ({ thumb, index, middle, ring, little });

describe("formatLabel", () => {
  it("writes a rounded whole number of millimetres with a tilde: it is an estimate", () => {
    expect(formatLabel(72)).toBe("~72 mm");
    expect(formatLabel(71.6)).toBe("~72 mm");
    expect(formatLabel(71.4)).toBe("~71 mm");
    expect(formatLabel(8.5)).toBe("~9 mm");
  });
});

describe("LengthSmoother", () => {
  it("shows nothing until it has a few readings, then the median of them", () => {
    const s = new LengthSmoother();
    s.push(lengths(60, 70, 80, 75, 60), 0);
    s.push(lengths(61, 71, 81, 76, 61), 30);
    expect(s.read(40)).toBeNull(); // two readings: not enough
    s.push(lengths(62, 72, 82, 77, 62), 60);
    expect(s.read(70)).toEqual(lengths(61, 71, 81, 76, 61));
  });

  it("is steady against one wild frame: the median ignores it", () => {
    const s = new LengthSmoother();
    [72, 72, 73, 72, 72].forEach((v, i) => s.push({ middle: v }, i * 30));
    expect(s.read(160)?.middle).toBe(72);
    s.push({ middle: 110 }, 180); // one frame where the coin or a landmark was off
    expect(s.read(190)?.middle).toBe(72);
    s.push({ middle: 72 }, 210);
    expect(s.read(220)?.middle).toBe(72);
  });

  it("follows a real change within a few frames, using only the last five readings", () => {
    const s = new LengthSmoother();
    for (let i = 0; i < 5; i++) s.push({ index: 60 }, i * 30);
    expect(s.read(150)?.index).toBe(60);
    for (let i = 5; i < 8; i++) s.push({ index: 70 }, i * 30); // three of the last five are 70
    expect(s.read(250)?.index).toBe(70);
  });

  it("keeps the shown whole number until the median has moved a clear step, so it does not flicker between 71 and 72", () => {
    const s = new LengthSmoother();
    for (let i = 0; i < 5; i++) s.push({ ring: 71.4 }, i * 30);
    expect(s.read(150)?.ring).toBe(71);
    // the median drifts to 71.7 (rounds to 72) and back: the label stays at 71
    for (let i = 5; i < 12; i++) {
      s.push({ ring: 71.7 }, i * 30);
      expect(s.read(i * 30 + 10)?.ring).toBe(71);
    }
    // a clear move (more than a step) does change it
    for (let i = 12; i < 20; i++) s.push({ ring: 73.4 }, i * 30);
    expect(s.read(620)?.ring).toBe(73);
  });

  it("ignores readings that are not plausible lengths of a finger", () => {
    const s = new LengthSmoother();
    for (let i = 0; i < 6; i++) {
      s.push({ thumb: 0, index: Number.NaN, middle: 400, ring: -5, little: PLAUSIBLE_MM.min - 1 }, i * 30);
    }
    expect(s.read(200)).toBeNull();
    for (let i = 0; i < 4; i++) s.push({ middle: 80 }, 300 + i * 30);
    expect(s.read(450)).toEqual({ middle: 80 });
  });

  it("hides the labels when no coin reading has come for a moment, and starts afresh after that", () => {
    const s = new LengthSmoother();
    for (let i = 0; i < 5; i++) s.push(lengths(60, 70, 80, 75, 60), i * 30);
    expect(s.read(200)).not.toBeNull();
    s.push(null, 300); // coin not accepted: a null reading never refreshes the old numbers
    expect(s.read(400)).not.toBeNull(); // a short gap is bridged
    expect(s.read(900)).toBeNull(); // 780 ms after the last reading: gone
    // after the gap it needs a few fresh readings again (it does not bring the old numbers back)
    s.push(lengths(90, 90, 90, 90, 90), 1000);
    expect(s.read(1010)).toBeNull();
  });

  it("smooths each finger on its own", () => {
    const s = new LengthSmoother();
    for (let i = 0; i < 4; i++) s.push({ thumb: 50, index: i % 2 ? 70 : 100 }, i * 30);
    const r = s.read(130);
    expect(r?.thumb).toBe(50);
    expect(r?.middle).toBeUndefined();
  });
});

const overlaps = (a: PlacedLabel, b: PlacedLabel) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (l: PlacedLabel, r: Rect) => l.x >= r.x0 - 1e-6 && l.y >= r.y0 - 1e-6 && l.x + l.w <= r.x1 + 1e-6 && l.y + l.h <= r.y1 + 1e-6;
const input = (finger: (typeof LABEL_FINGERS)[number], x: number, y: number, dx = 0, dy = -1, w = 60, h = 22): LabelInput => ({ finger, text: "~72 mm", tip: { x, y }, dir: { x: dx, y: dy }, w, h });
const BOUNDS: Rect = { x0: 8, y0: 34, x1: 352, y1: 520 };

describe("placeLabels", () => {
  it("puts a label just beyond its fingertip, along the finger, when there is room", () => {
    const [l] = placeLabels([input("middle", 180, 300)], BOUNDS);
    expect(l.visible).toBe(true);
    // straight above the tip, centred on it, its lower edge a few px from the tip
    expect(l.x + l.w / 2).toBeCloseTo(180, 5);
    expect(l.y + l.h).toBeLessThan(300);
    expect(300 - (l.y + l.h)).toBeGreaterThan(4);
    expect(300 - (l.y + l.h)).toBeLessThan(20);
  });

  it("never overlaps two labels, even with the five tips close together (labels wider than the gap between tips)", () => {
    // five fingertips 28 px apart, the middle one highest, labels 60 px wide
    const tips = [
      input("thumb", 60, 330),
      input("index", 100, 200),
      input("middle", 130, 170),
      input("ring", 158, 190),
      input("little", 186, 250),
    ];
    const placed = placeLabels(tips, BOUNDS);
    expect(placed.every((l) => l.visible)).toBe(true);
    for (let i = 0; i < placed.length; i++) {
      expect(inside(placed[i], BOUNDS)).toBe(true);
      for (let j = i + 1; j < placed.length; j++) expect(overlaps(placed[i], placed[j])).toBe(false);
    }
  });

  it("keeps every label inside the camera picture: a fingertip at the very edge or off the top still gets a label inside", () => {
    const edge = [input("thumb", 2, 100, -1, 0), input("index", 350, 40), input("middle", 180, 5), input("ring", 120, 515, 0, 1), input("little", 360, 300, 1, 0)];
    const placed = placeLabels(edge, BOUNDS);
    for (const l of placed) if (l.visible) expect(inside(l, BOUNDS)).toBe(true);
    expect(placed.filter((l) => l.visible).length).toBeGreaterThanOrEqual(4);
  });

  it("stays out of the areas it is told to (the camera-switch button, the guidance pill)", () => {
    const button: Rect = { x0: 300, y0: 40, x1: 352, y1: 90 };
    const [l] = placeLabels([input("index", 326, 100)], BOUNDS, { reserved: [button] });
    expect(l.visible).toBe(true);
    const clash = l.x < button.x1 && button.x0 < l.x + l.w && l.y < button.y1 && button.y0 < l.y + l.h;
    expect(clash).toBe(false);
    expect(inside(l, BOUNDS)).toBe(true);
  });

  it("drops a label rather than draw it over another when there is truly no room", () => {
    const tiny: Rect = { x0: 0, y0: 0, x1: 70, y1: 30 }; // room for one label
    const placed = placeLabels([input("index", 30, 20), input("middle", 35, 20), input("ring", 40, 20)], tiny);
    const shown = placed.filter((l) => l.visible);
    expect(shown.length).toBe(1);
    expect(shown.length).toBeLessThan(3);
    // the middle finger's label is the one kept (the others give way first)
    expect(shown[0].finger).toBe("middle");
  });

  it("is a pure function of its input", () => {
    const tips = [input("thumb", 60, 330), input("index", 100, 200), input("middle", 130, 170), input("ring", 158, 190), input("little", 186, 250)];
    expect(placeLabels(tips, BOUNDS)).toEqual(placeLabels(tips, BOUNDS));
  });

  it("ends a leader line on the label's box, nearest the fingertip", () => {
    const [l] = placeLabels([input("middle", 180, 300)], BOUNDS);
    const e = leaderEnd(l);
    expect(e.x).toBeCloseTo(180, 5);
    expect(e.y).toBeCloseTo(l.y + l.h, 5);
    expect(leaderEnd({ ...l, tip: { x: 500, y: 600 } })).toEqual({ x: l.x + l.w, y: l.y + l.h });
  });
});

/** Landmarks of a real open hand (the same photo as swarm.test.ts) in a 360 x 560 camera card, as the capture screen maps them. */
const REAL = [[426, 770], [306, 740], [234, 674], [184, 605], [131, 545], [298, 555], [266, 444], [247, 373], [238, 311], [368, 542], [355, 412], [349, 325], [345, 256], [427, 552], [438, 436], [444, 354], [450, 290], [475, 567], [502, 476], [517, 417], [530, 363]];

describe("the labels on a real hand, as the capture screen lays them out", () => {
  const card = { width: 360, height: 560 };
  const bounds: Rect = { x0: 8, y0: 34, x1: card.width - 8, y1: card.height - 8 };
  const place = (transform: (p: { x: number; y: number }) => { x: number; y: number }, mirror: boolean, card2 = card) => {
    const lm = REAL.map(([x, y]) => {
      const t = transform({ x, y });
      const c = videoToCanvas(t, { width: 720, height: 1280 }, card2, mirror);
      return { x: c.x, y: c.y, z: 0 };
    });
    const inputs = labelInputs(lm, lengths(60, 70, 78, 72, 55), (t) => t.length * 7);
    return { lm, placed: placeLabels(inputs, { x0: 8, y0: 34, x1: card2.width - 8, y1: card2.height - 8 }) };
  };

  for (const [name, t, mirror] of [
    ["right hand", (p: { x: number; y: number }) => p, false],
    ["mirrored (front camera)", (p: { x: number; y: number }) => p, true],
    ["left hand", (p: { x: number; y: number }) => ({ x: 720 - p.x, y: p.y }), false],
    ["upside down", (p: { x: number; y: number }) => ({ x: 720 - p.x, y: 1280 - p.y }), false],
  ] as const) {
    it(`gives each of the five fingers a label that overlaps no other and stays inside the card (${name})`, () => {
      const { placed } = place(t, mirror);
      expect(placed.length).toBe(5);
      expect(placed.every((l) => l.visible)).toBe(true);
      for (let i = 0; i < placed.length; i++) {
        expect(inside(placed[i], bounds)).toBe(true);
        for (let j = i + 1; j < placed.length; j++) expect(overlaps(placed[i], placed[j])).toBe(false);
      }
    });
  }

  it("keeps each label near its own fingertip (the leader line is short) and lists the fingers in order", () => {
    const { placed, lm } = place((p) => p, false);
    expect(placed.map((l) => l.finger)).toEqual(["thumb", "index", "middle", "ring", "little"]);
    for (const l of placed) {
      const e = leaderEnd(l);
      expect(Math.hypot(e.x - l.tip.x, e.y - l.tip.y)).toBeLessThan(60);
      // the tip is the end of the cap just beyond the tip landmark
      const tip = lm[FINGER_TIPS[l.finger][1]];
      expect(Math.hypot(l.tip.x - tip.x, l.tip.y - tip.y)).toBeLessThan(40);
    }
  });

  it("still never overlaps on a narrow phone card and on a wide laptop card", () => {
    for (const card2 of [{ width: 320, height: 480 }, { width: 520, height: 400 }, { width: 900, height: 520 }]) {
      const { placed } = place((p) => p, false, card2);
      const shown = placed.filter((l) => l.visible);
      expect(shown.length).toBeGreaterThanOrEqual(4);
      for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) expect(overlaps(shown[i], shown[j])).toBe(false);
    }
  });
});

describe("labelInputs", () => {
  it("uses the app's own labelAnchor for the end of the fingertip's cap, and the label text is the smoothed length", () => {
    const lm = REAL.map(([x, y]) => ({ x, y, z: 0 }));
    const inputs = labelInputs(lm, { middle: 78.4, thumb: 61 }, () => 40);
    expect(inputs.map((i) => i.finger)).toEqual(["thumb", "middle"]); // only the fingers it has a length for
    expect(inputs[1].text).toBe("~78 mm");
    const tipI = FINGER_TIPS.middle[1];
    const bone = Math.hypot(lm[tipI].x - lm[tipI - 1].x, lm[tipI].y - lm[tipI - 1].y);
    const a = labelAnchor(lm, "middle", bone * 0.3);
    expect(inputs[1].tip.x).toBeCloseTo(a.x, 6);
    expect(inputs[1].tip.y).toBeCloseTo(a.y, 6);
    expect(Math.hypot(inputs[1].dir.x, inputs[1].dir.y)).toBeCloseTo(1, 6);
    expect(inputs[1].w).toBe(56); // text width 40 + padding 16
  });
});
