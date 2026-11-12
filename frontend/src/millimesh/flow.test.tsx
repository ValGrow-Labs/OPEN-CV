// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publicConfig, publicConfigWithRealCoins } from "../test/fixtures";
import { ESTIMATE_LABEL, fitHand } from "./fitHand";
import { MillimeshFlow } from "./MillimeshFlow";
import { PHASES, orderedViews, guidanceText } from "./phases";
import { ReconStep } from "./ReconStep";
import { CameraStep, CoinStep, StartStep } from "./steps";
import { COIN_MM, sweep } from "./testHands";

afterEach(cleanup);
beforeEach(() => window.localStorage.clear());

describe("1. Start", () => {
  it("shows the title, the promise and the start button, and says it is an unvalidated prototype", () => {
    const onStart = vi.fn();
    render(<StartStep config={publicConfig()} chartId="demo-length-v1" onChartChange={() => {}} onStart={onStart} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Surface Swarm");
    expect(screen.getByRole("img", { name: "MILLIMESH" })).toBeTruthy();
    expect(screen.getByText("Capture your hand in 3 views using a reference coin.")).toBeTruthy();
    expect(screen.getByText(/Unvalidated prototype/)).toBeTruthy();
    expect(screen.getByText(/not a guarantee of fit/)).toBeTruthy();
    expect(screen.getByText("Demo size chart.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Start Scan/ }));
    expect(onStart).toHaveBeenCalled();
  });

  it("keeps the product picker when there is more than one product", () => {
    const base = publicConfig();
    const config = publicConfig({ charts: [...base.charts, { ...base.charts[0], chart_id: "fitted", product_model: "Fitted Glove", measurements: ["hand_circumference_mm", "hand_length_mm"] }] });
    const onChartChange = vi.fn();
    render(<StartStep config={config} chartId="demo-length-v1" onChartChange={onChartChange} onStart={() => {}} />);
    fireEvent.change(screen.getByLabelText("Your product"), { target: { value: "fitted" } });
    expect(onChartChange).toHaveBeenCalledWith("fitted");
  });

  it("links to the operator screens", () => {
    render(<StartStep config={publicConfig({ validation_mode_enabled: true })} chartId="demo-length-v1" onChartChange={() => {}} onStart={() => {}} />);
    expect(screen.getByRole("link", { name: "Operator calibration" }).getAttribute("href")).toBe("#/calibration");
    expect(screen.getByRole("link", { name: "Validation" }).getAttribute("href")).toBe("#/validation");
  });
});

describe("2. Select a Reference Coin", () => {
  it("lists all seven coins with their diameters, the 2-rupee coin first and chosen", () => {
    render(<CoinStep config={publicConfigWithRealCoins()} previous={null} onContinue={() => {}} onBack={() => {}} />);
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(["inr_2_2019", "inr_1_2019", "us_quarter", "us_nickel", "us_dime", "us_penny", "lkr_5_2017"]);
    expect(radios[0].checked).toBe(true);
    expect(screen.getByText("23.00 mm")).toBeTruthy();
    expect(screen.getByText("17.91 mm")).toBeTruthy();
    expect(screen.getByText("19.05 mm")).toBeTruthy();
    expect(screen.getByText("24.26 mm")).toBeTruthy();
    expect(screen.getByText("21.21 mm")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Select a Reference Coin" })).toBeTruthy();
  });

  it("does not let a customer choose a coin the server refuses (pilot only, disabled)", () => {
    render(<CoinStep config={publicConfigWithRealCoins()} previous={null} onContinue={() => {}} onBack={() => {}} />);
    const by = Object.fromEntries((screen.getAllByRole("radio") as HTMLInputElement[]).map((r) => [r.value, r]));
    expect(by.inr_1_2019.disabled).toBe(true);
    expect(by.us_nickel.disabled).toBe(true);
    expect(by.us_dime.disabled).toBe(false);
  });

  it("asks the customer to confirm the 2-rupee coin's size before continuing, as the server requires", () => {
    const onContinue = vi.fn();
    render(<CoinStep config={publicConfigWithRealCoins()} previous={null} onContinue={onContinue} onBack={() => {}} />);
    const go = screen.getByRole("button", { name: /Continue/ }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    expect(onContinue).toHaveBeenCalledWith({ object_id: "inr_2_2019", size_checked: true });
  });

  it("a coin without a size check can continue at once", () => {
    const onContinue = vi.fn();
    render(<CoinStep config={publicConfigWithRealCoins()} previous={null} onContinue={onContinue} onBack={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: /Dime/ }));
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(onContinue).toHaveBeenCalledWith({ object_id: "us_dime" });
  });

  it("remembers this device's earlier choice", () => {
    render(<CoinStep config={publicConfigWithRealCoins()} previous={{ object_id: "us_penny" }} onContinue={() => {}} onBack={() => {}} />);
    expect((screen.getByRole("radio", { name: /Penny/ }) as HTMLInputElement).checked).toBe(true);
  });
});

describe("3. Allow Camera Access", () => {
  it("explains why, and offers Allow Camera and Not Now", () => {
    const onAllow = vi.fn();
    const onNotNow = vi.fn();
    render(<CameraStep onAllow={onAllow} onNotNow={onNotNow} />);
    expect(screen.getByRole("heading", { name: "Allow Camera Access" })).toBeTruthy();
    expect(screen.getByText("MilliMesh needs to use your camera to capture your hand and build your 3D model.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow Camera" }));
    fireEvent.click(screen.getByRole("button", { name: "Not Now" }));
    expect(onAllow).toHaveBeenCalled();
    expect(onNotNow).toHaveBeenCalled();
  });
});

describe("the phases", () => {
  it("word the three views as the design does", () => {
    expect(PHASES.palm.title).toBe("Palm Scan");
    expect(PHASES.palm.instruction).toBe("Slowly move your phone around your hand to capture the surface.");
    expect(PHASES.side.title).toBe("Side Scan");
    expect(PHASES.side.instruction).toBe("Tilt and move around the side of your hand.");
    expect(PHASES.back.title).toBe("Back Scan");
    expect(PHASES.back.instruction).toBe("Move around the back of your hand.");
  });

  it("scan the config's views in the order palm, side, back", () => {
    expect(orderedViews(publicConfig()).map((v) => v.id)).toEqual(["palm", "side", "back"]);
  });

  it("put the coin between the thumb and the index finger on the palm, and leave other guidance alone", () => {
    expect(guidanceText("coin_missing", "palm", "x")).toMatch(/between your thumb and index finger/);
    expect(guidanceText("coin_missing", "back", "Place the coin flat in the middle of the back of your hand")).toMatch(/back of your hand/);
    expect(guidanceText("coin_blurry", "palm", "Hold still, the image is blurry")).toBe("Hold still, the image is blurry");
  });
});

describe("the flow", () => {
  const flow = (extra: Partial<Parameters<typeof MillimeshFlow>[0]> = {}) =>
    render(
      <MillimeshFlow
        config={publicConfigWithRealCoins()}
        chartId="demo-length-v1"
        reference={{ object_id: "us_quarter" }}
        onChartChange={() => {}}
        onReferenceChange={() => {}}
        onResult={() => {}}
        onCancel={() => {}}
        {...extra}
      />,
    );

  it("goes start -> coin -> camera, saves the coin on the way, and Not Now returns to the start", () => {
    const onReferenceChange = vi.fn();
    flow({ onReferenceChange });
    fireEvent.click(screen.getByRole("button", { name: /Start Scan/ }));
    expect(screen.getByRole("heading", { name: "Select a Reference Coin" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Quarter/ }));
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(onReferenceChange).toHaveBeenCalledWith({ object_id: "us_quarter" });
    expect(screen.getByRole("heading", { name: "Allow Camera Access" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Not Now" }));
    expect(screen.getByText("Capture your hand in 3 views using a reference coin.")).toBeTruthy();
  });

  it("the capture screen says plainly when the camera is blocked, and Back returns to the camera step", async () => {
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    const getUserMedia = vi.fn(() => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })));
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
    flow({ initialStep: "start" });
    fireEvent.click(screen.getByRole("button", { name: /Start Scan/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Quarter/ }));
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Allow Camera" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Camera access is blocked")).toBeTruthy();
    // the three tabs and the first phase's card are there, at 0%
    expect(screen.getAllByRole("listitem").map((l) => l.textContent)).toEqual(["Palm", "Side", "Back"]);
    expect(screen.getByText("Palm Scan")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Palm Scan coverage" }).getAttribute("aria-valuenow")).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Allow Camera Access" })).toBeTruthy());
  });
});

