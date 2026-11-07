// The label layer of the camera-view overlay for the CLEAN look (HandOverlayCleanGL.tsx): the same pills and thin
// leader lines as the glow look, laid out by the same rules (layoutLabels in overlayMath.ts), written straight to
// the DOM and the SVG without re-rendering React.
//
// The glow look (HandOverlayGL.tsx) keeps its own copy of this logic inside its render loop, where it also draws the
// hand-length bracket. The clean look has no brackets and no rails, so the hand-length label is placed like any other
// "between" label, at the middle of wrist and middle fingertip. The two copies can be merged once the glow look is
// retired or changed; they are not merged now so that the glow look stays exactly as it is.
import type { MutableRefObject } from "react";
import type { HandStageProps, HandStageTag } from "./HandStage";
import { containRect, layoutLabels, sideFor, topReserveFor, type LabelFrame, type LabelIn, type LabelOut } from "./overlayMath";
import { toneAccentRgb } from "./palette";

export interface TagRefs {
  tags: MutableRefObject<(HTMLSpanElement | null)[]>;
  leads: MutableRefObject<(SVGLineElement | null)[]>;
  dots: MutableRefObject<(SVGCircleElement | null)[]>;
}

const keyOf = (tag: HandStageTag): string => `${tag.joint}-${tag.between ? tag.between.join("_") : ""}`;

/** The pills and their leader lines (empty without tags). The accent colour is fixed (the clean look does not swap colours with the pose tone). */
export function OverlayTagLayer({ tags, refs }: { tags: readonly HandStageTag[] | undefined; refs: TagRefs }) {
  if (!tags || tags.length === 0) return null;
  return (
    <div className="hand-stage-tags hand-stage-tags--around" aria-hidden="true" style={{ ["--tag-rgb" as string]: toneAccentRgb("idle") }}>
      <svg className="hand-stage-leaders" width="100%" height="100%">
        {tags.map((tag, i) => (
          <g key={`lead-${keyOf(tag)}`}>
            <line ref={(el) => void (refs.leads.current[i] = el)} opacity="0" />
            <circle ref={(el) => void (refs.dots.current[i] = el)} r="3.2" opacity="0" />
          </g>
        ))}
      </svg>
      {tags.map((tag, i) => (
        <span
          key={keyOf(tag)}
          ref={(el) => void (refs.tags.current[i] = el)}
          className={`hand-stage-tag${tag.emphasis ? " hand-stage-tag--em" : ""}${tag.between ? " hand-stage-tag--side" : ""}${tag.name ? " hand-stage-tag--named" : ""}`}
        >
          {tag.name ? (
            <>
              <span className="hand-stage-tag-name">{tag.name}</span>
              <span className="hand-stage-tag-value">{tag.label}</span>
            </>
          ) : (
            tag.label
          )}
        </span>
      ))}
    </div>
  );
}

export interface LabelState {
  /** A hand is on screen and faded in enough to label. */
  show: boolean;
  /** The 21 joints as x, y (element pixels), three numbers each (the third is unused here). */
  joints: Float32Array;
  width: number;
  height: number;
}

/** Make the function that places the labels each time it is called (a few times a second is enough). */
export function createLabelPlacer(getProps: () => HandStageProps, refs: TagRefs): (s: LabelState) => void {
  let ins: LabelIn[] = [];
  let outs: LabelOut[] = [];
  const frame: LabelFrame = { left: 0, top: 0, right: 0, bottom: 0, loX: 0, hiX: 0, topReserve: 0 };
  return ({ show, joints, width, height }) => {
    const p = getProps();
    const tags = p.tags;
    if (!tags || tags.length === 0) return;
    if (ins.length !== tags.length) {
      ins = tags.map(() => ({ x: 0, y: 0, w: 0, h: 0, side: "left", priority: 0 }));
      outs = tags.map(() => ({ visible: false, left: 0, top: 0, x1: 0, y1: 0 }));
    }
    if (!show) {
      tags.forEach((_, i) => {
        const el = refs.tags.current[i];
        if (el) el.style.opacity = "0";
        refs.leads.current[i]?.setAttribute("opacity", "0");
        refs.dots.current[i]?.setAttribute("opacity", "0");
      });
      return;
    }
    let minX = 1e9;
    let maxX = -1e9;
    for (let k = 0; k < 21; k++) {
      const x = joints[k * 3];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
    // the visible picture: the part of the element the video fills
    const fs = p.frameRef?.current;
    const pic = fs && fs.width > 0 && fs.height > 0 ? containRect(width, height, fs.width, fs.height) : { s: 1, ox: 0, oy: 0 };
    const picW = fs && fs.width > 0 ? fs.width * pic.s : width;
    const picH = fs && fs.height > 0 ? fs.height * pic.s : height;
    frame.left = pic.ox;
    frame.top = pic.oy;
    frame.right = pic.ox + picW;
    frame.bottom = pic.oy + picH;
    frame.loX = minX;
    frame.hiX = maxX;
    frame.topReserve = topReserveFor(picH);
    const mirrored = !!p.mirror;
    tags.forEach((tag, i) => {
      const el = refs.tags.current[i];
      const inn = ins[i];
      if (!el) {
        inn.w = 1e6; // no element: nothing to place
        return;
      }
      if (tag.between) {
        inn.x = (joints[tag.between[0] * 3] + joints[tag.between[1] * 3]) / 2;
        inn.y = (joints[tag.between[0] * 3 + 1] + joints[tag.between[1] * 3 + 1]) / 2;
      } else {
        inn.x = joints[tag.joint * 3];
        inn.y = joints[tag.joint * 3 + 1];
      }
      inn.side = sideFor(tag.side ?? (inn.x < (minX + maxX) / 2 ? "left" : "right"), tag.side ? mirrored : false, inn.x, minX, maxX);
      inn.w = el.offsetWidth || 70;
      inn.h = el.offsetHeight || 24;
      inn.priority = tag.priority ?? i;
    });
    layoutLabels(ins, frame, outs);
    tags.forEach((_, i) => {
      const el = refs.tags.current[i];
      const o = outs[i];
      const line = refs.leads.current[i];
      const dot = refs.dots.current[i];
      if (!el) return;
      const on = o.visible;
      el.style.opacity = on ? "1" : "0";
      el.style.visibility = on ? "visible" : "hidden";
      line?.setAttribute("opacity", on ? "1" : "0");
      dot?.setAttribute("opacity", on ? "1" : "0");
      if (!on) return;
      el.style.transform = `translate(${o.left.toFixed(1)}px, ${o.top.toFixed(1)}px)`;
      const inn = ins[i];
      if (line) {
        line.setAttribute("x1", o.x1.toFixed(1));
        line.setAttribute("y1", o.y1.toFixed(1));
        line.setAttribute("x2", inn.x.toFixed(1));
        line.setAttribute("y2", inn.y.toFixed(1));
      }
      if (dot) {
        dot.setAttribute("cx", inn.x.toFixed(1));
        dot.setAttribute("cy", inn.y.toFixed(1));
      }
    });
  };
}
