// EXPERIMENTAL dense surface-point scan: the computational core (pure TypeScript, no DOM). See README.md.
// A 2D sampling of the visible hand in one RGB frame; never a 3D scan unless real metric depth was applied.
export * from "./types";
export { edgeDistance, insideMask } from "./edt";
export { resolveSpacing, generateSurfacePoints, validatePoints, dedupeAndFilter } from "./points";
export { labelRegions, estimateRelativeDepth, applyMeasuredDepth, MIN_DEPTH_CONFIDENCE } from "./regions";
export { buildPointSet, buildPointCloud, countPoints, type BuildPointSetInput } from "./pointset";
export { meshFromLattice } from "./mesh";
export { measureFromPoints } from "./measure";
export { exportPointSet, POINTSET_SCHEMA } from "./export";
export { initialScanState, scanReducer, type ScanPhase, type ScanState, type ScanEvent, type ScanContext } from "./scan";
