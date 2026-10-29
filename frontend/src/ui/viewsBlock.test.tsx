// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ViewSummary } from "../api/types";
import { COMPONENTS } from "./format";
import { hasViews, isCaptureOnly, ViewsNotice, ViewsTable, viewsSummaryText } from "./viewsBlock";

afterEach(cleanup);

const palm: ViewSummary = { id: "palm", label: "Palm", frames_received: 10, frames_accepted: 10, used: true, hand_length_mm: 181.2, reason: null };
const back: ViewSummary = { id: "back", label: "Back of hand", frames_received: 12, frames_accepted: 11, used: true, hand_length_mm: 179.4, reason: null };
const side: ViewSummary = { id: "side", label: "Side view", frames_received: 9, frames_accepted: 0, used: false, hand_length_mm: null, reason: "not_used_for_size" };
const agree = { hand_length_diff_mm: 1.8, max_allowed_mm: 10.9, agree: true };

describe("views block", () => {
  it("says the views agree (rounded up to a whole mm) without claiming accuracy", () => {
    const r = { views: [palm, back], view_agreement: agree };
    expect(viewsSummaryText(r)).toEqual({ tone: "ok", text: "The palm and back of hand views agree within 2 mm." });
    render(<ViewsNotice result={r} />);
    expect(screen.getByRole("note").textContent).toBe("The palm and back of hand views agree within 2 mm.");
    expect(document.body.textContent).not.toMatch(/precis|accura/i);
  });

  it("warns when the views differ, with the numbers", () => {
    const r = { views: [palm, back], view_agreement: { hand_length_diff_mm: 14.2, max_allowed_mm: 10.9, agree: false } };
    expect(viewsSummaryText(r)).toEqual({
      tone: "warn",
      text: "The views differ by 14 mm (more than 11 mm allowed): check the coin and rescan.",
    });
  });

  it("says when an extra view was not used and the result rests on the other one", () => {
    const dropped: ViewSummary = { ...back, frames_accepted: 3, used: false, hand_length_mm: null, reason: "view_dropped" };
    const r = { views: [palm, dropped], view_agreement: null };
    expect(viewsSummaryText(r)).toEqual({
      tone: "warn",
      text: "Back of hand was not used (too few good frames), so your result is based on the other view only.",
    });
  });

  it("a view that is only captured (the side view) is not a problem and has no hand length", () => {
    expect(isCaptureOnly(side)).toBe(true);
    expect(isCaptureOnly({ ...side, reason: "view_dropped" })).toBe(false);
    // palm + side only: nothing to say about agreement, no warning
    expect(viewsSummaryText({ views: [palm, side], view_agreement: null })).toBeNull();
    render(<ViewsTable result={{ views: [palm, back, side], view_agreement: agree }} />);
    const row = document.querySelector('[data-view="side"]')!;
    expect(row.textContent).toBe("captured (9 frames), not used for your size yet");
    expect(row.textContent).not.toMatch(/mm/);
    expect(document.querySelector('[data-view="palm"]')!.textContent).toBe("10 of 10 frames · used, hand length 181 mm");
    expect(document.querySelector('[data-view="back"]')!.textContent).toBe("11 of 12 frames · used, hand length 179 mm");
  });

  it("palm + back + side still reports the agreement of the two views that are used", () => {
    const r = { views: [palm, back, side], view_agreement: agree };
    expect(viewsSummaryText(r)!.text).toBe("The palm and back of hand views agree within 2 mm.");
  });

  it("is absent for a single view", () => {
    expect(hasViews({ views: [palm] })).toBe(false);
    expect(hasViews({ views: undefined })).toBe(false);
    const { container } = render(<ViewsNotice result={{ views: [palm], view_agreement: null }} />);
    expect(container.textContent).toBe("");
    const { container: c2 } = render(<ViewsTable result={{ views: [palm], view_agreement: null }} />);
    expect(c2.textContent).toBe("");
  });

  it("labels the between-view uncertainty term", () => {
    expect(COMPONENTS.view_disagreement).toBe("Disagreement between views");
  });
});
