// @vitest-environment jsdom
// Where the 3D hand appears: the camera picture itself during the scan (a transparent 3D layer over the
// real hand), a large one while the measurements are calculated, and the customer's own hand on the result page. The scene itself is stubbed (jsdom has no WebGL).
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Measurement, Recommendation, ScanRequest, ScanResponse } from "../api/types";
import { goodFrame, publicConfig } from "../test/fixtures";

const webgl = { on: true, throwInStage: false };
const stages: Record<string, unknown>[] = [];

vi.mock("../hand3d/HandStage", () => ({
  webglAvailable: () => webgl.on,
  HandStage: (props: Record<string, unknown>) => {
    if (webgl.throwInStage && props.mode === "overlay") throw new Error("scene failed");
    stages.push(props);
    return <div role="img" aria-label={String(props.label)} data-mode={String(props.mode)} />;
  },
}));

type Opts = {
  onComplete: (frames: unknown[], timing: unknown) => void;
  onStatus: (s: unknown) => void;
  onPose?: (l: unknown, frame: { width: number; height: number }) => void;
  overlay3d?: boolean;
  maskCanvas?: HTMLCanvasElement | null;
};
const controllers: { opts: Opts; setOverlay3d: ReturnType<typeof vi.fn> }[] = [];

vi.mock("../scan/scanController", () => ({
  preloadScanTools: () => undefined,
  ScanController: class {
    startView = vi.fn();
    stop = vi.fn();
    resetCollection = vi.fn();
    releaseWakeLock = vi.fn();
    switchCamera = vi.fn();
    setOverlay3d = vi.fn();
    constructor(_v: unknown, _c: unknown, _cfg: unknown, public opts: Opts) {
      controllers.push({ opts, setOverlay3d: this.setOverlay3d });
    }
    async start() {
      this.opts.onStatus({ phase: "running", live: null, collected: 0, target: 10, coin: null, mirrored: true, fps: 0, timing: { handMs: 0, coinMs: 0 }, error: null, topIssue: null, tilt: { rawDeg: null, smoothedDeg: null }, exposureEv: null, liveMm: null, handedness: null });
    }
  },
}));

let finishSubmit: (v: unknown) => void = () => {};
const submitScan = vi.fn((_req: ScanRequest) => new Promise((resolve) => (finishSubmit = resolve)));
vi.mock("../api/client", async (orig) => ({
  ...(await orig<typeof import("../api/client")>()),
  submitScan: (req: ScanRequest) => submitScan(req),
  warmupService: () => undefined,
}));

import { ResultsScreen } from "./ResultsScreen";
import { ScanScreen } from "./ScanScreen";

const timing = { cameraStartupMs: 1, modelLoadMs: 1, firstLockMs: 1, collectionMs: 1, avgHandMs: 1, avgCoinMs: 1, totalScanMs: 1 };

function mountScan(config = publicConfig()) {
  return render(
    <ScanScreen
      config={config}
      chartId="demo-length-v1"
      reference={{ object_id: "us_quarter" }}
      onCancel={() => {}}
      onResult={() => {}}
      showIntro={false}
      requireCoinConfirm={false}
    />,
  );
}

beforeEach(() => {
  webgl.on = true;
  webgl.throwInStage = false;
  stages.length = 0;
  controllers.length = 0;
  submitScan.mockClear();
});
afterEach(cleanup);