describe("7. 3D Reconstruction", () => {
  const fit = fitHand({
    palm: sweep(30, [{}], { noiseM: 0.002 }),
    side: sweep(20, [{ yaw: 90 }], { coin: false }),
    back: sweep(30, [{}], { flip: 180 }),
    referenceDiameterMm: COIN_MM,
  })!;

  it("labels the model as an estimate, not a measured scan, and never calls the markers measured points", () => {
    render(<ReconStep fit={fit} onContinue={() => {}} onRescan={() => {}} />);
    expect(screen.getByRole("heading", { name: "3D Reconstruction" })).toBeTruthy();
    expect(screen.getByRole("note").textContent).toBe(ESTIMATE_LABEL);
    expect(screen.getByText(/not measured points/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/measured 3D scan|3D scan of your hand/i);
  });

  it("has the legend and the Solid / Wireframe / Point Cloud control", () => {
    render(<ReconStep fit={fit} onContinue={() => {}} onRescan={() => {}} />);
    for (const l of ["Palm Capture", "Side Capture", "Back Capture"]) expect(screen.getByText(l)).toBeTruthy();
    const modes = screen.getAllByRole("radio");
    expect(modes.map((m) => m.textContent)).toEqual(["Solid", "Wireframe", "Point Cloud"]);
    expect(modes[0].getAttribute("aria-checked")).toBe("true");
    fireEvent.click(modes[2]);
    expect(modes[2].getAttribute("aria-checked")).toBe("true");
    expect(modes[0].getAttribute("aria-checked")).toBe("false");
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowLeft" });
    expect(modes[1].getAttribute("aria-checked")).toBe("true");
  });

  it("goes on to the measurements, or scans again", () => {
    const onContinue = vi.fn();
    const onRescan = vi.fn();
    render(<ReconStep fit={fit} onContinue={onContinue} onRescan={onRescan} />);
    fireEvent.click(screen.getByRole("button", { name: /See my measurements/ }));
    fireEvent.click(screen.getByRole("button", { name: "Scan again" }));
    expect(onContinue).toHaveBeenCalled();
    expect(onRescan).toHaveBeenCalled();
  });

  it("shows the flat drawing and says so when the browser has no WebGL (as here)", () => {
    render(<ReconStep fit={fit} onContinue={() => {}} onRescan={() => {}} />);
    expect(screen.getByRole("img", { name: /flat drawing/ })).toBeTruthy();
    expect(screen.getByText(/cannot draw in 3D/)).toBeTruthy();
  });
});
