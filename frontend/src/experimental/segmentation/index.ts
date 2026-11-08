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
// Stage 2a: board-independent hand analysis (part labels, finger gaps, confidence, boundary metrics, gates).
export { analyseHand, forearmSide, gate } from "./analyse";
export type { AnalyseOptions, GateCode, GateReason, HandAnalysis } from "./analyse";
export { FINGER_NAMES, PART, PART_NAMES, fingerPart, labelParts, measureFingers, skeletonSegments } from "./parts";
export type { EdgeKind, FingerName, FingerPart, PartLabels, PartName, WidthSample } from "./parts";
export { analyseFingerGaps } from "./fingerGaps";
export type { FingerGap, GapAnalysisResult, GapStatus, GapWidth } from "./fingerGaps";
export { fitColourGmm, pixelConfidence } from "./confidence";
export type { ColourGmm, ConfidenceResult, ConfidenceSummary } from "./confidence";
export { boundaryMetrics, compareToTruth, contourRoughness } from "./boundary";
export type { BoundaryMetrics, TruthComparison } from "./boundary";
// pngNode.ts (decodePng) is Node-only and deliberately not exported here.
