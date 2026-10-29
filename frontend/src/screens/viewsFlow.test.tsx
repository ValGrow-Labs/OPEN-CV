// @vitest-environment jsdom
// The guided angles: palm -> back of hand -> side, one request at the end. The camera and the
// measuring tools are mocked: the controller is told when a view "completes".
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureView, ScanRequest } from "../api/types";
import { captureParams, goodFrame, publicConfig } from "../test/fixtures";

type Opts = { view?: CaptureView; onComplete: (frames: unknown[], timing: unknown) => void; onStatus: (s: unknown) => void };

const controllers: { opts: Opts; startView: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];

vi.mock("../scan/scanController", () => ({
  preloadScanTools: () => undefined,
  ScanController: class {
    startView = vi.fn();
    stop = vi.fn();
    resetCollection = vi.fn();
    releaseWakeLock = vi.fn();
    switchCamera = vi.fn();
    constructor(_v: unknown, _c: unknown, _cfg: unknown, public opts: Opts) {
      controllers.push({ opts, startView: this.startView, stop: this.stop });
    }
    async start() {
      this.opts.onStatus({ phase: "running", live: null, collected: 0, target: 10, coin: null, mirrored: false, fps: 0, timing: { handMs: 0, coinMs: 0 }, error: null, topIssue: null, tilt: { rawDeg: null, smoothedDeg: null }, exposureEv: null, liveMm: null, handedness: null });
    }
  },
}));

const submitScan = vi.fn();
vi.mock("../api/client", async (orig) => ({
  ...(await orig<typeof import("../api/client")>()),
  submitScan: (req: ScanRequest) => submitScan(req),
  warmupService: () => undefined,
}));

import { ScanScreen } from "./ScanScreen";

const timing = { cameraStartupMs: 1, modelLoadMs: 1, firstLockMs: 1, collectionMs: 1, avgHandMs: 1, avgCoinMs: 1, totalScanMs: 1 };
const frames = (n: number) => Array.from({ length: n }, () => goodFrame());

function mount(views?: CaptureView[], onResult = vi.fn()) {
  render(
    <ScanScreen
      config={publicConfig()}
      chartId="demo-length-v1"
      reference={{ object_id: "us_quarter" }}
      onCancel={() => {}}
      onResult={onResult}
      showIntro={false}
      requireCoinConfirm={false}
      views={views}
    />,
  );
  return onResult;
}

const complete = (n: number) => act(async () => controllers.at(-1)!.opts.onComplete(frames(n), timing));

beforeEach(() => {
  controllers.length = 0;
  submitScan.mockReset();
  submitScan.mockResolvedValue({ status: "accepted", frames_accepted: 20, frames_received: 20 });
});
afterEach(cleanup);

