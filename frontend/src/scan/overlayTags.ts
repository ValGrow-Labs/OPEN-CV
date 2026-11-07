// The labels the 3D camera overlay draws round the hand while scanning: each finger's length, the palm width and
// the hand length, with their names, in the columns the layout prefers (left: index, thumb, palm width; right:
// middle, ring, pinky and the hand length with its bracket). The numbers are the same live ones the 2D tags show.
// A value that is not there is simply not labelled.
import type { HandStageTag } from "../hand3d/HandStage";
import { FINGER_TIPS, type FingerName, type LiveLengths } from "../vision/liveLengths";
import { MIDDLE_TIP, WRIST } from "../vision/geometry";

const INDEX_MCP = 5;
const LITTLE_MCP = 17;

/** Name, preferred column and the order labels are kept in when the picture is too narrow for all of them. */
const FINGERS: Record<FingerName, { name: string; side: "left" | "right"; priority: number }> = {
  index: { name: "Index", side: "left", priority: 1 },
  middle: { name: "Middle", side: "right", priority: 2 },
  ring: { name: "Ring", side: "right", priority: 3 },
  little: { name: "Pinky", side: "right", priority: 4 },
  thumb: { name: "Thumb", side: "left", priority: 5 },
};

const mm = (v: number) => `${Math.round(v)} mm`;

export function overlayTags(live: LiveLengths | null): HandStageTag[] | undefined {
  if (!live) return undefined;
  const tags: HandStageTag[] = [];
  for (const f of Object.keys(FINGER_TIPS) as FingerName[]) {
    const v = live.fingersMm[f];
    if (!Number.isFinite(v)) continue;
    const d = FINGERS[f];
    tags.push({ joint: FINGER_TIPS[f][1], label: mm(v), name: d.name, side: d.side, priority: d.priority });
  }
  if (Number.isFinite(live.handMm)) {
    tags.push({ joint: MIDDLE_TIP, between: [WRIST, MIDDLE_TIP] as const, label: mm(live.handMm), emphasis: true, name: "Length", side: "right", priority: 0 });
  }
  if (Number.isFinite(live.palmWidthMm)) {
    tags.push({ joint: INDEX_MCP, between: [INDEX_MCP, LITTLE_MCP] as const, label: mm(live.palmWidthMm), name: "Palm width", side: "left", priority: 6 });
  }
  return tags;
}
