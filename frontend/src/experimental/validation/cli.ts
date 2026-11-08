// The command line of the PHYSICAL PHANTOM validation report (EXPERIMENTAL). Node only (file system). The script
// frontend/scripts/phantom-report.ts is a thin wrapper around runPhantomReport, so this file is type-checked with src.
//
//   npx tsx scripts/phantom-report.ts --reference <ref.json> --captures <folder> [--mesh <ref.stl|.ply>] [--out <dir>]
//        [--mesh-kind cad|scan] [--transform <T.json>] [--refine] [--coverage-mm 2] [--test]
//   npx tsx scripts/phantom-report.ts --write-template <new-reference.json>
//
// With no reference, a refused reference or no captures it writes NOTHING and prints what is missing (exit code 2).
// A reference whose phantom id starts with "synthetic" is refused without --test (exit 3); with --test the files are
// named and titled SYNTHETIC TEST and may not be written into the physical results folder.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { compareCaptures } from "./compare";
import { aggregateDevices, parseDeviceJson, type DeviceRun } from "./device";
import { parseCaptureFiles, parseCaptureZip, type CaptureRecord } from "./exportModel";
import { parseMeshFile } from "./meshIO";
import { checkReference, referenceFromCsv, referenceTemplate, type ReferenceCheck, type ReferenceFile } from "./reference";
import { missingInputs, renderReport, SYNTHETIC_PREFIX } from "./report";
import { surfaceDistance, type RigidTransform, type SurfaceDistanceResult } from "./surfaceDistance";

export const PHYSICAL_DIR = path.join("docs", "hand3d-research", "validation", "physical");

export interface CliEnv {
  cwd: string;
  repoRoot: string;
  now?: () => Date;
}

export interface CliResult {
  code: number;
  messages: string[];
  written: string[];
}

export interface CliArgs {
  reference: string | null;
  captures: string | null;
  mesh: string | null;
  meshKind: "cad_nominal" | "scan";
  transform: string | null;
  refine: boolean;
  out: string | null;
  test: boolean;
  coverageMm: number;
  writeTemplate: string | null;
  help: boolean;
}

export const USAGE = [
  "phantom-report (EXPERIMENTAL physical phantom validation)",
  "  npx tsx scripts/phantom-report.ts --reference <ref.json> --captures <folder of export ZIPs> [--mesh <reference.stl|.ply>] [--out <dir>]",
  "      [--mesh-kind cad|scan] [--transform <reference-to-board.json>] [--refine] [--coverage-mm 2] [--test]",
  "  npx tsx scripts/phantom-report.ts --write-template <new-reference.json>",
  `Default output folder: ${PHYSICAL_DIR.replace(/\\/g, "/")}/ (real data only).`,
].join("\n");

export function parseArgs(argv: readonly string[]): { args: CliArgs; errors: string[] } {
  const args: CliArgs = { reference: null, captures: null, mesh: null, meshKind: "cad_nominal", transform: null, refine: false, out: null, test: false, coverageMm: 2, writeTemplate: null, help: false };
  const errors: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) {
        errors.push(`${a} needs a value`);
        return null;
      }
      return v;
    };
    if (a === "--reference") args.reference = val();
    else if (a === "--captures") args.captures = val();
    else if (a === "--mesh") args.mesh = val();
    else if (a === "--mesh-kind") {
      const v = val();
      if (v === "cad") args.meshKind = "cad_nominal";
      else if (v === "scan") args.meshKind = "scan";
      else if (v !== null) errors.push("--mesh-kind is cad or scan");
    } else if (a === "--transform") args.transform = val();
    else if (a === "--refine") args.refine = true;
    else if (a === "--out") args.out = val();
    else if (a === "--test") args.test = true;
    else if (a === "--coverage-mm") {
      const v = Number(val());
      if (Number.isFinite(v) && v > 0) args.coverageMm = v;
      else errors.push("--coverage-mm needs a positive number");
    } else if (a === "--write-template") args.writeTemplate = val();
    else if (a === "--help" || a === "-h") args.help = true;
    else errors.push(`unknown argument ${a}`);
  }
  return { args, errors };
}

