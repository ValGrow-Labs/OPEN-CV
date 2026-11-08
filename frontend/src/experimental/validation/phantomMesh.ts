// A printable GEOMETRIC TEST PHANTOM from the synthetic capsule hand (EXPERIMENTAL): the capsule hand of
// reconstruction/synthetic.ts placed palm-down as in multiview/scene.ts, with a FLAT BASE at the palm plane (everything
// below the board plane z = 0 is cut off, so it rests on the board like the simulated hand) and the wrist stub cut square.
// The mesh is in the board frame (mm; base on z = 0, +z up), so its CAD can serve as the nominal reference mesh.
//
// Its design dimensions are a DESIGN, not reference values: a printed part differs from its CAD (print tolerance, shrink,
// warp, support marks). The validation report must use caliper readings of the printed part.
import type { Mesh } from "../common";
import { extractMesh, sdfToField } from "../reconstruction/meshing";
import { DEFAULT_HAND_PARAMS, type CapsuleHandParams } from "../reconstruction/synthetic";
import { makeBoardScene, type BoardScene, type HandPlacement } from "../multiview/scene";
import { capsuleExactDimensions } from "./meshDimensions";

export const DESIGN_NOTE =
  "DESIGN dimensions of the CAD, NOT reference values: measure the printed part with calipers (two measurers, a gauge-block check) and use those readings in the reference file.";

/** The solid of a board scene's hand above the board (z >= 0) and on the fingers' side of x = cutX, as a mesh. */
export function phantomMeshFromScene(scene: BoardScene, opts: { voxelMm?: number; cutX?: number } = {}): Mesh {
  const vox = opts.voxelMm ?? 0.5;
  const cutX = opts.cutX ?? -Infinity;
  const b = scene.handBoundsBoard;
  const pad = 2 * vox;
  const min: [number, number, number] = [Math.max(b.min[0], cutX) - pad, b.min[1] - pad, -pad];
  const max: [number, number, number] = [b.max[0] + pad, b.max[1] + pad, b.max[2] + pad];
  const sdf = (x: number, y: number, z: number) => Math.max(scene.sdfBoard(x, y, z), -z, cutX - x);
  return extractMesh(sdfToField(sdf, { min, max }, vox), 0);
}

export interface CapsulePhantom {
  mesh: Mesh;
  params: CapsuleHandParams;
  placement: HandPlacement;
  /** Board x of the square wrist cut. */
  cutX: number;
  /** Design values (mm) where an exact value exists; a design, not a reference. */
  design: Record<string, number>;
  notes: string[];
}

/** The printable phantom: the default capsule proportions, the wrist stub cut `wristStubMm` proximal to the wrist plane. */
export function capsulePhantom(opts: { params?: CapsuleHandParams; wristStubMm?: number; voxelMm?: number } = {}): CapsulePhantom {
  const params = opts.params ?? DEFAULT_HAND_PARAMS;
  const scene = makeBoardScene({ params, coin: null });
  const cutX = scene.placement.wristX - (opts.wristStubMm ?? 20);
  const mesh = phantomMeshFromScene(scene, { voxelMm: opts.voxelMm ?? 0.5, cutX });
  const t = scene.truth;
  const design: Record<string, number> = {
    ...capsuleExactDimensions(params),
    hand_length: t.handLength,
    palm_breadth: t.palmBreadth,
    palm_thickness: t.palmThickness,
    circumference_knuckle: t.circumference,
    ...Object.fromEntries((["index", "middle", "ring", "little"] as const).map((f) => [`finger_length_${f}`, t.fingerLengths[f]])),
  };
  return {
    mesh,
    params,
    placement: scene.placement,
    cutX,
    design,
    notes: [
      DESIGN_NOTE,
      "Frame: the printed board's frame with the default placement (wrist-plane centre at board x 25, y 122); base on z = 0, +z up; fingers toward +x.",
      `The wrist datum line is the wrist plane, board x = ${scene.placement.wristX} mm (mark it on the part); the knuckle datum is ${params.palmLength} mm distal of it (board x = ${scene.placement.wristX + params.palmLength}).`,
      "The capsule thumb is lifted toward the palm side, so the flat base cuts it; the thumb has no exact design width, height or gap.",
      "The fingers lie at mid-palm height, so they do not touch the board: a visual hull fills the space under them unless a view looks through it.",
    ],
  };
}
