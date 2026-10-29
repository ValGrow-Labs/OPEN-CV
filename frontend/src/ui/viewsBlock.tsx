// What the scan's capture views did: one line that matters (agree / differ / left out) and a table of
// each view. Agreement between two views is a cross-check on the scan, not a measure of accuracy.
import type { ScanResponse } from "../api/types";
import { fmtMm } from "./format";

export const VIEW_REASONS: Record<string, string> = {
  not_used_for_size: "not used for your size yet",
  view_dropped: "too few good frames",
  insufficient_frames: "too few good frames",
  scan_unstable: "the readings varied too much",
  fingers_bent: "fingers not straight enough",
};

export function viewReasonText(reason: string | null | undefined): string {
  return reason ? (VIEW_REASONS[reason] ?? reason.replace(/_/g, " ")) : "not enough usable frames";
}

/** The sentence about how the views relate, or null when there is only one view. */
/** A view that was captured but is not part of the size (the side view): never a "problem". */
export const isCaptureOnly = (v: { used: boolean; reason: string | null }) => !v.used && v.reason === "not_used_for_size";

export function viewsSummaryText(result: Pick<ScanResponse, "views" | "view_agreement">): { tone: "ok" | "warn"; text: string } | null {
  const views = result.views ?? [];
  const left = views.filter((v) => !v.used && !isCaptureOnly(v));
  if (left.length > 0 && views.some((v) => v.used)) {
    const names = left.map((v) => v.label).join(", ");
    return {
      tone: "warn",
      text: `${names} was not used (${viewReasonText(left[0].reason)}), so your result is based on the other view only.`,
    };
  }
  const a = result.view_agreement;
  if (!a) return null;
  if (a.agree) {
    const names = views.filter((v) => v.used).map((v) => v.label.toLowerCase());
    return { tone: "ok", text: `The ${names.join(" and ")} views agree within ${Math.max(1, Math.ceil(a.hand_length_diff_mm))} mm.` };
  }
  return {
    tone: "warn",
    text: `The views differ by ${Math.round(a.hand_length_diff_mm)} mm (more than ${Math.round(a.max_allowed_mm)} mm allowed): check the coin and rescan.`,
  };
}

export function ViewsNotice({ result }: { result: Pick<ScanResponse, "views" | "view_agreement"> }) {
  const s = viewsSummaryText(result);
  if (!s) return null;
  return (
    <div className={`notice small ${s.tone === "warn" ? "notice-demo" : "notice-info"}`} role="note">
      {s.text}
    </div>
  );
}

export function hasViews(result: Pick<ScanResponse, "views">): boolean {
  return (result.views ?? []).length > 1;
}

export function ViewsTable({ result }: { result: Pick<ScanResponse, "views" | "view_agreement"> }) {
  const views = result.views ?? [];
  if (views.length < 2) return null;
  return (
    <div className="views-table">
      <dl className="kv">
        {views.map((v) => (
          <ViewRow key={v.id} view={v} />
        ))}
      </dl>
      <p className="small muted">
        Agreement between views is a cross-check on this scan. It does not show how accurate the measurements are.
      </p>
    </div>
  );
}

function ViewRow({ view: v }: { view: NonNullable<ScanResponse["views"]>[number] }) {
  return (
    <>
      <dt>{v.label}</dt>
      <dd data-view={v.id}>
        {isCaptureOnly(v) ? (
          <>captured ({v.frames_received} frames), not used for your size yet</>
        ) : (
          <>
            {v.frames_accepted} of {v.frames_received} frames ·{" "}
            {v.used ? (
              <>used{v.hand_length_mm !== null && <>, hand length {fmtMm(v.hand_length_mm)}</>}</>
            ) : (
              <>not used ({viewReasonText(v.reason)})</>
            )}
          </>
        )}
      </dd>
    </>
  );
}
