// EXPERIMENTAL hand segmentation (see README.md). Public API.
export { segmentHand } from "./segmentHand";
export type { SegBackend, SegmentationOptions, SegmentationResult } from "./segmentHand";
export { createInteractiveSegmenter, INTERACTIVE_MODEL_PATH } from "./backends/interactive";
export { createStillHandDetector } from "./stillLandmarks";
export type { StillHands } from "./stillLandmarks";
export { boundaryDistance, contourArea, dice, iou, maskArea, maskToContour, polygonToMask, resizeMaskNearest, simplifyPolygon } from "./metrics";
export type { BoundaryDistance } from "./metrics";
export type { GapReport, Tip, WristCut } from "./fingers";
export type { QualityNumbers } from "./quality";
export type { ImageLike } from "./imageops";
export { toWorking } from "./imageops";
export * as thresholds from "./constants";