describe("the live 3D measuring over the camera picture", () => {
  const liveMm = { handMm: 183.4, fingersMm: { thumb: 61.2, index: 72.4, middle: 79.6, ring: 73.1, little: 58.9 } };
  const running = (patch: object) =>
    act(() =>
      controllers.at(-1)!.opts.onStatus({ phase: "running", live: null, collected: 0, target: 10, coin: null, mirrored: true, fps: 0, timing: { handMs: 0, coinMs: 0 }, error: null, topIssue: null, tilt: { rawDeg: null, smoothedDeg: null }, exposureEv: null, liveMm: null, handedness: null, ...patch }),
    );

  it("is a full-size layer in the camera pane, not a small box", () => {
    const { container } = mountScan();
    const layer = container.querySelector(".stage > .scan-overlay3d");
    expect(layer).not.toBeNull();
    expect(layer!.getAttribute("aria-hidden")).toBe("true"); // decorative: the guidance is the text
    expect(container.querySelector(".scan-hand3d")).toBeNull(); // the small corner tile is gone
    const overlay = stages.find((p) => p.mode === "overlay")!;
    expect(overlay.mirror).toBe(true); // the camera picture is mirrored: the scene flips the hand itself
    expect(controllers.at(-1)!.opts.overlay3d).toBe(true); // the 2D outline and tags are not drawn twice
  });

  it("follows the pose and the frame size the controller reports, without re-rendering", () => {
    mountScan();
    const overlay = stages.find((p) => p.mode === "overlay")!;
    const poseRef = overlay.poseRef as { current: unknown };
    const frameRef = overlay.frameRef as { current: unknown };
    expect(poseRef.current).toBeNull();
    const pose = goodFrame().landmarks;
    act(() => controllers.at(-1)!.opts.onPose!(pose, { width: 1280, height: 720 }));
    expect(poseRef.current).toBe(pose);
    expect(frameRef.current).toEqual({ width: 1280, height: 720 });
    act(() => controllers.at(-1)!.opts.onPose!(null, { width: 720, height: 1280 })); // a phone turned
    expect(poseRef.current).toBeNull();
    expect(frameRef.current).toEqual({ width: 720, height: 1280 });
  });

  it("draws the live finger lengths and the hand length as labels once the coin is measured", () => {
    mountScan();
    expect(stages.at(-1)!.tags).toBeUndefined();
    running({ liveMm });
    const tags = stages.at(-1)!.tags as { joint: number; label: string; between?: number[]; emphasis?: boolean }[];
    expect(tags.map((t) => t.label)).toEqual(["61 mm", "72 mm", "80 mm", "73 mm", "59 mm", "183 mm"]);
    expect(tags.slice(0, 5).map((t) => t.joint)).toEqual([4, 8, 12, 16, 20]);
    expect(tags[5]).toMatchObject({ between: [0, 12], emphasis: true });
  });

  it("goes away while the measurements are calculated", async () => {
    const { container } = mountScan();
    await act(async () => controllers.at(-1)!.opts.onComplete([goodFrame()], timing));
    expect(container.querySelector(".scan-overlay3d")).toBeNull();
  });

  it("without WebGL there is no overlay and the 2D outline is kept", () => {
    webgl.on = false;
    const { container } = mountScan();
    expect(container.querySelector(".scan-overlay3d")).toBeNull();
    expect(controllers.at(-1)!.opts.overlay3d).toBe(false);
  });
});

