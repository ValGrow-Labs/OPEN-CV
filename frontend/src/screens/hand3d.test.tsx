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

  it("when the scene gives up, the 2D hand takes over mid-scan: no restart, and it stays that way", () => {
    const { container } = mountScan();
    const ctrl = controllers.at(-1)!;
    const overlay = stages.find((p) => p.mode === "overlay")!;
    act(() => (overlay.onDegrade as (r: string) => void)("lighter")); // not a give-up: nothing changes
    expect(ctrl.setOverlay3d).not.toHaveBeenCalled();
    expect(container.querySelector(".scan-overlay3d")).not.toBeNull();
    act(() => (overlay.onDegrade as (r: string) => void)("disabled"));
    expect(ctrl.setOverlay3d).toHaveBeenCalledWith(false);
    expect(container.querySelector(".scan-overlay3d")).toBeNull();
    expect(controllers).toHaveLength(1); // the scan was not restarted
    status(24); // later status updates do not bring it back
    expect(container.querySelector(".scan-overlay3d")).toBeNull();
  });

  it("drops the 3D layer when the scan loop itself runs slow for long enough", () => {
    const cfg = withOverlay({ min_fps: 12, fallback_after_slow_s: 3 });
    const now = vi.spyOn(performance, "now");
    try {
      now.mockReturnValue(1000);
      const { container } = mountScan(cfg);
      status(20); // fast: fine
      status(6); // slow starts at t = 1000
      now.mockReturnValue(3000);
      status(6.5);
      expect(container.querySelector(".scan-overlay3d")).not.toBeNull(); // 2 s: not yet
      now.mockReturnValue(1000);
      status(20); // a good moment resets the clock
      now.mockReturnValue(5000);
      status(6);
      now.mockReturnValue(8100);
      status(6);
      expect(controllers.at(-1)!.setOverlay3d).toHaveBeenCalledWith(false);
      expect(container.querySelector(".scan-overlay3d")).toBeNull();
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
    const card = container.querySelector(".result-hand3d")!;
    expect(card.querySelector("h2")!.textContent).toBe("Your hand");
    expect(card.querySelector('[role="img"]')!.getAttribute("data-mode")).toBe("static");
    expect(screen.getByText("An illustration drawn from the 21 hand points we measured, not a 3D scan.")).toBeTruthy();
    const p = stages.at(-1)!;
    expect(p.landmarks).toBe(landmarks);
    expect(p.tags).toEqual([
      { joint: 8, label: "Index 72 mm" },
      { joint: 12, label: "Middle 78 mm" },
    ]);
  });

  it("is left out when there are no camera points (a tape-only result)", () => {
    const { container } = results(response({ status: "rejected", landmarks_px_median: null }));
    expect(container.querySelector(".result-hand3d")).toBeNull();
    expect(screen.queryByText(/not a 3D scan/)).toBeNull();
  });

  it("comes after the size, which still leads the page", () => {
    const { container } = results(response({ landmarks_px_median: goodFrame().landmarks }));
    const hero = container.querySelector(".result-hero")!;
    const hand = container.querySelector(".result-hand3d")!;
    expect(hero.compareDocumentPosition(hand) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
