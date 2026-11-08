// Coverage bins, guidance wording and the capture gate of the EXPERIMENTAL board-capture page.
import { describe, expect, it } from "vitest";
import {
  ALL_BINS,
  binOf,
  binWords,
  captureGate,
  guidance,
  MIN_MARKERS,
  MIN_SHARPNESS,
  missingRequired,
  missingWords,
  nearestMissingLow,
  REQUIRED_BINS,
  sideWords,
  type BinId,
  type LiveAnalysis,
} from "./coverage";
import { laplacianSharpness, pixelToBoard, poseChange, thumbSideOnBoard } from "./frameMetrics";

const allLow = (except: number[] = []): BinId[] => Array.from({ length: 12 }, (_, k) => k).filter((k) => !except.includes(k)).map((k) => `low-${k}` as BinId);
const good = (patch: Partial<LiveAnalysis> = {}): LiveAnalysis => ({ markers: 8, elevationDeg: 12, azimuthDeg: 45, sharpness: 1.2, steady: { rotDeg: 0.2, moveMm: 1 }, ...patch });

describe("coverage bins", () => {
  it("has one top view, 12 required low sectors and 6 optional middle sectors", () => {
    expect(ALL_BINS.filter((b) => b.ring === "top")).toHaveLength(1);
    expect(ALL_BINS.filter((b) => b.ring === "low" && b.required)).toHaveLength(12);
    expect(ALL_BINS.filter((b) => b.ring === "mid" && !b.required)).toHaveLength(6);
    expect(REQUIRED_BINS).toHaveLength(13);
  });

  it("places a camera position in its bin by elevation and azimuth", () => {
    expect(binOf(89, 10)).toBe("top");
    expect(binOf(60, 200)).toBe("top");
    expect(binOf(12, 0)).toBe("low-0");
    expect(binOf(12, 29.9)).toBe("low-0");
    expect(binOf(12, 30)).toBe("low-1");
    expect(binOf(8, 359.9)).toBe("low-11");
    expect(binOf(22, -10)).toBe("low-11"); // wraps
    expect(binOf(15, 180)).toBe("low-6"); // the open edge is a sector boundary
    expect(binOf(15, 179.9)).toBe("low-5");
    expect(binOf(30, 70)).toBe("mid-1");
    expect(binOf(45, 359)).toBe("mid-5");
  });

  it("leaves the heights between the rings (and below the low ring) unbinned", () => {
    expect(binOf(5, 10)).toBeNull();
    expect(binOf(23.5, 10)).toBeNull();
    expect(binOf(50, 10)).toBeNull();
    expect(binOf(NaN, 10)).toBeNull();
  });

  it("names the sides in words, with the thumb side when it is known", () => {
    expect(sideWords(0)).toBe("the fingertip side");
    expect(sideWords(355)).toBe("the fingertip side");
    expect(sideWords(90)).toBe("the top-edge side");
    expect(sideWords(90, "top")).toBe("the thumb side (top edge)");
    expect(sideWords(270, "top")).toBe("the little-finger side (bottom edge)");
    expect(sideWords(270, "bottom")).toBe("the thumb side (bottom edge)");
    expect(sideWords(180)).toBe("the wrist side (open edge)");
    expect(sideWords(45)).toBe("between the fingertip side and the top-edge side");
    expect(binWords("low-3")).toBe("low 90–120° (the top-edge side)");
    expect(binWords("low-4")).toBe("low 120–150° (between the top-edge side and the wrist side (open edge))");
    expect(binWords("top")).toBe("the top view (straight above)");
  });

  it("says what is missing before the build may start", () => {
    expect(missingRequired(new Set())).toHaveLength(13);
    expect(missingWords(new Set())).toBe("Still needed: the top view; 12 low views (0–30°, 30–60°, 60–90°, 90–120°, 120–150°, 150–180°, 180–210°, 210–240°, 240–270°, 270–300°, 300–330°, 330–360°).");
    const nearly = new Set<BinId>(["top", ...allLow([4])]);
    expect(missingRequired(nearly)).toEqual(["low-4"]);
    expect(missingWords(nearly)).toBe("Still needed: 1 low view (120–150°).");
    const done = new Set<BinId>(["top", ...allLow()]);
    expect(missingRequired(done)).toEqual([]);
    expect(missingWords(done)).toBe("");
    // the optional middle ring is never required
    expect(missingRequired(new Set<BinId>([...done, "mid-0"]))).toEqual([]);
  });

  it("points to the nearest missing low sector", () => {
    const f = new Set<BinId>(["top", ...allLow([2, 9])]);
    expect(nearestMissingLow(f, 40)?.id).toBe("low-2");
    expect(nearestMissingLow(f, 300)?.id).toBe("low-9");
    expect(nearestMissingLow(new Set<BinId>(["top", ...allLow()]), 10)).toBeNull();
  });
});

