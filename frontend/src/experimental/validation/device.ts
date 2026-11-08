// Device performance of the EXPERIMENTAL capture page, from the page's device.json files. It REPORTS what was measured
// on which device and browser (durations, heap, errors, context losses, export success). It produces NO compatibility
// verdict: a handful of runs on one phone says nothing about the model in general, and the thresholds for "works" are
// not this tool's to set. With no runs it says "no runs".
import { median } from "../reconstruction/stats";

export interface DeviceRun {
  source: string;
  userAgent: string | null;
  /** An operator-supplied device label, when the file carries one (overrides the user-agent guess). */
  deviceLabel: string | null;
  screen: unknown;
  deviceMemoryGb: number | null;
  hardwareConcurrency: number | null;
  camera: { width: number | null; height: number | null; settings: unknown } | null;
  captureMs: number | null;
  buildMs: number | null;
  exportMs: number | null;
  heapSamplesMb: number[];
  peakHeapMb: number | null;
  errors: string[];
  /** WebGL context losses in the run (the page writes a count; an older boolean is read as 0 or 1). */
  webglContextLosses: number | null;
  exportOk: boolean | null;
  startedAt: string | null;
  finishedAt: string | null;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const str = (x: unknown): string | null => (typeof x === "string" && x.trim() !== "" ? x : null);

export function parseDeviceJson(textIn: string, source: string): { run: DeviceRun | null; problems: string[] } {
  let j: unknown;
  try {
    j = JSON.parse(textIn);
  } catch (e) {
    return { run: null, problems: [`${source}: not valid JSON (${e instanceof Error ? e.message : String(e)})`] };
  }
  if (!isObj(j)) return { run: null, problems: [`${source}: not a JSON object`] };
  const cam = isObj(j.camera) ? j.camera : null;
  const heap = Array.isArray(j.heap_samples_mb) ? j.heap_samples_mb.filter((v): v is number => typeof v === "number" && Number.isFinite(v)) : [];
  return {
    run: {
      source,
      userAgent: str(j.user_agent),
      deviceLabel: str(j.device_label),
      screen: j.screen ?? null,
      deviceMemoryGb: num(j.device_memory_gb),
      hardwareConcurrency: num(j.hardware_concurrency),
      camera: cam ? { width: num(cam.width), height: num(cam.height), settings: cam.settings ?? null } : null,
      captureMs: num(j.capture_ms),
      buildMs: num(j.build_ms),
      exportMs: num(j.export_ms),
      heapSamplesMb: heap,
      peakHeapMb: num(j.peak_heap_mb) ?? (heap.length ? Math.max(...heap) : null),
      errors: Array.isArray(j.errors) ? j.errors.map(String) : [],
      webglContextLosses: typeof j.webgl_context_lost === "boolean" ? (j.webgl_context_lost ? 1 : 0) : num(j.webgl_context_lost),
      exportOk: typeof j.export_ok === "boolean" ? j.export_ok : null,
      startedAt: str(j.started_at),
      finishedAt: str(j.finished_at),
    },
    problems: [],
  };
}

/** Device and browser from a user-agent string (a best guess, printed as such); an operator label wins. */
export function deviceKey(run: Pick<DeviceRun, "userAgent" | "deviceLabel">): { device: string; browser: string; key: string } {
  const ua = run.userAgent ?? "";
  let device = run.deviceLabel ?? "";
  if (!device) {
    const paren = /\(([^)]*)\)/.exec(ua)?.[1] ?? "";
    const parts = paren.split(";").map((s) => s.trim()).filter((s) => s && s !== "Linux" && s !== "U" && s !== "K" && s !== "wv" && !/^[a-z]{2}(-[A-Z]{2})?$/.test(s));
    device = parts.join(" ") || "unknown device";
  }
  const m =
    /SamsungBrowser\/(\d+)/.exec(ua) ? `Samsung Internet ${/SamsungBrowser\/(\d+)/.exec(ua)![1]}` :
    /EdgA?\/(\d+)/.exec(ua) ? `Edge ${/EdgA?\/(\d+)/.exec(ua)![1]}` :
    /Firefox\/(\d+)/.exec(ua) ? `Firefox ${/Firefox\/(\d+)/.exec(ua)![1]}` :
    /CriOS\/(\d+)/.exec(ua) ? `Chrome iOS ${/CriOS\/(\d+)/.exec(ua)![1]}` :
    /Chrome\/(\d+)/.exec(ua) ? `Chrome ${/Chrome\/(\d+)/.exec(ua)![1]}` :
    /Version\/(\d+)[\d.]* .*Safari/.exec(ua) ? `Safari ${/Version\/(\d+)/.exec(ua)![1]}` :
    ua ? "unknown browser" : "no user agent"; // fmt: skip
  return { device, browser: m, key: `${device} / ${m}` };
}