describe("single view (validation, pilot, anything that does not ask for views)", () => {
  it("submits at once, frames untagged, exactly as before", async () => {
    mount();
    expect(controllers).toHaveLength(1);
    expect(controllers[0].opts.view?.id).toBe("palm");
    await complete(10);
    expect(submitScan).toHaveBeenCalledTimes(1);
    const req = submitScan.mock.calls[0][0] as ScanRequest;
    expect(req.frames).toHaveLength(10);
    expect(req.frames.every((f) => f.view === undefined)).toBe(true);
    expect(screen.queryByText(/captured \(/)).toBeNull();
  });
});

describe("guided angles (back and side are required)", () => {
  const views = captureParams.views;

  it("after the palm it offers the back of the hand: one button, step 2 of 3, that view's own note, no skip", async () => {
    mount(views);
    await complete(10);
    expect(submitScan).not.toHaveBeenCalled();
    expect(screen.getByText("✓ Your palm captured (10 frames)")).toBeTruthy();
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "The back of your hand" })).toBeTruthy();
    expect(screen.getByText(/Rest the coin flat in the middle of the back of your hand/)).toBeTruthy();
    expect(screen.getByText("A second angle lets us check the first one.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Scan back of hand" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip, see my size" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/precis|accura/i);
  });

  it("never submits without the required views", async () => {
    mount(views);
    await complete(10);
    expect(submitScan).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Scan back of hand" })));
    await complete(12);
    expect(screen.getByText("Step 3 of 3")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip, see my size" })).toBeNull();
    expect(submitScan).not.toHaveBeenCalled();
  });

  it("scans the back with the camera still open, then the side view with its honest note", async () => {
    mount(views);
    await complete(10);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Scan back of hand" })));
    expect(controllers).toHaveLength(1); // the same controller: the camera was not reopened
    expect(controllers[0].startView).toHaveBeenCalledTimes(1);
    expect(controllers[0].startView.mock.calls[0][0].id).toBe("back");
    expect(screen.getByText("Back of hand · Measuring")).toBeTruthy();
    expect(screen.getByText("Show back of hand")).toBeTruthy(); // the first step chip

    await complete(12);
    expect(screen.getByText("✓ The back of your hand captured (12 frames)")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "The side of your hand" })).toBeTruthy();
    expect(screen.getByText("Not used for your size yet; we are testing how to use this angle.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Scan side view" })).toBeTruthy();
    expect(submitScan).not.toHaveBeenCalled();
  });

  it("after the last view everything goes out at once, tagged by view, with no image data", async () => {
    const onResult = mount(views);
    await complete(10);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Scan back of hand" })));
    await complete(12);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Scan side view" })));
    expect(controllers[0].startView.mock.calls[1][0].id).toBe("side");
    expect(screen.getByText("Side view · Measuring")).toBeTruthy();
    await complete(9);
    expect(submitScan).toHaveBeenCalledTimes(1);
    const req = submitScan.mock.calls[0][0] as ScanRequest;
    expect(req.frames.map((f) => f.view)).toEqual([...Array(10).fill("palm"), ...Array(12).fill("back"), ...Array(9).fill("side")]);
    expect(JSON.stringify(req)).not.toMatch(/data:image|base64/);
    expect(onResult).toHaveBeenCalledTimes(1);
  });
});