describe("capture gate", () => {
  const none = new Set<BinId>();
  it("lets a steady, sharp frame with enough markers into an unfilled bin", () => {
    const g = captureGate(good(), none);
    expect(g).toMatchObject({ ok: true, code: "ok", bin: "low-1" });
  });

  it("blocks with a reason in words, checked in order", () => {
    expect(captureGate(good({ markers: 0 }), none)).toMatchObject({ ok: false, code: "no_markers" });
    const few = captureGate(good({ markers: MIN_MARKERS - 1 }), none);
    expect(few).toMatchObject({ ok: false, code: "few_markers" });
    expect(few.words).toBe(`Only ${MIN_MARKERS - 1} printed markers found (needs ${MIN_MARKERS}).`);
    expect(captureGate(good({ elevationDeg: null }), none).code).toBe("no_pose");
    expect(captureGate(good({ elevationDeg: 50 }), none)).toMatchObject({ code: "between_rings", words: expect.stringContaining("50°") });
    expect(captureGate(good(), new Set<BinId>(["low-1"]))).toMatchObject({ code: "bin_filled", bin: "low-1" });
    const blurred = captureGate(good({ sharpness: MIN_SHARPNESS - 0.1 }), none);
    expect(blurred).toMatchObject({ ok: false, code: "blurred" });
    expect(blurred.words).toContain("blurred");
    expect(captureGate(good({ sharpness: null }), none).code).toBe("blurred");
    expect(captureGate(good({ steady: null }), none)).toMatchObject({ code: "unsteady", words: "Waiting for a few steady frames." });
    expect(captureGate(good({ steady: { rotDeg: 3, moveMm: 1 } }), none).code).toBe("unsteady");
    expect(captureGate(good({ steady: { rotDeg: 0.1, moveMm: 12 } }), none).code).toBe("unsteady");
  });
});

describe("guidance", () => {
  it("asks for the top view first", () => {
    expect(guidance(good({ elevationDeg: 30 }), new Set())).toMatch(/^First the top view: hold the phone straight above the hand/);
    expect(guidance(good({ elevationDeg: 80, azimuthDeg: 10 }), new Set())).toBe("Hold still: taking this view.");
    expect(guidance(good({ elevationDeg: 80, steady: { rotDeg: 4, moveMm: 2 } }), new Set())).toBe("Hold the phone still.");
    expect(guidance(good({ elevationDeg: 80, sharpness: 0.3 }), new Set())).toMatch(/^The picture is blurred/);
  });

  it("then lowers the phone and sends it round the hand", () => {
    const top = new Set<BinId>(["top"]);
    expect(guidance(good({ elevationDeg: 40 }), top)).toBe("Lower the phone until it is about level with the fingertips (8 to 22° above the board; now 40°).");
    expect(guidance(good({ elevationDeg: 5 }), top)).toBe("Raise the phone a little (8 to 22° above the board; now 5°).");
    const some = new Set<BinId>(["top", "low-0", "low-1"]);
    expect(guidance(good({ azimuthDeg: 45 }), some)).toBe("This side is done. Move round to the top-edge side (60–90°), keeping the phone low.");
    expect(guidance(good({ azimuthDeg: 45 }), some, "top")).toContain("thumb side (top edge)");
    expect(guidance(good({ azimuthDeg: 75 }), some)).toBe("Hold still: taking this view.");
  });

  it("asks for markers when there are too few", () => {
    expect(guidance(good({ markers: 0 }), new Set())).toBe("Point the camera at the printed board so its black squares are in view.");
    expect(guidance(good({ markers: 2 }), new Set())).toMatch(/^Only 2 printed markers in view: step back a little/);
  });

  it("says when every required view is taken", () => {
    const done = new Set<BinId>(["top", ...allLow()]);
    expect(guidance(good({ elevationDeg: 12 }), done)).toMatch(/^All required views are taken/);
    expect(guidance(good({ elevationDeg: 35, azimuthDeg: 10 }), done)).toBe("Hold still: adding this optional view.");
  });
});