export interface Durations {
  n: number;
  median: number | null;
  max: number | null;
}

const durations = (v: (number | null)[]): Durations => {
  const x = v.filter((a): a is number => a !== null);
  return { n: x.length, median: x.length ? median(x) : null, max: x.length ? Math.max(...x) : null };
};

export interface DeviceSummary {
  key: string;
  device: string;
  browser: string;
  runs: number;
  captureMs: Durations;
  buildMs: Durations;
  exportMs: Durations;
  peakHeapMb: Durations;
  /** Runs that recorded at least one error, and the distinct messages with their counts. */
  runsWithErrors: number;
  errors: { message: string; count: number }[];
  /** Sum of the context losses, and the runs that recorded the figure. */
  contextLosses: number;
  runsWithContextLoss: number;
  contextLossKnown: number;
  exportOk: number;
  exportKnown: number;
  /** exportOk / exportKnown, or null when no run recorded it. */
  exportSuccessRate: number | null;
  cameras: string[];
  hardwareConcurrency: number[];
  deviceMemoryGb: number[];
  sources: string[];
}

export interface DeviceReport {
  runs: number;
  devices: DeviceSummary[];
  /** "no runs" when nothing was supplied; never a verdict. */
  statement: string;
}

export function aggregateDevices(runs: readonly DeviceRun[]): DeviceReport {
  if (!runs.length) return { runs: 0, devices: [], statement: "no runs" };
  const groups = new Map<string, DeviceRun[]>();
  for (const r of runs) {
    const k = deviceKey(r).key;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const devices: DeviceSummary[] = [...groups.entries()].map(([key, rs]) => {
    const { device, browser } = deviceKey(rs[0]);
    const errCount = new Map<string, number>();
    for (const r of rs) for (const e of r.errors) errCount.set(e, (errCount.get(e) ?? 0) + 1);
    const lossKnown = rs.filter((r) => r.webglContextLosses !== null);
    const expKnown = rs.filter((r) => r.exportOk !== null);
    const uniq = <T,>(v: T[]) => [...new Set(v)];
    return {
      key,
      device,
      browser,
      runs: rs.length,
      captureMs: durations(rs.map((r) => r.captureMs)),
      buildMs: durations(rs.map((r) => r.buildMs)),
      exportMs: durations(rs.map((r) => r.exportMs)),
      peakHeapMb: durations(rs.map((r) => r.peakHeapMb)),
      runsWithErrors: rs.filter((r) => r.errors.length > 0).length,
      errors: [...errCount.entries()].map(([message, count]) => ({ message, count })).sort((a, b) => b.count - a.count),
      contextLosses: lossKnown.reduce((s, r) => s + (r.webglContextLosses ?? 0), 0),
      runsWithContextLoss: lossKnown.filter((r) => (r.webglContextLosses ?? 0) > 0).length,
      contextLossKnown: lossKnown.length,
      exportOk: expKnown.filter((r) => r.exportOk).length,
      exportKnown: expKnown.length,
      exportSuccessRate: expKnown.length ? expKnown.filter((r) => r.exportOk).length / expKnown.length : null,
      cameras: uniq(rs.flatMap((r) => (r.camera && r.camera.width !== null && r.camera.height !== null ? [`${r.camera.width}x${r.camera.height}`] : []))),
      hardwareConcurrency: uniq(rs.flatMap((r) => (r.hardwareConcurrency !== null ? [r.hardwareConcurrency] : []))),
      deviceMemoryGb: uniq(rs.flatMap((r) => (r.deviceMemoryGb !== null ? [r.deviceMemoryGb] : []))),
      sources: rs.map((r) => r.source),
    };
  });
  devices.sort((a, b) => a.key.localeCompare(b.key));
  return { runs: runs.length, devices, statement: `${runs.length} run(s) on ${devices.length} device/browser combination(s); measured values only, no compatibility verdict` };
}