describe("the 3D hand's black background and colour", () => {
  // The black is opt-in (shipped off): these tests are about the black, so they switch it on unless told otherwise.
  const withOverlay = (patch: object) => {
    const cfg = publicConfig();
    return { ...cfg, live_scan: { ...cfg.live_scan, overlay_3d: { ...cfg.live_scan.overlay_3d, focus_mask: true, ...patch } } };
  };
  const live = (ok: boolean, codes: string[] = []) =>
    act(() =>
      controllers.at(-1)!.opts.onStatus({ phase: "running", live: { ok, codes, message: "m" }, collected: 0, target: 10, coin: null, mirrored: false, fps: 30, timing: { handMs: 0, coinMs: 0 }, error: null, topIssue: null, tilt: { rawDeg: null, smoothedDeg: null }, exposureEv: null, liveMm: null, handedness: null }),
    );
  const overlay = () => stages.filter((p) => p.mode === "overlay").at(-1)!;

  it("gives the black a small canvas of its own between the video and the 2D drawing, with the video's CSS", () => {
    const { container } = mountScan(withOverlay({}) as never);
    const mask = container.querySelector<HTMLCanvasElement>(".stage canvas.focus-mask-canvas")!;
    expect(mask).not.toBeNull();
    expect(mask.getAttribute("aria-hidden")).toBe("true");
    expect(controllers.at(-1)!.opts.maskCanvas).toBe(mask); // the controller draws the black there
    const video = container.querySelector(".stage video")!;
    const draw2d = container.querySelector(".stage canvas:not(.focus-mask-canvas)")!;
    // video, then the black, then the 2D drawing (coin ring, pulse) over it
    expect(video.compareDocumentPosition(mask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mask.compareDocumentPosition(draw2d) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => controllers.at(-1)!.opts.onStatus({ phase: "running", live: null, collected: 0, target: 10, coin: null, mirrored: true, fps: 0, timing: { handMs: 0, coinMs: 0 }, error: null, topIssue: null, tilt: { rawDeg: null, smoothedDeg: null }, exposureEv: null, liveMm: null, handedness: null }));
    expect(mask.className).toContain("mirrored"); // flipped with the video for a front camera
    expect(draw2d.className).toContain("mirrored");
  });

  it("has no mask canvas when config turns the black off, the 3D layer off, or WebGL is missing", () => {
    for (const [cfg, gl] of [
      [withOverlay({ focus_mask: false }), true],
      [withOverlay({ enabled: false }), true],
      [publicConfig(), false],
    ] as const) {
      webgl.on = gl;
      const { container } = mountScan(cfg as never);
      expect(container.querySelector(".focus-mask-canvas")).toBeNull();
      expect(controllers.at(-1)!.opts.maskCanvas ?? null).toBeNull();
      cleanup();
    }
  });

  it("ships with the black off: the 3D hand sits over the whole picture", () => {
    const { container } = mountScan();
    expect(container.querySelector(".focus-mask-canvas")).toBeNull();
    expect(overlay().onBlack).toBe(false);
  });

  it("tells the scene the picture is blacked out, as config says", () => {
    cleanup();
    stages.length = 0;
    mountScan(withOverlay({}) as never);
    expect(overlay().onBlack).toBe(true);
    cleanup();
    stages.length = 0;
    mountScan(withOverlay({ focus_mask: false }) as never);
    expect(overlay().onBlack).toBe(false); // the 3D hand over the normal picture
  });

  it("is calm until a hand is tracked, pale blue while the pose needs fixing and green once it is fine", () => {
    mountScan(withOverlay({ tone_hold_ms: 0 }) as never);
    expect(overlay().tone).toBe("idle");
    live(false, ["no_hand"]); // nothing tracked
    expect(overlay().tone).toBe("idle");
    live(false, ["coin_tilted"]); // a hand, but the checks fail
    expect(overlay().tone).toBe("warn");
    live(true);
    expect(overlay().tone).toBe("ok");
    live(false, ["no_hand"]); // the hand is lost
    expect(overlay().tone).toBe("idle");
  });

  it("holds a colour for tone_hold_ms, so it does not flicker with the live checks", () => {
    let now = 1000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      mountScan(withOverlay({ tone_hold_ms: 300 }) as never);
      live(true);
      expect(overlay().tone).toBe("ok");
      now += 100;
      live(false, ["coin_tilted"]); // too soon to change
      expect(overlay().tone).toBe("ok");
      now += 150;
      live(false, ["coin_tilted"]);
      expect(overlay().tone).toBe("ok");
      now += 100; // 350 ms since the colour began
      live(false, ["coin_tilted"]);
      expect(overlay().tone).toBe("warn");
    } finally {
      clock.mockRestore();
    }
  });
});

