// The phantom-report command line, run against TEST FIXTURES in a temporary folder (never the repository's docs).
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { boxesMesh, fixtureCaptureZip } from "./__fixtures__/fixtures";
import { writeStlBinary } from "./meshIO";
import { parseArgs, PHYSICAL_DIR, runPhantomReport } from "./cli";

const fx = path.join(__dirname, "__fixtures__");
const tmp = mkdtempSync(path.join(os.tmpdir(), "phantom-report-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const env = { cwd: tmp, repoRoot: tmp, now: () => new Date("2026-11-08T12:00:00.000Z") };
const physical = path.join(tmp, PHYSICAL_DIR);

mkdirSync(path.join(tmp, "caps"));
writeFileSync(path.join(tmp, "caps", "c1.zip"), fixtureCaptureZip({ handLength: 181.3, palmWidth: 85.5, withFrame: true }, [{ name: "device.json", data: readFileSync(path.join(fx, "device-pixel.fixture.json")) }]));
writeFileSync(path.join(tmp, "caps", "c2.zip"), fixtureCaptureZip({ handLength: 179.3 }));
writeFileSync(path.join(tmp, "caps", "run2-device.json"), readFileSync(path.join(fx, "device-pixel-2.fixture.json")));
writeFileSync(path.join(tmp, "ref.json"), readFileSync(path.join(fx, "reference.fixture.json")));
// a NON-synthetic copy, only inside this temporary folder, to exercise the physical path end to end
const phys = JSON.parse(readFileSync(path.join(fx, "reference.fixture.json"), "utf8"));
phys.phantom.id = "tmp-test-only-phantom";
writeFileSync(path.join(tmp, "ref-nonsynthetic.json"), JSON.stringify(phys));
mkdirSync(path.join(tmp, "caps-phys"));
writeFileSync(path.join(tmp, "caps-phys", "p1.zip"), fixtureCaptureZip({ handLength: 181.3, phantom: "tmp-test-only-phantom" }));

describe("runPhantomReport", () => {
  it("parses arguments", () => {
    expect(parseArgs(["--reference", "r.json", "--captures", "c", "--mesh-kind", "scan", "--test"]).args).toMatchObject({ reference: "r.json", captures: "c", meshKind: "scan", test: true });
    expect(parseArgs(["--bogus"]).errors).toEqual(["unknown argument --bogus"]);
    expect(parseArgs(["--reference"]).errors).toEqual(["--reference needs a value"]);
  });

  it("writes nothing and says what is missing", async () => {
    const r = await runPhantomReport([], env);
    expect(r.code).toBe(2);
    expect(r.written).toEqual([]);
    expect(r.messages.join("\n")).toMatch(/no physical reference supplied[\s\S]*no capture exports supplied/);
    const r2 = await runPhantomReport(["--reference", "ref.json"], env);
    expect(r2.code).toBe(2);
    expect(existsSync(physical)).toBe(false);
  });

  it("refuses a synthetic reference without --test, and --test output into the physical folder", async () => {
    const r = await runPhantomReport(["--reference", "ref.json", "--captures", "caps"], env);
    expect(r.code).toBe(3);
    expect(r.messages[0]).toMatch(/starts with "synthetic"/);
    const r2 = await runPhantomReport(["--reference", "ref.json", "--captures", "caps", "--test"], env);
    expect(r2.code).toBe(3);
    expect(r2.messages[0]).toMatch(/real data only/);
    expect(existsSync(physical)).toBe(false);
  });

  it("--test with another folder writes a SYNTHETIC TEST report and its JSON", async () => {
    const r = await runPhantomReport(["--reference", "ref.json", "--captures", "caps", "--test", "--out", "out"], env);
    expect(r.code).toBe(0);
    expect(r.written.map((w) => path.basename(w))).toEqual([
      "SYNTHETIC-TEST-phantom-report-synthetic-fixture-block-A-2026-11-08T12-00-00-000Z.md",
      "SYNTHETIC-TEST-phantom-report-synthetic-fixture-block-A-2026-11-08T12-00-00-000Z.json",
    ]);
    const md = readFileSync(r.written[0], "utf8");
    expect(md).toMatch(/^# SYNTHETIC TEST: PHYSICAL PHANTOM VALIDATION/);
    expect(md).toContain("Android 14 FixturePhone 7 / Chrome 130"); // device.json in the ZIP and the loose one
    const j = JSON.parse(readFileSync(r.written[1], "utf8"));
    expect(j.devices.runs).toBe(2);
    expect(j.comparison.counts.accepted).toBe(2);
  });

  it("a non-synthetic reference goes to the physical folder by default", async () => {
    const r = await runPhantomReport(["--reference", "ref-nonsynthetic.json", "--captures", "caps-phys"], env);
    expect(r.code).toBe(0);
    expect(readdirSync(physical).sort()).toEqual(["phantom-report-tmp-test-only-phantom-2026-11-08T12-00-00-000Z.json", "phantom-report-tmp-test-only-phantom-2026-11-08T12-00-00-000Z.md"]);
    expect(readFileSync(r.written[0], "utf8")).toMatch(/^# PHYSICAL PHANTOM VALIDATION \(experimental/);
  });

  it("loads a reference from a JSON header plus a readings CSV", async () => {
    writeFileSync(path.join(tmp, "ref-header.json"), readFileSync(path.join(fx, "reference-header.fixture.json")));
    writeFileSync(path.join(tmp, "readings.fixture.csv"), readFileSync(path.join(fx, "readings.fixture.csv")));
    const r = await runPhantomReport(["--reference", "ref-header.json", "--captures", "caps", "--test", "--out", "out-csv"], env);
    expect(r.code).toBe(0);
    const j = JSON.parse(readFileSync(r.written[1], "utf8"));
    expect(j.reference.dimensions.map((d: { name: string }) => d.name)).toEqual(["palm_breadth", "palm_thickness"]);
  });

  it("adds the surface distance when a reference mesh and a fixed transform are given", async () => {
    mkdirSync(path.join(tmp, "caps-mesh"));
    writeFileSync(path.join(tmp, "caps-mesh", "m1.zip"), fixtureCaptureZip({ handLength: 181.3, palmWidth: 86, withFrame: true }));
    writeFileSync(path.join(tmp, "palm.stl"), writeStlBinary(boxesMesh([{ min: [0, 100, 0], max: [100, 185, 24] }], 2)));
    writeFileSync(path.join(tmp, "T.json"), JSON.stringify({ R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }));
    const r = await runPhantomReport(["--reference", "ref.json", "--captures", "caps-mesh", "--mesh", "palm.stl", "--transform", "T.json", "--test", "--out", "out-mesh"], env);
    expect(r.code).toBe(0);
    const j = JSON.parse(readFileSync(r.written[1], "utf8"));
    const s = j.surface_distance[0].result;
    expect(s.ok).toBe(true);
    expect(s.alignment.method).toBe("fixed");
    expect(s.meshToReference.signedMeanMm).toBeGreaterThan(0); // the capture's palm is 1 mm wider: outside
    expect(readFileSync(r.written[0], "utf8")).toContain("nominal CAD");
  });

  it("writes a blank template and never overwrites", async () => {
    const r = await runPhantomReport(["--write-template", "tpl/new.json"], env);
    expect(r.code).toBe(0);
    const tpl = JSON.parse(readFileSync(path.join(tmp, "tpl", "new.json"), "utf8"));
    expect(tpl.dimensions.length).toBeGreaterThan(20);
    expect((await runPhantomReport(["--write-template", "tpl/new.json"], env)).code).toBe(1);
  });
});