const isInside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Load and check a reference file (JSON, optionally with a readings CSV next to it). */
export async function loadReference(file: string): Promise<ReferenceCheck> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    return { ok: false, reasons: [`${file}: cannot read the reference (${e instanceof Error ? e.message : String(e)})`], warnings: [], synthetic: false, reference: null };
  }
  if (raw && typeof raw === "object" && typeof (raw as ReferenceFile).readings_csv === "string") {
    const header = raw as ReferenceFile;
    if (header.dimensions !== undefined) return checkReference(raw); // the checker refuses "both"
    const csvPath = path.resolve(path.dirname(file), header.readings_csv!);
    let csv: string;
    try {
      csv = await readFile(csvPath, "utf8");
    } catch (e) {
      return { ok: false, reasons: [`readings CSV ${csvPath} cannot be read (${e instanceof Error ? e.message : String(e)})`], warnings: [], synthetic: false, reference: null };
    }
    const { reference, problems } = referenceFromCsv(header, csv);
    const check = checkReference(reference);
    if (problems.length) return { ...check, ok: false, reasons: [...problems, ...check.reasons], reference: null };
    return check;
  }
  return checkReference(raw);
}

/** Every capture in a folder: export ZIPs, extracted export folders (with reconstruction.json), and loose device JSON
 *  files (name containing "device"). */
export async function loadCaptures(dir: string): Promise<{ captures: CaptureRecord[]; devices: DeviceRun[]; files: number; problems: string[] }> {
  const captures: CaptureRecord[] = [];
  const devices: DeviceRun[] = [];
  const problems: string[] = [];
  let files = 0;
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && /\.zip$/i.test(e.name)) {
      files++;
      captures.push(parseCaptureZip(e.name, new Uint8Array(await readFile(full))));
    } else if (e.isDirectory() && existsSync(path.join(full, "reconstruction.json"))) {
      files++;
      const map = new Map<string, Uint8Array>();
      for (const n of ["reconstruction.json", "mesh.ply", "device.json"]) if (existsSync(path.join(full, n))) map.set(n, new Uint8Array(await readFile(path.join(full, n))));
      captures.push(parseCaptureFiles(`${e.name}/`, map));
    } else if (e.isFile() && /device.*\.json$/i.test(e.name)) {
      const d = parseDeviceJson(await readFile(full, "utf8"), e.name);
      if (d.run) devices.push(d.run);
      problems.push(...d.problems);
    }
  }
  for (const c of captures) if (c.device) devices.push(c.device);
  return { captures, devices, files, problems };
}

async function loadTransform(file: string): Promise<RigidTransform> {
  const j = JSON.parse(await readFile(file, "utf8")) as { R?: unknown; t?: unknown };
  const R = j.R, t = j.t;
  if (!Array.isArray(R) || R.length !== 9 || !R.every((x) => typeof x === "number") || !Array.isArray(t) || t.length !== 3 || !t.every((x) => typeof x === "number"))
    throw new Error(`${file}: a transform is {"R": [9 numbers, row-major], "t": [3 numbers]} mapping reference to board millimetres`);
  const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
  if (Math.abs(det - 1) > 1e-3) throw new Error(`${file}: R is not a rotation (determinant ${det.toFixed(4)})`);
  return { R: R as number[], t: t as [number, number, number] };
}

