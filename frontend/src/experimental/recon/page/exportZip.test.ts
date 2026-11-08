// The local export of the EXPERIMENTAL board reconstruction: what goes into the ZIP, and no photos unless asked.
import { describe, expect, it, vi } from "vitest";
import { readZip } from "../../capture/zip";
import { BOARD_VERSION } from "../../board/spec";
import { buildExportEntries, buildExportZip, meshPly, pointCloudCsv, type ExportInput } from "./exportZip";
import { flatnessOfCameras } from "../boardFlatness";
import { rulerCheck } from "./boardCheck";
import { DeviceLog } from "./deviceLog";
import { fakeCaptures, fakeOutcome } from "./testFixtures";

const coinEntry = { id: "inr_2_2019", label: "Indian 2-rupee coin, 2019 series (silver)", diameter_mm: 23, source: "config" };
const input = (patch: Partial<ExportInput> = {}): ExportInput => ({
  outcome: fakeOutcome({ accepted: false }),
  captures: fakeCaptures(),
  includePhotos: false,
  coin: coinEntry,
  coinLabel: coinEntry.label,
  createdAt: "2026-11-08T10:00:00.000Z",
  environment: { userAgent: "test", heapMb: null, page: "experiment/recon" },
  encodePhoto: vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
  ...patch,
});
const dec = new TextDecoder();
const env = { userAgent: "UA", screen: { width: 390, height: 844, devicePixelRatio: 3 }, deviceMemory: null, hardwareConcurrency: 8 };

