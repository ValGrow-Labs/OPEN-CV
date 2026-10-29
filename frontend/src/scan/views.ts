// Helpers for the guided multi-angle scan (config capture.views): which views are scanned, tagging
// each view's frames, and the wording that depends on the view. Pure functions, so they can be tested
// without a camera.
import type { CaptureView, FrameObservation, PublicConfig } from "../api/types";

/** The views to scan: the ones asked for (customer flow), or just the primary one (everything else). */
export function viewsForScan(config: PublicConfig, requested?: CaptureView[]): CaptureView[] {
  if (requested && requested.length > 0) return requested;
  const primary = config.capture.views?.[0];
  return primary ? [primary] : [];
}

/** The view after `index`, or null when `index` is the last. */
export function nextView(views: CaptureView[], index: number): CaptureView | null {
  return views[index + 1] ?? null;
}

/** Whether the customer may skip straight to the size from `fromIndex` on: only when none of the
 *  views still to come is required (config capture.views[].required). */
export function canSkipRemaining(views: CaptureView[], fromIndex: number): boolean {
  return views.slice(fromIndex).every((v) => !v.required);
}

/** "Step 2 of 3" for the view at `index` (the progress through the guided angles). */
export function viewStepOf(views: CaptureView[], index: number): string {
  return `Step ${index + 1} of ${views.length}`;
}

export interface FrameSize {
  width: number;
  height: number;
}

export type Orientation = "portrait" | "landscape" | "square";

export const orientationOf = ({ width, height }: FrameSize): Orientation =>
  width === height ? "square" : height > width ? "portrait" : "landscape";

/** Whether the phone was turned between two views (portrait <-> landscape). Unknown sizes never count. */
export function orientationChanged(before: FrameSize | null | undefined, now: FrameSize | null | undefined): boolean {
  if (!before || !now || !before.width || !before.height || !now.width || !now.height) return false;
  const a = orientationOf(before);
  const b = orientationOf(now);
  return a !== "square" && b !== "square" && a !== b;
}

export const SAME_WAY_UP_HINT = "Keep your phone the same way up for every view";

/** Frames of one view, tagged with its id (the server groups a scan's frames by this). */
export function tagFrames(frames: FrameObservation[], viewId: string): FrameObservation[] {
  return frames.map((f) => ({ ...f, view: viewId }));
}

/** Everything collected so far with one view's frames replaced (a view scanned again replaces its old frames). */
export function withViewFrames(collected: FrameObservation[], viewId: string, tagged: FrameObservation[]): FrameObservation[] {
  return [...collected.filter((f) => f.view !== viewId), ...tagged];
}

/** The scan-step chip text: the primary view keeps the step's own wording ("Show palm"). */
export function viewStepLabel(view: CaptureView | undefined, primary: CaptureView | undefined, stepIndex: number, stepShort: string): string {
  if (stepIndex !== 0 || !view || !primary || view.id === primary.id) return stepShort;
  return `Show ${view.label.toLowerCase()}`;
}