describe("optional views (the flow is config-driven)", () => {
  const optionalBack = captureParams.views.map((v) => ({ ...v, required: v.id === "palm" }));

  it("an optional next view gets 'Skip, see my size', which sends what was captured", async () => {
    mount(optionalBack);
    await complete(10);
    expect(screen.queryByText("Step 2 of 3")).toBeNull(); // step progress is for required views
    expect(screen.getByRole("button", { name: "Scan back of hand" })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Skip, see my size" })));
    expect(submitScan).toHaveBeenCalledTimes(1);
    const req = submitScan.mock.calls[0][0] as ScanRequest;
    expect(new Set(req.frames.map((f) => f.view))).toEqual(new Set(["palm"]));
  });

  it("skipping on the side card (all remaining optional) sends palm + back", async () => {
    mount(optionalBack);
    await complete(10);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Scan back of hand" })));
    await complete(12);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Skip, see my size" })));
    const req = submitScan.mock.calls[0][0] as ScanRequest;
    expect(req.frames.filter((f) => f.view === "palm")).toHaveLength(10);
    expect(req.frames.filter((f) => f.view === "back")).toHaveLength(12);
    expect(req.frames.some((f) => f.view === "side")).toBe(false);
  });

  it("an optional view after an optional one that a required one follows cannot be skipped", async () => {
    // back optional, side required: skipping the back card would skip the required side view too
    mount(captureParams.views.map((v) => ({ ...v, required: v.id !== "back" })));
    await complete(10);
    expect(screen.queryByRole("button", { name: "Skip, see my size" })).toBeNull();
  });
});

describe("a later required view that fails", () => {
  const timedOut = async () => {
    await act(async () => {
      controllers.at(-1)!.opts.onStatus({
        phase: "error",
        live: null,
        collected: 0,
        target: 10,
        coin: null,
        mirrored: false,
        fps: 0,
        timing: { handMs: 0, coinMs: 0 },
        error: { kind: "unknown", title: "Scan timed out", message: "No usable frames were captured.", canRetry: true },
        topIssue: null,
        tilt: { rawDeg: null, smoothedDeg: null },
        exposureEv: null,
        liveMm: null,
        handedness: null,
      });
    });
  };

  it("offers only 'Try again' and 'Back' (never a way to the size), and keeps the earlier view's frames", async () => {
    mount(captureParams.views);
    await complete(10);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Scan back of hand" })));
    await timedOut();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip, see my size" })).toBeNull();
    expect(submitScan).not.toHaveBeenCalled();

    // Trying again reopens the camera for the SAME view (the back), not the palm.
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
    expect(controllers).toHaveLength(2);
    expect(controllers[1].opts.view?.id).toBe("back");
  });

  it("an optional view that fails may be skipped, sending the earlier frames", async () => {
    mount(captureParams.views.map((v) => ({ ...v, required: v.id === "palm" })));
    await complete(10);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Scan back of hand" })));
    await timedOut();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Skip, see my size" })));
    const req = submitScan.mock.calls[0][0] as ScanRequest;
    expect(new Set(req.frames.map((f) => f.view))).toEqual(new Set(["palm"]));
  });
});

describe("the next-angle sheet (mobile first)", () => {
  const views = captureParams.views;
  const setVideoSize = (w: number, h: number) => {
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => w });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => h });
  };
  afterEach(() => setVideoSize(0, 0));

  it("is a sheet at the root of the scan screen, with step, title, instruction and note, and one primary button", async () => {
    mount(views);
    await complete(10);
    const sheet = document.querySelector(".scan > .view-sheet") as HTMLElement;
    expect(sheet).toBeTruthy(); // bottom-aligned at the root of the scan screen, not inside the camera stage
    expect(sheet.getAttribute("aria-label")).toBe("Next angle: The back of your hand");
    expect(sheet.querySelector(".view-sheet-step")!.textContent).toBe("Step 2 of 3");
    expect(sheet.querySelector("h2")!.textContent).toBe("The back of your hand");
    expect(sheet.querySelector(".view-sheet-text")!.textContent).toMatch(/Rest the coin flat in the middle of the back of your hand/);
    expect(sheet.querySelector(".view-sheet-note")!.textContent).toBe("A second angle lets us check the first one.");
    const buttons = [...sheet.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Scan back of hand"]);
    expect(buttons[0].className).toMatch(/btn-primary/);
    expect(buttons[0].className).toMatch(/btn-lg/); // the 56px+ thumb target (styles.css)
  });

  it("keeps the same structure on the side card, so the button does not move", async () => {
    mount(views);
    await complete(10);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Scan back of hand" })));
    await complete(12);
    const sheet = document.querySelector(".scan > .view-sheet") as HTMLElement;
    expect(sheet.querySelector(".view-sheet-step")!.textContent).toBe("Step 3 of 3");
    expect(sheet.querySelector(".view-sheet-note")!.textContent).toBe("Not used for your size yet; we are testing how to use this angle.");
    expect([...sheet.children].map((c) => c.className.split(" ")[0])).toEqual(["view-sheet-done", "view-sheet-body", "view-sheet-actions"]);
  });

  it("is gone once the next angle starts and once the scan is submitted", async () => {
    mount(views);
    await complete(10);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Scan back of hand" })));
    expect(document.querySelector(".view-sheet")).toBeNull();
  });

  it("tells the customer to hold the phone the same way up only when it was turned", async () => {
    setVideoSize(720, 1280); // the palm was captured portrait (frames are 720 x 1280)
    mount(views);
    await complete(10);
    const hint = () => document.querySelector(".view-sheet-turned") as HTMLElement;
    expect(hint().textContent).toBe("Keep your phone the same way up for every view");
    expect(hint().className).toMatch(/is-idle/); // the row is always there, so the sheet never jumps
    expect(hint().getAttribute("aria-hidden")).toBe("true");

    setVideoSize(1280, 720); // the phone is turned
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(hint().className).not.toMatch(/is-idle/);
    expect(hint().getAttribute("aria-hidden")).toBe("false");
  });

  it("shows the hint at once when the phone was already turned by the time the card appears", async () => {
    setVideoSize(1280, 720);
    mount(views);
    await complete(10);
    expect(document.querySelector(".view-sheet-turned")!.className).not.toMatch(/is-idle/);
  });
});
