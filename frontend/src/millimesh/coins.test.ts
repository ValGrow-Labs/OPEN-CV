import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PublicConfig } from "../api/types";
import { publicConfig, publicConfigWithRealCoins } from "../test/fixtures";
import { initialCoinId, PICKER_DEFAULT, PICKER_ORDER, pickerCoins, selectionFor } from "./coins";

const file = JSON.parse(readFileSync(resolve(process.cwd(), "../config/reference_objects.json"), "utf-8")) as { default: string; objects: Record<string, unknown>[] };
const objects = publicConfigWithRealCoins().reference_objects.objects;
const realConfig = (): PublicConfig => publicConfigWithRealCoins();

describe("coin picker", () => {
  it("shows all seven coins in the owner's order", () => {
    const coins = pickerCoins(realConfig());
    expect(coins.map((c) => c.id)).toEqual([...PICKER_ORDER]);
    expect(coins.map((c) => c.face.name)).toEqual(["₹2 (2019)", "₹1 (2019)", "Quarter", "Nickel", "Dime", "Penny", "Rs 5 (2017)"]);
    expect(coins).toHaveLength(7);
  });

  it("shows the real diameters from the config", () => {
    const by = Object.fromEntries(pickerCoins(realConfig()).map((c) => [c.id, c.diameterText]));
    expect(by).toMatchObject({ inr_2_2019: "23.00 mm", us_quarter: "24.26 mm", us_nickel: "21.21 mm", us_dime: "17.91 mm", us_penny: "19.05 mm", lkr_5_2017: "23.50 mm" });
  });

  it("preselects the 2-rupee coin when nothing was chosen before", () => {
    expect(PICKER_DEFAULT).toBe("inr_2_2019");
    expect(initialCoinId(realConfig())).toBe("inr_2_2019");
    expect(initialCoinId(realConfig(), {})).toBe("inr_2_2019");
  });

  it("keeps the customer's earlier choice, but not one that can no longer be used", () => {
    expect(initialCoinId(realConfig(), { object_id: "us_dime" })).toBe("us_dime");
    expect(initialCoinId(realConfig(), { object_id: "no_such_coin" })).toBe("inr_2_2019");
    // the 1-rupee coin is pilot-only and the nickel is disabled in the config: shown, but never chosen for a customer
    expect(initialCoinId(realConfig(), { object_id: "inr_1_2019" })).toBe("inr_2_2019");
    expect(initialCoinId(realConfig(), { object_id: "us_nickel" })).toBe("inr_2_2019");
  });

  it("falls back to the configured default, then the first usable coin, when the 2-rupee coin is not offered", () => {
    const without = publicConfig({ reference_objects: { default: "us_quarter", objects: objects.filter((o) => o.id !== "inr_2_2019") } });
    expect(initialCoinId(without)).toBe("us_quarter");
    const only = publicConfig({ reference_objects: { default: "gone", objects: objects.filter((o) => o.id === "us_dime") } });
    expect(initialCoinId(only)).toBe("us_dime");
    expect(initialCoinId(publicConfig({ reference_objects: { default: "x", objects: [] } }))).toBeNull();
  });

  it("marks coins a customer cannot use (disabled or pilot only) as unavailable, as the server does", () => {
    const by = Object.fromEntries(pickerCoins(realConfig()).map((c) => [c.id, c]));
    expect(by.inr_1_2019.selectable).toBe(false);
    expect(by.inr_1_2019.unavailableReason).toMatch(/pilot/i);
    expect(by.us_nickel.selectable).toBe(false);
    expect(by.us_nickel.unavailableReason).toMatch(/not available/i);
    for (const id of ["inr_2_2019", "us_quarter", "us_dime", "us_penny", "lkr_5_2017"]) expect(by[id].selectable).toBe(true);
  });

  it("carries the size confirmation for coins that need one", () => {
    const by = Object.fromEntries(objects.map((o) => [o.id, o]));
    expect(selectionFor(by.us_quarter, false)).toEqual({ object_id: "us_quarter" });
    expect(selectionFor(by.inr_2_2019, true)).toEqual({ object_id: "inr_2_2019", size_checked: true });
    expect(selectionFor(by.inr_2_2019, false)).toEqual({ object_id: "inr_2_2019", size_checked: false });
  });
});

describe("config/reference_objects.json", () => {
  const by = Object.fromEntries(objects.map((o) => [o.id, o]));

  it("adds the US dime and penny with US Mint values, unvalidated, like the other US coins", () => {
    expect(by.us_dime).toMatchObject({ diameter_mm: 17.91, thickness_mm: 1.35, shape: "circle", enabled: true, availability: "all", size_check: false });
    expect(by.us_penny).toMatchObject({ diameter_mm: 19.05, thickness_mm: 1.52, shape: "circle", enabled: true, availability: "all", size_check: false });
    expect(String(by.us_dime.source)).toMatch(/Mint/);
    expect(String(by.us_penny.source)).toMatch(/copper/);
    expect(String(by.us_dime.notes)).toMatch(/not validated/i);
    expect(String(by.us_penny.notes)).toMatch(/not validated/i);
    // the same fields as the quarter, the closest US coin
    const raw = Object.fromEntries(file.objects.map((o) => [o.id as string, Object.keys(o).sort()]));
    expect(raw.us_dime).toEqual(raw.us_quarter);
    expect(raw.us_penny).toEqual(raw.us_quarter);
  });

  it("leaves the existing coins exactly as they were, the 2-rupee coin at 23.00 mm", () => {
    expect(by.inr_2_2019).toMatchObject({ diameter_mm: 23.0, diameter_uncertainty_mm: 0.1, size_check: true, availability: "all", enabled: true });
    expect(by.us_quarter).toMatchObject({ diameter_mm: 24.26, diameter_uncertainty_mm: 0.05, thickness_mm: 1.75 });
    expect(by.us_nickel).toMatchObject({ diameter_mm: 21.21, enabled: false });
    expect(by.inr_1_2019).toMatchObject({ diameter_mm: 20.0, availability: "pilot" });
    expect(by.lkr_5_2017).toMatchObject({ diameter_mm: 23.5, thickness_mm: 1.8 });
  });
});
