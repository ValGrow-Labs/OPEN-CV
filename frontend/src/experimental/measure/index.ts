// EXPERIMENTAL measurement engine with numeric uncertainty (Stage 5). Not used by the customer app. See README.md.
export * from "./types";
export * from "./inputs";
export * from "./definitions";
export { fingerTips, fingerWidthAt, notObservedMask, offsetMesh, vertexNormals, type FingerTip, type Station, type WidthResult } from "./sections";
export { analyticComponents, camerasForScale, combine, ENGINE_LABEL, EXCLUDES, extractValues, measureWithUncertainty, meshCentroid, meshSensitivities, poseDisplacementMm, reportingIncrement, resolutionSummary, roundTo, step125Floor, withMonteCarlo, type BudgetContext, type EngineInput, type Sensitivities } from "./engine";
export { drawPerturbation, NO_PERTURBATION, runMonteCarlo, summarise, type McResult, type McStats, type Perturbation } from "./monteCarlo";
export { boardRouteRunner, boardValues, offsetMask, signedDistance, type BoardMcScene, type BoardMcView, type BoardRunnerOptions } from "./boardMc";
