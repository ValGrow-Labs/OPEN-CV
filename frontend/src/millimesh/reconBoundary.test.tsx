// @vitest-environment jsdom
// The 3D step must never leave a blank stage: if the 3D view throws (a chunk that failed to load, a graphics error)
// the flat drawing takes its place.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReconBoundary } from "./ReconStep";

function Boom(): never {
  throw new Error("chunk failed to load");
}

afterEach(cleanup);

describe("ReconBoundary", () => {
  it("shows its children while they work", () => {
    render(
      <ReconBoundary fallback={<p>flat drawing</p>}>
        <p>3D view</p>
      </ReconBoundary>,
    );
    expect(screen.getByText("3D view")).toBeTruthy();
    expect(screen.queryByText("flat drawing")).toBeNull();
  });

  it("shows the fallback instead of a blank stage when the 3D view throws", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ReconBoundary fallback={<p>flat drawing</p>}>
        <Boom />
      </ReconBoundary>,
    );
    expect(screen.getByText("flat drawing")).toBeTruthy();
    err.mockRestore();
  });
});