describe("the 3D overlay never costs the customer the scan", () => {
  const withOverlay = (patch: object) => {
    const cfg = publicConfig();
    return { ...cfg, live_scan: { ...cfg.live_scan, overlay_3d: { ...cfg.live_scan.overlay_3d, ...patch } } };
  };
  const status = (fps: number) =>
    act(() =>
      controllers.at(-1)!.opts.onStatus({ phase: "running", live: null, collected: 0, target: 10, coin: null, mirrored: false, fps, timing: { handMs: 0, coinMs: 0 }, error: null, topIssue: null, tilt: { rawDeg: null, smoothedDeg: null }, exposureEv: null, liveMm: null, handedness: null }),
    );

  it("config can switch it off: no stage is mounted and the controller draws the 2D hand", () => {
    const { container } = mountScan(withOverlay({ enabled: false }));
    expect(container.querySelector(".scan-overlay3d")).toBeNull();
    expect(stages.some((p) => p.mode === "overlay")).toBe(false);
    expect(controllers.at(-1)!.opts.overlay3d).toBe(false);
  });

  it("passes the drawing budget from config to the scene", () => {
    mountScan(withOverlay({ max_frame_ms: 33, min_fps: 15 }));
    const overlay = stages.find((p) => p.mode === "overlay")!;
    expect(overlay.budget).toEqual({ maxFrameMs: 33, minFps: 15 });
  });

  it("when the scene gives up, the 2D hand takes over mid-scan: no restart, it stays that way, and the customer is told why", () => {
    const { container } = mountScan();
    const ctrl = controllers.at(-1)!;
    const overlay = stages.find((p) => p.mode === "overlay")!;
    expect(container.querySelector(".scan-overlay3d")).not.toBeNull();
    expect(container.querySelector(".scan-note")).toBeNull();
    act(() => (overlay.onDegrade as (r: string, d?: string) => void)("too_slow"));
    expect(ctrl.setOverlay3d).toHaveBeenCalledWith(false);
    expect(container.querySelector(".scan-overlay3d")).toBeNull();
    expect(container.querySelector(".scan-note")!.textContent).toMatch(/too busy to draw the 3D hand/);
    expect(container.querySelector(".scan-note")!.textContent).toMatch(/measuring is not affected/);
    expect(controllers).toHaveLength(1); // the scan was not restarted
    status(24); // later status updates do not bring it back
    expect(container.querySelector(".scan-overlay3d")).toBeNull();
  });

  it("says why in words for every reason the scene can give", () => {
    for (const [reason, detail, text] of [
      ["no_webgl", undefined, /needs WebGL/],
      ["context_lost", undefined, /graphics memory/],
      ["disabled", undefined, /switched off to keep the scan fast/],
      ["error", "shader compile failed", /could not start \(shader compile failed\)/],
    ] as const) {
      const { container } = mountScan();
      const overlay = stages.filter((p) => p.mode === "overlay").at(-1)!;
      act(() => (overlay.onDegrade as (r: string, d?: string) => void)(reason, detail));
      expect(container.querySelector(".scan-note")!.textContent).toMatch(text);
      cleanup();
      stages.length = 0;
    }
  });

  it("keeps the 3D layer while the scan loop itself runs slow: a busy phone is not the layer's fault", () => {
    const cfg = withOverlay({ min_fps: 12, fallback_after_slow_s: 3 });
    const now = vi.spyOn(performance, "now");
    try {
      now.mockReturnValue(1000);
      const { container } = mountScan(cfg);
      status(6); // slow from the start
      now.mockReturnValue(20_000);
      status(5);
      now.mockReturnValue(60_000);
      status(4);
      expect(controllers.at(-1)!.setOverlay3d).not.toHaveBeenCalledWith(false);
      expect(container.querySelector(".scan-overlay3d")).not.toBeNull();
      expect(container.querySelector(".scan-note")).toBeNull();
    } finally {
      now.mockRestore();
    }
  });

  it("a scene that throws while rendering falls back to 2D instead of a white screen", () => {
    webgl.throwInStage = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { container } = mountScan();
      expect(container.querySelector(".scan")).not.toBeNull(); // the scan screen is still there
      expect(container.querySelector(".scan-overlay3d")).toBeNull();
      expect(controllers.at(-1)!.setOverlay3d).toHaveBeenCalledWith(false);
    } finally {
      err.mockRestore();
      warn.mockRestore();
    }
  });
});

describe("the 3D hand while the measurements are calculated", () => {
  it("replaces the spinner when WebGL is available, and keeps the text", async () => {
    const { container } = mountScan();
    await act(async () => controllers.at(-1)!.opts.onComplete([goodFrame()], timing));
    expect(screen.getByText("Calculating your measurements…")).toBeTruthy();
    const calc = container.querySelector(".calc-hand3d")!;
    expect(calc.querySelector('[role="img"]')!.getAttribute("data-mode")).toBe("scan");
    expect(container.querySelector(".stage-message .spinner")).toBeNull();
    finishSubmit({ status: "accepted", frames_accepted: 1, frames_received: 1 });
  });

  it("falls back to the plain spinner without WebGL", async () => {
    webgl.on = false;
    const { container } = mountScan();
    await act(async () => controllers.at(-1)!.opts.onComplete([goodFrame()], timing));
    expect(container.querySelector(".calc-hand3d")).toBeNull();
    expect(container.querySelector(".stage-message .spinner")).not.toBeNull();
    expect(screen.getByText("Calculating your measurements…")).toBeTruthy();
    finishSubmit({ status: "accepted", frames_accepted: 1, frames_received: 1 });
  });
});

