// EXPERIMENTAL multi-view hand reconstruction core: silhouette carving, isosurface meshing, point-cloud tools, a
// measurement engine, quality gates, validation statistics, a licence-clean parametric prior, a SYNTHETIC test hand and a
// mesh viewer. Isolated from the customer flow, the scan and the coin pipeline. Nothing here is validated against physical
// measurements; see README.md.
export * from "./carving";
export * from "./experiment";
export * from "./linalg";
export * from "./measure";
export * from "./meshing";
export { MeshViewer, DEFAULT_LABEL as MESH_VIEWER_DEFAULT_LABEL, type MeshViewerProps } from "./MeshViewer";
export * from "./pipeline";
export * from "./pointcloud";
export * from "./prior";
export * from "./quality";
export * from "./rng";
export * from "./stats";
export * from "./synthetic";