describe("frame measures", () => {
  function picture(blurPx: number): Uint8ClampedArray {
    // a 160 x 120 picture of black squares on white, blurred by a horizontal and vertical box of 2 * blurPx + 1
    const W = 160, H = 120;
    const g = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = (Math.floor(x / 20) + Math.floor(y / 20)) % 2 ? 230 : 25;
    const b = (src: Float32Array, dx: number, dy: number) => {
      const out = new Float32Array(W * H);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          let s = 0, n = 0;
          for (let k = -blurPx; k <= blurPx; k++) {
            const xx = Math.min(W - 1, Math.max(0, x + k * dx)), yy = Math.min(H - 1, Math.max(0, y + k * dy));
            s += src[yy * W + xx];
            n++;
          }
          out[y * W + x] = s / n;
        }
      return out;
    };
    const blurred = blurPx ? b(b(g, 1, 0), 0, 1) : g;
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) rgba.set([blurred[i], blurred[i], blurred[i], 255], i * 4);
    return rgba;
  }

  it("measures a crisp picture as sharper than a blurred one", () => {
    const crisp = laplacianSharpness(picture(0), 160, 120).value!;
    const soft = laplacianSharpness(picture(4), 160, 120).value!;
    expect(crisp).toBeGreaterThan(MIN_SHARPNESS);
    expect(soft).toBeLessThan(MIN_SHARPNESS);
    expect(laplacianSharpness(new Uint8ClampedArray(160 * 120 * 4).fill(200), 160, 120).value).toBeNull(); // no edges
  });

  it("measures how far the camera moved between two poses", () => {
    const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const c = Math.cos(Math.PI / 180), s = Math.sin(Math.PI / 180);
    expect(poseChange({ R: I, t: [0, 0, 300] }, { R: I, t: [3, 4, 300] }).moveMm).toBeCloseTo(5, 6);
    expect(poseChange({ R: I, t: [0, 0, 300] }, { R: [c, -s, 0, s, c, 0, 0, 0, 1], t: [0, 0, 300] }).rotDeg).toBeCloseTo(1, 6);
  });

  it("finds the thumb's board edge from the top view's landmarks", () => {
    // camera 400 mm straight above (100, 100), looking down, image x along board +x, image y along board -y
    const K = { fx: 1000, fy: 1000, cx: 640, cy: 360 };
    const pose = { R: [1, 0, 0, 0, -1, 0, 0, 0, -1], t: [-100, 100, 400] };
    expect(pixelToBoard(K, pose, 640, 360)).toEqual({ x: expect.closeTo(100, 6), y: expect.closeTo(100, 6) });
    const lm = Array.from({ length: 21 }, () => ({ x: 640, y: 360 }));
    for (const i of [2, 3, 4]) lm[i] = { x: 700, y: 200 }; // up the picture = toward board +y (the top edge)
    for (const i of [17, 18, 19, 20]) lm[i] = { x: 700, y: 520 };
    expect(thumbSideOnBoard(K, pose, lm)).toBe("top");
    expect(thumbSideOnBoard(K, pose, lm.map((p) => ({ x: p.x, y: 720 - p.y })))).toBe("bottom");
    expect(thumbSideOnBoard(K, pose, null)).toBeNull();
  });
});