describe("export", () => {
  it("has the JSON, the mesh, the point cloud and a README, and no photos by default", async () => {
    const inp = input();
    const zip = readZip(await buildExportZip(inp));
    expect(zip.map((e) => e.name)).toEqual(["README.txt", "reconstruction.json", "mesh.ply", "points.csv"]);
    expect(inp.encodePhoto).not.toHaveBeenCalled();
    const readme = dec.decode(zip[0].data);
    expect(readme).toContain("No photos are included (the box was not ticked).");
    expect(readme).toContain("EXPERIMENTAL");
    expect(readme).toMatch(/not been validated/);
  });

  it("adds the photos only when ticked", async () => {
    const inp = input({ includePhotos: true, device: () => new DeviceLog(() => 0, () => null).toJson(env, null) });
    const names = (await buildExportEntries(inp)).map((e) => e.name);
    expect(names.filter((n) => n.startsWith("photos/"))).toEqual(["photos/v01-top.png", "photos/v02-low-0.png", "photos/v03-low-1.png"]);
    expect(names.slice(0, 5)).toEqual(["README.txt", "reconstruction.json", "mesh.ply", "points.csv", "device.json"]);
    expect(inp.encodePhoto).toHaveBeenCalledTimes(3);
    await expect(buildExportEntries(input({ includePhotos: true, encodePhoto: undefined }))).rejects.toThrow(/encoder/);
  });

  it("records calibration, poses, views, measurements with basis, quality, reasons in words, timings, board and coin", async () => {
    const zip = readZip(await buildExportZip(input()));
    const j = JSON.parse(dec.decode(zip.find((e) => e.name === "reconstruction.json")!.data));
    expect(j.experimental).toBe(true);
    expect(j.board_version).toBe(BOARD_VERSION);
    expect(j.coin_entry_from_config).toEqual(coinEntry);
    expect(j.coin_print_scale_check).toMatchObject({ ok: true, scale_wrong: false, referenceDiameterMm: 23 });
    expect(j.calibration).toMatchObject({ method: "zhang", assumed: false, rms_px: 0.78, intrinsics: { fx: 1023.2 } });
    expect(j.views).toHaveLength(3);
    expect(j.views[0].camera.pose.R).toHaveLength(9);
    expect(j.views[0].mediapipe_landmarks_px).toHaveLength(21);
    expect(j.views[2].camera.rejected).toMatch(/only 2/);
    expect(j.views[1].hand_moved_check.disagrees).toBe(true);
    expect(j.reconstruction.accepted).toBe(false);
    expect(j.reconstruction.reasons.map((r: { code: string }) => r.code)).toEqual(["sides_not_observed", "views_disagree"]);
    expect(j.reconstruction.reasons[0].words).toMatch(/thickness is not bounded/);
    expect(j.reconstruction.measurements.handLength).toMatchObject({ value: 187.42, basis: "model" });
    expect(j.reconstruction.measurements.circumferenceKnuckle).toMatchObject({ value: 214.62, basis: "model" });
    expect(j.reconstruction.measurements.surfaceArea).toMatchObject({ value: null, basis: "none" });
    expect(j.reconstruction.mesh).toEqual({ vertices: 4, triangles: 4, file: "mesh.ply" });
    expect(j.timings_ms.chain).toMatchObject({ detect: 1500, calibrate: 700, reconstruct: 2500 });
    expect(j.photos_included).toBe(false);
    // the JSON carries no pixels
    expect(JSON.stringify(j)).not.toMatch(/"pixels"\s*:/);
    for (const v of j.views) expect(Object.keys(v)).not.toContain("thumb");
  });

  it("exports a refusal without a mesh", async () => {
    const zip = readZip(await buildExportZip(input({ outcome: fakeOutcome({ refused: true }) })));
    expect(zip.map((e) => e.name)).toEqual(["README.txt", "reconstruction.json"]);
    const j = JSON.parse(dec.decode(zip[1].data));
    expect(j.refused).toBe("camera_not_calibrated");
    expect(j.refusal_words).toMatch(/focal length could not be measured/);
    expect(j.reconstruction).toBeNull();
  });

  it("writes a PLY with confidence and support per vertex, and a CSV with labels", () => {
    const rec = fakeOutcome().chain.reconstruction!;
    const ply = meshPly(rec.mesh!, rec.confidence, rec.support, rec.supportLabels);
    const lines = ply.trim().split("\n");
    expect(lines).toContain("element vertex 4");
    expect(lines).toContain("property float confidence");
    expect(lines).toContain("property uchar support");
    expect(lines).toContain("element face 4");
    const body = lines.slice(lines.indexOf("end_header") + 1);
    expect(body[0]).toBe("0.000 0.000 0.000 0.000 2");
    expect(body[4]).toBe("3 0 2 1");
    expect(body).toHaveLength(8);
    const csv = pointCloudCsv(rec.pointCloud!.points, rec.pointCloud!.labels, rec.supportLabels).trim().split("\n");
    expect(csv[0]).toBe("x_mm,y_mm,z_mm,support");
    expect(csv[1]).toBe("0.000,0.000,0.000,support_plane");
    expect(csv).toHaveLength(5);
  });

  it("records the validation fields: run, board check (ruler, flatness, coin), marker residuals per view, hand frame and finger axes", async () => {
    const outcome = fakeOutcome({ frame: "triangulated" });
    const ruler = rulerCheck({ squareXmm: 30.1, squareYmm: 29.9, longSpanMm: 270.4, shortSpanMm: 70.1 });
    const j = JSON.parse(
      dec.decode(
        readZip(
          await buildExportZip(
            input({
              outcome,
              validationMode: true,
              run: { phantomId: "PH01", sessionId: "S1", captureIndex: 2, operatorCode: "OP01", conditions: ["baseline", "near"], notes: "test" },
              ruler,
              checklist: { matte: true, flat: true, noGlare: true },
              flatness: flatnessOfCameras(outcome.chain.cameras),
            }),
          ),
        ).find((e) => e.name === "reconstruction.json")!.data,
      ),
    );
    expect(j.validation_mode).toBe(true);
    expect(j.run).toEqual({ phantom_id: "PH01", session_id: "S1", capture_index: 2, operator_code: "OP01", conditions: ["baseline", "near"], notes: "test" });
    expect(j.board_check.ruler).toMatchObject({ square_x_mm: 30.1, square_y_mm: 29.9, long_span_mm: 270.4, short_span_mm: 70.1, expected: { square_mm: 30, long_span_mm: 270, short_span_mm: 70 }, verdict: "pass" });
    expect(j.board_check.ruler.reasons.length).toBeGreaterThan(0);
    expect(j.board_check.ruler.checklist).toEqual({ matte: true, flat: true, no_glare: true });
    // the fixture has only 2 views with a pose: the flatness says "not checked", never a silent pass
    expect(j.board_check.flatness).toMatchObject({ verdict: "not_checked", edge_vs_centre_ratio: null });
    expect(Object.keys(j.board_check.flatness)).toEqual(expect.arrayContaining(["verdict", "worst_marker_rms_px", "median_marker_rms_px", "edge_vs_centre_ratio", "reasons"]));
    expect(j.board_check.coin).toEqual(j.coin_print_scale_check); // the existing coin check, also kept where it was
    expect(j.board_check.valid_for_validation).toBe(false);
    expect(j.board_check.not_valid_reasons.join(" ")).toMatch(/flatness could not be checked/);
    expect(j.views[0].marker_residuals[0]).toEqual({ id: 0, rms_px: 0.3, used: true });
    expect(j.views[0].marker_residuals).toHaveLength(10);
    expect(j.views[2].marker_residuals).toEqual([]);
    expect(j.hand_frame).toEqual({ source: "triangulated", origin: [40, 105, 12], axis_x: [0, 1, 0], axis_y: [1, 0, 0], axis_z: [0, 0, 1], knuckle_y_mm: 95.5 });
    expect(j.finger_axes).toEqual([
      { name: "index", base: [135, 125, 10], dir: [1, 0.05, 0] },
      { name: "middle", base: [138, 106, 10], dir: [1, 0, 0] },
    ]);
  });

  it("names a hand frame lifted from one view, and writes nulls and no finger axes without a frame", async () => {
    const one = JSON.parse(dec.decode(readZip(await buildExportZip(input({ outcome: fakeOutcome({ frame: "one_view" }) }))).find((e) => e.name === "reconstruction.json")!.data));
    expect(one.hand_frame.source).toBe("one_view");
    const none = JSON.parse(dec.decode(readZip(await buildExportZip(input())).find((e) => e.name === "reconstruction.json")!.data));
    expect(none.hand_frame).toEqual({ source: null, origin: null, axis_x: null, axis_y: null, axis_z: null, knuckle_y_mm: null });
    expect(none.finger_axes).toEqual([]);
    // without validation details: the run is all nulls, the ruler "not entered", the capture not valid for validation
    expect(none.run).toEqual({ phantom_id: null, session_id: null, capture_index: null, operator_code: null, conditions: [], notes: "" });
    expect(none.board_check.ruler.verdict).toBe("not_entered");
    expect(none.board_check.valid_for_validation).toBe(false);
    const refused = JSON.parse(dec.decode(readZip(await buildExportZip(input({ outcome: fakeOutcome({ refused: true }) }))).find((e) => e.name === "reconstruction.json")!.data));
    expect(refused.hand_frame.source).toBeNull();
  });

  it("adds device.json with exactly the agreed fields, made after the other files (with their preparation time)", async () => {
    const log = new DeviceLog(() => 0, () => null, "2026-11-08T10:00:00.000Z");
    let seenMs = -1;
    const zip = readZip(
      await buildExportZip(
        input({
          device: (ms) => {
            seenMs = ms;
            return log.toJson(env, "2026-11-08T10:05:00.000Z", { export_ms: Math.round(ms), export_ok: true });
          },
        }),
      ),
    );
    expect(zip.map((e) => e.name)).toEqual(["README.txt", "reconstruction.json", "mesh.ply", "points.csv", "device.json"]);
    const d = JSON.parse(dec.decode(zip.find((e) => e.name === "device.json")!.data));
    expect(Object.keys(d)).toEqual(["user_agent", "screen", "device_memory_gb", "hardware_concurrency", "camera", "capture_ms", "build_ms", "export_ms", "heap_samples_mb", "peak_heap_mb", "errors", "webgl_context_lost", "export_ok", "started_at", "finished_at"]);
    expect(Object.keys(d.camera)).toEqual(["width", "height", "settings"]);
    expect(seenMs).toBeGreaterThanOrEqual(0);
    expect(d.export_ok).toBe(true);
    expect(dec.decode(zip[0].data)).toContain("device.json");
  });
});