export async function runPhantomReport(argv: readonly string[], env: CliEnv): Promise<CliResult> {
  const messages: string[] = [];
  const written: string[] = [];
  const { args, errors } = parseArgs(argv);
  if (args.help) return { code: 0, messages: [USAGE], written };
  if (errors.length) return { code: 1, messages: [...errors, USAGE], written };
  const abs = (p: string) => path.resolve(env.cwd, p);
  const physical = path.join(env.repoRoot, PHYSICAL_DIR);

  if (args.writeTemplate) {
    const target = abs(args.writeTemplate);
    if (existsSync(target)) return { code: 1, messages: [`${target} exists; not overwritten`], written };
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(referenceTemplate(), null, 2) + "\n", "utf8");
    return { code: 0, messages: [`wrote a blank reference template to ${target} (the checker refuses it until real readings are entered)`], written: [target] };
  }

  const outDir = args.out ? abs(args.out) : physical;
  if (args.test && isInside(outDir, physical)) return { code: 3, messages: [`--test output may not go into ${physical} (real data only); pass --out <another folder>`], written };

  const referenceCheck = args.reference ? await loadReference(abs(args.reference)) : null;
  let captures: CaptureRecord[] = [];
  let devices: DeviceRun[] = [];
  let files = 0;
  if (args.captures) {
    const dir = abs(args.captures);
    if (!existsSync(dir) || !(await stat(dir)).isDirectory()) messages.push(`captures folder ${dir} does not exist`);
    else {
      const loaded = await loadCaptures(dir);
      captures = loaded.captures;
      devices = loaded.devices;
      files = loaded.files;
      messages.push(...loaded.problems);
    }
  }
  const missing = missingInputs({ referenceCheck, comparison: null, captureFiles: files });
  if (missing.length) return { code: 2, messages: [...messages, "Nothing written. Missing:", ...missing.map((m) => `  * ${m}`)], written };
  const reference = referenceCheck!.reference!;
  if (reference.synthetic && !args.test)
    return { code: 3, messages: [`refused: the reference's phantom id "${reference.phantomId}" starts with "synthetic"; a synthetic reference never produces a physical report (use --test and --out outside ${physical})`], written };

  const comparison = compareCaptures(captures, reference);
  let surfaces: { capture: string; result: SurfaceDistanceResult }[] | null = null;
  if (args.mesh) {
    const meshPath = abs(args.mesh);
    const parsed = parseMeshFile(new Uint8Array(await readFile(meshPath)), meshPath);
    const transform = args.transform ? await loadTransform(abs(args.transform)) : null;
    surfaces = [];
    for (const c of captures) {
      const s = comparison.captures.find((x) => x.name === c.name);
      if (s?.status !== "accepted" || !c.mesh) continue;
      surfaces.push({
        capture: c.name,
        result: surfaceDistance({
          reconstruction: c.mesh,
          reference: parsed.mesh,
          referenceKind: args.meshKind,
          transform,
          refine: args.refine,
          coverageMm: args.coverageMm,
        }),
      });
    }
  }
  const now = (env.now ?? (() => new Date()))();
  const rendered = renderReport({
    referenceCheck,
    referenceSource: args.reference,
    capturesSource: args.captures,
    captureFiles: files,
    comparison,
    surfaces,
    surfaceSource: args.mesh,
    devices: aggregateDevices(devices),
    test: args.test,
    generatedAt: now.toISOString(),
    command: ["npx tsx scripts/phantom-report.ts", ...argv].join(" "),
  });
  await mkdir(outDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const safeId = reference.phantomId.replace(/[^A-Za-z0-9_-]+/g, "_");
  const base = `${args.test ? `${SYNTHETIC_PREFIX.replace(/ /g, "-")}-` : ""}phantom-report-${safeId}-${stamp}`;
  const md = path.join(outDir, `${base}.md`), js = path.join(outDir, `${base}.json`);
  await writeFile(md, rendered.markdown, "utf8");
  await writeFile(js, JSON.stringify(rendered.json, null, 2) + "\n", "utf8");
  written.push(md, js);
  messages.push(`${comparison.counts.total} capture(s): ${comparison.counts.accepted} accepted, ${comparison.counts.rejected} rejected, ${comparison.counts.refused} refused, ${comparison.counts.unreadable} unreadable, ${comparison.counts.excluded} excluded.`);
  messages.push(`wrote ${md}`, `wrote ${js}`);
  return { code: 0, messages, written };
}
