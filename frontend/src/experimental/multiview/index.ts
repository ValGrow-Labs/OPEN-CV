// EXPERIMENTAL multi-view hand reconstruction on the printed board: known-board segmentation, landmark triangulation
// with a hand-moved check, board-frame carving and labelled measurements, plus a SIMULATED photo renderer for tests.
// Isolated from the customer flow; camera intrinsics and board poses are inputs. See README.md.
export * from "./image";
export * from "./landmarks";
export * from "./reconstruct";
export * from "./scene";
export * from "./segment";
