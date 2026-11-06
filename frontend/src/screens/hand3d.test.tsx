// @vitest-environment jsdom
// Where the 3D hand appears: a small live tile during the scan, a large one while the measurements are
// calculated, and the customer's own hand on the result page. The scene itself is stubbed (jsdom has no WebGL).
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Measurement, Recommendation, ScanRequest, ScanResponse } from "../api/types";
import { goodFrame, publicConfig } from "../test/fixtures";

const webgl = { on: true };
const stages: Record<string, unknown>[] = [];

vi.mock("../hand3d/HandStage", () => ({
  webglAvailable: () => webgl.on,
  HandStage: (props: Record<string, unknown>) => {
    stages.push(props);
    return <div role="img" aria-label={String(props.label)} data-mode={String(props.mode)} />;
  },
}));

type Opts = { onComplete: (frames: unknown[], timing: unknown) => void; onStatus: (s: unknown) => void; onPose?: (l: unknown) => void };
const controllers: { opts: Opts }[] = [];

vi.mock("../scan/scanController", () => ({
  preloadScanTools: () => undefined,
  ScanController: class {
    startView = vi.fn();
    stop = vi.fn();
    resetCollection = vi.fn();
    releaseWakeLock = vi.fn();
    switchCamera = vi.fn();
    constructor(_v: unknown, _c: unknown, _cfg: unknown, public opts: Opts) {
      controllers.push({ opts });
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

function mountScan() {
  return render(
    <ScanScreen
      config={publicConfig()}
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
  stages.length = 0;
  controllers.length = 0;
  submitScan.mockClear();
});
afterEach(cleanup);

describe("the live 3D hand during the scan", () => {
  it("is a small tile in the camera area that follows the pose the controller reports", () => {
    const { container } = mountScan();
    const tile = container.querySelector(".scan-hand3d");
    expect(tile).not.toBeNull();
    expect(tile!.getAttribute("aria-hidden")).toBe("true"); // decorative: the guidance is the text
    const live = stages.find((p) => p.mode === "live")!;
    expect(live.mirror).toBe(true); // the camera picture is mirrored, so is the hand
    const poseRef = live.poseRef as { current: unknown };
    expect(poseRef.current).toBeNull();
    const pose = goodFrame().landmarks;
    act(() => controllers.at(-1)!.opts.onPose!(pose));
    expect(poseRef.current).toBe(pose); // no re-render needed: the scene reads the ref every frame
    act(() => controllers.at(-1)!.opts.onPose!(null));
    expect(poseRef.current).toBeNull();
  });

  it("goes away while the measurements are calculated", async () => {
    const { container } = mountScan();
    await act(async () => controllers.at(-1)!.opts.onComplete([goodFrame()], timing));
    expect(container.querySelector(".scan-hand3d")).toBeNull();
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
