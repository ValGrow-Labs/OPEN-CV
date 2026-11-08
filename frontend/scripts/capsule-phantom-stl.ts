// EXPERIMENTAL: write an STL of the synthetic capsule hand with a FLAT base at the palm plane, for 3D printing a geometric
// test phantom whose CAD can serve as the nominal reference mesh. Its design values are a DESIGN, not reference values:
// the validation report must use caliper readings of the PRINTED part.
//   npx tsx scripts/capsule-phantom-stl.ts --out <file.stl> [--voxel 0.5] [--wrist-stub 20]
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { capsulePhantom } from "../src/experimental/validation/phantomMesh";
import { writeStlBinary } from "../src/experimental/validation/meshIO";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const out = opt("--out");
if (!out) {
  console.log("usage: npx tsx scripts/capsule-phantom-stl.ts --out <file.stl> [--voxel 0.5] [--wrist-stub 20]");
  process.exit(1);
}
const target = path.resolve(process.cwd(), out);
if (/validation[\\/]physical/.test(target)) {
  console.log("refused: the physical results folder holds real measurements only, not CAD designs");
  process.exit(3);
}
if (existsSync(target)) {
  console.log(`${target} exists; not overwritten`);
  process.exit(1);
}
const p = capsulePhantom({ voxelMm: Number(opt("--voxel") ?? 0.5), wristStubMm: Number(opt("--wrist-stub") ?? 20) });
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, writeStlBinary(p.mesh, "glovesize EXPERIMENTAL capsule test phantom (design, mm, board frame)"));
const designFile = target.replace(/\.stl$/i, "") + ".design.json";
await writeFile(designFile, JSON.stringify({ notice: "DESIGN VALUES, NOT REFERENCE VALUES", notes: p.notes, params: p.params, placement: p.placement, wrist_cut_board_x_mm: p.cutX, design_mm: p.design }, null, 2) + "\n");
console.log(`wrote ${target} (${p.mesh.indices.length / 3} triangles) and ${designFile}`);
for (const n of p.notes) console.log(`* ${n}`);
