// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publicConfig } from "../test/fixtures";
import { coachKind, liveStage } from "../ui/guide";
import { introSeen } from "../ui/settings";
import { ScanScreen } from "./ScanScreen";
import { WelcomeScreen } from "./WelcomeScreen";

afterEach(cleanup);

describe("live guidance mapping", () => {
  it("maps live codes to the guide step", () => {
    expect(liveStage(["no_hand"])).toBe(0);
    expect(liveStage(["fingers_bent", "coin_missing"])).toBe(0);
    expect(liveStage(["coin_missing"])).toBe(1);
    expect(liveStage(["coin_glare"])).toBe(1);
    expect(liveStage(["hold_still"])).toBe(2);
    expect(liveStage(["coin_blurry"])).toBe(2);
    expect(liveStage([])).toBe(2);
  });

  it("picks an illustrative coaching icon", () => {
    expect(coachKind("hand_too_small")).toBe("closer");
    expect(coachKind("hand_out_of_frame")).toBe("frame");
    expect(coachKind("coin_not_on_palm")).toBe("coin");
    expect(coachKind("too_dark")).toBe("light");
    expect(coachKind("hold_still")).toBe("still");
    expect(coachKind("palm_not_flat")).toBe("palm");
    expect(coachKind(undefined)).toBe("ok");
  });
});

describe("pre-scan quick guide", () => {
  let getUserMedia: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    window.localStorage.clear();
    getUserMedia = vi.fn(() => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })));
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  });

  const renderScan = () =>
    render(<ScanScreen config={publicConfig()} chartId="demo-length-v1" reference={{ object_id: "us_quarter" }} onCancel={() => {}} onResult={() => {}} requireCoinConfirm={false} />);

  it("explains the steps before asking for the camera", async () => {
    renderScan();
    expect(screen.getByRole("dialog", { name: "Before you start" })).toBeTruthy();
    expect(getUserMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: /Open your palm/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: /Place the coin/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/ask for camera access/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Start camera/ }));
    expect(await screen.findByRole("alert")).toBeTruthy(); // camera now requested (and denied in this test)
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(introSeen()).toBe(true);
  });

  it("can be skipped and is not shown again", async () => {
    renderScan();
    fireEvent.click(screen.getByRole("button", { name: "Skip guide" }));
    await screen.findByRole("alert");
    cleanup();
    renderScan();
    expect(screen.queryByRole("dialog", { name: "Before you start" })).toBeNull();
  });

  it("supports keyboard navigation", () => {
    renderScan();
    const dialog = screen.getByRole("dialog", { name: "Before you start" });
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(screen.getByRole("heading", { name: /Open your palm/ })).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    expect(screen.getByRole("heading", { name: "Before you start" })).toBeTruthy();
  });
});

describe("welcome walkthrough", () => {
  it("lets the visitor step through how it works", () => {
    render(
      <WelcomeScreen
        config={publicConfig()}
        chartId="demo-length-v1"
        reference={{ object_id: "us_quarter" }}
        onChartChange={() => {}}
        onReferenceChange={() => {}}
        onStart={() => {}}
      />,
    );
    const steps = screen.getAllByRole("button", { name: /Open your palm|Place the coin|Hold still/ });
    expect(steps).toHaveLength(3);
    fireEvent.click(steps[1]);
    expect(steps[1].getAttribute("aria-current")).toBe("step");
    expect(screen.getByText("A US quarter (24.26 mm) gives the scale.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play demo" })).toBeTruthy(); // autoplay stopped by the click
  });
});

describe("product picker", () => {
  it("shows each product as a selectable option with its sizing basis", () => {
    const onChartChange = vi.fn();
    const base = publicConfig();
    const config = publicConfig({
      charts: [
        ...base.charts,
        { ...base.charts[0], chart_id: "fitted", product_model: "Fitted Glove", measurements: ["hand_circumference_mm", "hand_length_mm"] },
      ],
    });
    render(
      <WelcomeScreen config={config} chartId="demo-length-v1" reference={{ object_id: "us_quarter" }} onChartChange={onChartChange} onReferenceChange={() => {}} onStart={() => {}} />,
    );
    const options = screen.getAllByRole("radio");
    expect(options).toHaveLength(2);
    expect((options[0] as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Sized by hand circumference and hand length")).toBeTruthy();
    fireEvent.click(screen.getByText("Fitted Glove"));
    expect(onChartChange).toHaveBeenCalledWith("fitted");
    expect(screen.getByText("Demo size chart")).toBeTruthy();
  });
});
