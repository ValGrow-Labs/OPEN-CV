// Device performance aggregation on TEST FIXTURES (invented runs).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { aggregateDevices, deviceKey, parseDeviceJson } from "./device";

const read = (n: string) => parseDeviceJson(readFileSync(path.join(__dirname, "__fixtures__", n), "utf8"), n);

describe("device runs", () => {
  it("parses device.json and guesses the device and browser from the user agent", () => {
    const { run, problems } = read("device-pixel.fixture.json");
    expect(problems).toEqual([]);
    expect(run!.peakHeapMb).toBe(310);
    expect(deviceKey(run!)).toEqual({ device: "Android 14 FixturePhone 7", browser: "Chrome 130", key: "Android 14 FixturePhone 7 / Chrome 130" });
    expect(deviceKey({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", deviceLabel: null }).browser).toBe("Safari 17");
    expect(deviceKey({ userAgent: null, deviceLabel: "lab phone 3" }).key).toBe("lab phone 3 / no user agent");
    expect(parseDeviceJson("{", "x").problems[0]).toMatch(/not valid JSON/);
  });

  it("aggregates per device: durations, heap, errors, context losses, export success; no verdict", () => {
    const rep = aggregateDevices([read("device-pixel.fixture.json").run!, read("device-pixel-2.fixture.json").run!]);
    expect(rep.runs).toBe(2);
    expect(rep.devices).toHaveLength(1);
    const d = rep.devices[0];
    expect(d.captureMs).toEqual({ n: 2, median: 50000, max: 60000 });
    expect(d.exportMs).toEqual({ n: 1, median: 1000, max: 1000 }); // null is missing, not zero
    expect(d.peakHeapMb).toEqual({ n: 2, median: 355, max: 400 }); // second run: peak from its samples
    expect(d.errors).toEqual([{ message: "worker: out of memory", count: 1 }]);
    expect(d.contextLosses).toBe(1);
    expect(d.exportSuccessRate).toBe(0.5);
    expect(d.cameras).toEqual(["1280x720"]);
    expect(JSON.stringify(rep)).not.toMatch(/compatib(le|ility)"\s*:|verdict"\s*:/);
    expect(rep.statement).toMatch(/no compatibility verdict/);
  });

  it('says "no runs" when empty', () => {
    expect(aggregateDevices([])).toEqual({ runs: 0, devices: [], statement: "no runs" });
  });
});
