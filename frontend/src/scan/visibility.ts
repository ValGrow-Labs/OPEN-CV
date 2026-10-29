// What a running scan does when the page goes to the background (a call, another app, the screen
// locking) and comes back. Pure, so the rule is tested without a browser.
//
// While hidden the camera may be stopped by the phone and frames stop arriving, so the view being
// scanned is paused; the views already captured live outside the controller and are never touched.
// When the page is visible again that view starts its collection over (frames from before the
// interruption are not mixed with frames after it).

export type VisibilityAction = "pause" | "resume" | "none";

export function visibilityAction(state: { visible: boolean; running: boolean; pausedByHide: boolean }): VisibilityAction {
  if (!state.visible) return state.running ? "pause" : "none";
  return state.pausedByHide ? "resume" : "none";
}
