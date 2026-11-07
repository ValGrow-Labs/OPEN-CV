// GrabCut label codes (the values OpenCV uses) and the seed-size constants, re-exported from one place so the pure
// seed code does not need OpenCV loaded.
export const GRABCUT_LABELS = { BGD: 0, FGD: 1, PR_BGD: 2, PR_FGD: 3 } as const;
export { GRABCUT_ITERATIONS, PROBABLE_BG_GROW, PROBABLE_FG_GROW, SURE_FG_BONE_RADIUS, SURE_FG_PALM_ERODE } from "./constants";
