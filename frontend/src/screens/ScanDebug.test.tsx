// @vitest-environment jsdom
// The ?debug panel: camera, hand, coin, accepted frames, the 3D layer, WebGL errors and the real API connection.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanStatus } from "../scan/scanController";
import { ScanDebug, type ScanDebugProps } from "./ScanDebug";

const baseStatus = (patch: Partial<ScanStatus> = {}): ScanStatus =>
  ({
    phase: "running",
    live: { ok: false, codes: ["fingers_bent", "coin_not_found"], message: "Straighten your fingers" },
    collected: 3,
    target: 16,
    handedness: "right",
    coin: null,
    mirrored: false,
    fps: 24.4,
    timing: { handMs: 11.2, coinMs: 40.7 },
    error: null,
    topIssue: { code: "fingers_bent", message: "Straighten your fingers", share: 0.62 },
    tilt: { rawDeg: null, smoothedDeg: null },
    exposureEv: null,
    liveMm: null,
    ...patch,
  }) as ScanStatus;

const props = (patch: Partial<ScanDebugProps> = {}): ScanDebugProps => ({
  status: baseStatus(),
  video: null,
  overlay: { configured: true, webgl: true, on: true, note: null },
  viewerNote: null,
  reference: { label: "Indian 2-rupee coin", diameterMm: 23 },
  plausibleHandMm: [120, 260],
  ...patch,
});

const text = () => screen.getByRole("region", { name: "Diagnostics" }).textContent ?? "";

describe("the ?debug panel", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ status: "ok", version: "9.9" }), { status: 200 }))));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the camera, hand, coin, accepted frames and the 3D state, each on its own line", async () => {
    render(<ScanDebug {...props()} />);
    const t = text();
    expect(t).toMatch(/camera\s+running/);
    expect(t).toMatch(/hand\s+found · right/);
    expect(t).toMatch(/coin\s+not found/);
    expect(t).toMatch(/frames\s+accepted 3 \/ 16/);
    expect(t).toMatch(/checks\s+fingers_bent, coin_not_found/);
    expect(t).toMatch(/3d layer\s+on/);
    expect(t).toMatch(/3d card\s+ok/);
    expect(t).toMatch(/webgl\s+no errors seen/);
    expect(t).toMatch(/Indian 2-rupee coin 23\.00 mm/);
    await waitFor(() => expect(text()).toMatch(/api\s+OK HTTP 200 · \d+ ms · v9\.9/)); // the real request, same origin
  });

  it("reports a coin that was found but not accepted with its reasons, and an accepted coin with its size", () => {
    const base = { found: true, method: "hough", major_axis_px: 120.4, confidence: 0.91, glare_fraction: 0.02 };
    const { rerender } = render(<ScanDebug {...props({ status: baseStatus({ coin: { ...base, accepted: false, reasons: ["coin_tilted"] } as never }) })} />);
    expect(text()).toMatch(/found, not accepted \(coin_tilted\)/);
    rerender(<ScanDebug {...props({ status: baseStatus({ coin: { ...base, accepted: true, reasons: [] } as never }) })} />);
    expect(text()).toMatch(/coin\s+accepted · hough d=120\.4px conf=0\.91/);
  });

  it("says why the 3D layer is off: by config, no WebGL, or a reason", () => {
    const { rerender } = render(<ScanDebug {...props({ overlay: { configured: false, webgl: true, on: false, note: null } })} />);
    expect(text()).toMatch(/3d layer\s+switched off by config/);
    rerender(<ScanDebug {...props({ overlay: { configured: true, webgl: false, on: false, note: null }, viewerNote: "x" })} />);
    expect(text()).toMatch(/3d layer\s+no WebGL in this browser/);
    expect(text()).toMatch(/3d card\s+no WebGL in this browser/);
    rerender(<ScanDebug {...props({ overlay: { configured: true, webgl: true, on: false, note: "The browser took back the graphics memory" }, viewerNote: "3D view stopped" })} />);
    expect(text()).toMatch(/3d layer\s+off · The browser took back the graphics memory/);
    expect(text()).toMatch(/3d card\s+3D view stopped/);
  });

  it("lists WebGL context events and errors as they happen", () => {
    render(<ScanDebug {...props()} />);
    act(() => {
      window.dispatchEvent(new Event("webglcontextlost"));
    });
    expect(text()).toMatch(/webglcontextlost/);
    expect(text()).not.toMatch(/no errors seen/);
  });

  it("shows a failed API connection in words instead of hiding it", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    render(<ScanDebug {...props()} />);
    await waitFor(() => expect(text()).toMatch(/api\s+FAILED: TypeError: Failed to fetch/));
  });

  it("shows an address that answers but is not the sizing API", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("<html>", { status: 502 }))));
    render(<ScanDebug {...props()} />);
    await waitFor(() => expect(text()).toMatch(/api\s+ERROR HTTP 502/));
  });

  it("names a camera error", () => {
    render(<ScanDebug {...props({ status: baseStatus({ phase: "error", error: { title: "Camera access is blocked", message: "m", canRetry: true } as never }) })} />);
    expect(text()).toMatch(/camera\s+error · Camera access is blocked/);
  });
});