const rec: Recommendation = {
  status: "needs_more_data",
  size: null,
  alternative_size: null,
  confidence_level: "uncertain",
  chart_id: "demo-length-v1",
  manufacturer: null,
  product_model: null,
  is_demo_chart: true,
  disclaimer: "DEMO",
  basis: ["hand length"],
  explanation: ["x"],
  needed_measurements: ["hand_length_mm"],
  plausible_sizes: ["S", "M", "L"],
  by_measurement: [],
};

const finger = (key: string, value: number | null, status: Measurement["status"] = "valid"): Measurement => ({
  key,
  label: key,
  value_mm: value,
  uncertainty_mm: 3,
  interval95_mm: null,
  status,
  source: "camera_landmarks",
  method: "",
  definition: "",
  calibrated: false,
  frames_used: 10,
  uncertainty_components_mm: {},
  reasons: [],
});

const response = (over: Partial<ScanResponse> = {}): ScanResponse => ({
  status: "accepted",
  issues: [],
  calibration: null,
  measurements: [],
  proportions: {},
  frames_received: 24,
  frames_accepted: 24,
  frame_rejection_counts: {},
  landmarks_px_median: null,
  coin_median: null,
  image_width: 1280,
  image_height: 720,
  recommendation: rec,
  uncertainty_basis: "prior_assumptions",
  limitations: [],
  ...over,
});

const results = (result: ScanResponse) =>
  render(<ResultsScreen recommendation={rec} result={result} extraMeasurements={[]} onRescan={() => {}} onBack={() => {}} onStartOver={() => {}} />);

describe("the customer's hand on the result page", () => {
  it("shows the hand drawn from the measured points, labelled with the finger lengths that were measured", () => {
    const landmarks = goodFrame().landmarks;
    const { container } = results(
      response({
        landmarks_px_median: landmarks,
        measurements: [
          finger("index_length_mm", 71.6),
          finger("middle_length_mm", 78.2),
          finger("ring_length_mm", null, "invalid"), // not measured: no label
          finger("little_length_mm", 55, "not_measured"),
        ],
      }),
    );
    const card = container.querySelector(".rv2-stage")!;
    expect(card.querySelector('[role="img"]')!.getAttribute("data-mode")).toBe("static");
    expect(screen.getByText("An illustration drawn from the 21 hand points we measured, not a 3D scan.")).toBeTruthy();
    const p = stages.at(-1)!;
    expect(p.landmarks).toBe(landmarks);
    expect(p.theme).toBe("light"); // the result page's hand is drawn on the light stage
    expect(p.tags).toEqual([
      { joint: 8, label: "Index 72 mm" },
      { joint: 12, label: "Middle 78 mm" },
    ]);
  });

  it("is left out when there are no camera points (a tape-only result)", () => {
    const { container } = results(response({ status: "rejected", landmarks_px_median: null }));
    expect(container.querySelector(".rv2-stage")).toBeNull();
    expect(screen.queryByText(/not a 3D scan/)).toBeNull();
  });

  it("sits in the first card, above the suggested size, with the details after it", () => {
    const { container } = results(response({ landmarks_px_median: goodFrame().landmarks }));
    const hero = container.querySelector(".rv2-hero")!;
    const hand = hero.querySelector(".rv2-stage")!;
    const size = hero.querySelector(".rv2-size")!;
    expect(hand.compareDocumentPosition(size) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(hero.compareDocumentPosition(container.querySelector(".result-hero")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("labels the hand length between the points it is measured between, and only when measured", () => {
    results(
      response({
        landmarks_px_median: goodFrame().landmarks,
        measurements: [finger("hand_length_mm", 186.4), finger("mcp_span_mm", 80.2), finger("palm_breadth_mm", null, "not_measured")],
      }),
    );
    expect(stages.at(-1)!.tags).toEqual([
      { joint: 12, between: [0, 12], label: "Length 186 mm", emphasis: true },
    ]);
  });

  it("says which coin set the scale, and never claims more than a size estimate", () => {
    results(response({ landmarks_px_median: goodFrame().landmarks }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Hand measurement complete");
    expect(screen.getByText(/an estimate from a camera/i)).toBeTruthy();
    expect(screen.queryByText(/calibration: complete/i)).toBeNull();
  });
});
