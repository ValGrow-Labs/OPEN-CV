// Why the EXPERIMENTAL dense scan may or may not start, in four groups, from what the detectors actually return:
//   Hand detection: production evaluateBasicFrame (no hand, out of frame, too small) and the capture prototype's live
//     checks (posture, steadiness, sharpness);
//   Coin detection: the coin engine's own result (found / accepted / its reason codes);
//   Calibration: an accepted coin, the size confirmation for coins with size_check, and the production plausibility
//     check implausibleScale (config hand_length_plausible_mm);
//   Segmentation: segmentHand's result reasons.
// No thresholds are defined here and none are changed: every limit is the existing config's, read by existing code.
import type { CaptureParams, FrameObservation, Point, ReferenceObject } from "../../../api/types";
import { evaluateBasicFrame, implausibleScale, LIVE_MESSAGES, liveHandLengthMm, type LiveCode } from "../../../vision/liveChecks";
import { reasonWords } from "../../capture/analysis";
import type { QualityChips } from "../../capture/metrics";
import type { CoinSnapshot } from "../../capture/types";
import { mmText } from "./coin";

export type GroupId = "hand" | "coin" | "calibration" | "segmentation";
export type GroupStatus = "ok" | "waiting" | "failed";

export interface Reason {
  group: GroupId;
  /** The detector's own code (or, for a state that is not a detector code, a plain name like "camera_off"). */
  code: string;
  /** What the code means. */
  words: string;
  /** What to do about it (the production wording where there is one). */
  todo: string;
  kind: "failed" | "waiting";
}

export interface Group {
  id: GroupId;
  title: string;
  status: GroupStatus;
  reasons: Reason[];
}

export const GROUP_TITLES: Record<GroupId, string> = {
  hand: "Hand detection",
  coin: "Coin detection",
  calibration: "Calibration",
  segmentation: "Segmentation",
};

/** The coin engine's reason codes (vision/coinDetector.ts), in words. The "todo" is production's LIVE_MESSAGES. */
export const COIN_CODE_WORDS: Record<string, string> = {
  coin_not_found: "no coin found on the palm",
  coin_too_small: "coin too small in the picture",
  coin_occluded: "coin partly hidden (its edge is not seen all round)",
  coin_irregular_boundary: "coin edge not round (not a single flat coin)",
  coin_blurry: "coin edge blurred",
  coin_glare: "glare on the coin",
  coin_low_contrast: "coin has too little contrast with the skin",
  coin_low_confidence: "coin found but the fit is not confident enough",
  coin_ambiguous: "more than one coin-like circle",
};

export const HAND_CODE_WORDS: Record<string, string> = {
  camera_off: "camera not running",
  no_hand: "no hand found",
  hand_out_of_frame: "hand not fully inside the picture",
  hand_too_small: "hand too small in the picture",
  posture: "hand posture",
  hand_unsteady: "hand moving",
  picture_blurred: "picture not sharp",
};

export const CALIBRATION_CODE_WORDS: Record<string, string> = {
  no_accepted_coin: "no accepted coin yet, so no scale",
  size_not_confirmed: "the coin's size is not confirmed",
  implausible_scale: "the scale from this coin gives an implausible hand length",
  no_coin_selected: "no coin selected",
};

const todoFor = (code: string, fallback: string) => (code in LIVE_MESSAGES ? LIVE_MESSAGES[code as LiveCode] : fallback);

export interface GateInput {
  camera: "off" | "starting" | "running" | "error";
  landmarks: Point[] | null;
  frameW: number;
  frameH: number;
  chips: QualityChips | null;
  /** The coin engine's latest result for this hand (null until it has searched). */
  coin: CoinSnapshot | null;
  ref: ReferenceObject | null;
  sizeConfirmed: boolean;
  capture: CaptureParams;
  plausibleHandMm: [number, number];
  assumedHfovDeg: [number, number];
}

export interface GateResult {
  groups: Record<Exclude<GroupId, "segmentation">, Group>;
  /** Every prerequisite of the segmentation passes on this frame. */
  allowed: boolean;
  /** The first reason that blocks a scan (hand, then coin, then calibration), or null when allowed. */
  blocking: Reason | null;
  /** The hand length (mm) the coin's scale implies on this frame (production liveHandLengthMm), for the debug panel. */
  impliedHandMm: number | null;
  /** Everything passes except the coin (for the "waiting for coin acceptance" indicator). */
  waitingForCoinOnly: boolean;
}

function group(id: GroupId, reasons: Reason[]): Group {
  const status: GroupStatus = reasons.some((r) => r.kind === "failed") ? "failed" : reasons.length ? "waiting" : "ok";
  return { id, title: GROUP_TITLES[id], status, reasons };
}

const r = (g: GroupId, code: string, words: string, todo: string, kind: Reason["kind"] = "failed"): Reason => ({ group: g, code, words, todo, kind });

function frameOf(input: GateInput): FrameObservation | null {
  if (!input.landmarks) return null;
  return {
    timestamp_ms: 0,
    image_width: input.frameW,
    image_height: input.frameH,
    landmarks: input.landmarks,
    world_landmarks: null,
    handedness: null,
    handedness_score: null,
    coin: input.coin,
    brightness: null,
  };
}

export function liveGate(input: GateInput): GateResult {
  const frame = frameOf(input);

  // Hand detection
  const hand: Reason[] = [];
  if (input.camera !== "running") {
    hand.push(r("hand", "camera_off", HAND_CODE_WORDS.camera_off, "Start the camera", "waiting"));
  } else if (!frame) {
    hand.push(r("hand", "no_hand", HAND_CODE_WORDS.no_hand, LIVE_MESSAGES.no_hand));
  } else {
    for (const code of evaluateBasicFrame(frame, input.capture).codes) hand.push(r("hand", code, HAND_CODE_WORDS[code] ?? code, todoFor(code, code)));
    const c = input.chips;
    if (c) {
      if (!c.posture.ok && c.posture.verdict !== "n/a") hand.push(r("hand", "posture", `${HAND_CODE_WORDS.posture}: ${c.posture.message}`, c.posture.message, c.posture.verdict === "unknown" ? "waiting" : "failed"));
      if (!c.steady.steady)
        hand.push(
          c.steady.jitter === null
            ? r("hand", "hand_unsteady", "measuring steadiness", "Hold still", "waiting")
            : r("hand", "hand_unsteady", `${HAND_CODE_WORDS.hand_unsteady} (${(c.steady.jitter * 100).toFixed(1)} % jitter)`, "Hold your hand still"),
        );
      if (!c.sharpness.sharp)
        hand.push(
          r(
            "hand",
            "picture_blurred",
            `${HAND_CODE_WORDS.picture_blurred}${c.sharpness.value === null ? "" : ` (sharpness ${c.sharpness.value.toFixed(4)})`}`,
            "Hold the phone steady and let it focus",
          ),
        );
    } else {
      hand.push(r("hand", "hand_unsteady", "measuring steadiness and sharpness", "Hold still", "waiting"));
    }
  }

  // Coin detection: the engine's own result
  const coin: Reason[] = [];
  const handSeen = !!frame;
  const cs = input.coin;
  if (!handSeen) coin.push(r("coin", "needs_hand", "searched on the palm once a hand is found", "Show your open hand", "waiting"));
  else if (!cs) coin.push(r("coin", "searching", "searching the palm for the coin", "Hold still", "waiting"));
  else if (!cs.found || !cs.accepted) {
    const codes = cs.reasons.length ? cs.reasons : [cs.found ? "coin_low_confidence" : "coin_not_found"];
    for (const code of codes) coin.push(r("coin", code, `${cs.found ? "found, not accepted: " : ""}${COIN_CODE_WORDS[code] ?? code}`, todoFor(code, LIVE_MESSAGES.coin_not_found)));
  }

  // Calibration
  const cal: Reason[] = [];
  const ref = input.ref;
  if (!ref) cal.push(r("calibration", "no_coin_selected", CALIBRATION_CODE_WORDS.no_coin_selected, "Choose your coin"));
  if (ref?.size_check && !input.sizeConfirmed) cal.push(r("calibration", "size_not_confirmed", CALIBRATION_CODE_WORDS.size_not_confirmed, `Tick that your coin is the ${mmText(ref.diameter_mm)} mm one`));
  const accepted = !!cs?.found && !!cs.accepted;
  let impliedHandMm: number | null = null;
  if (!accepted) cal.push(r("calibration", "no_accepted_coin", CALIBRATION_CODE_WORDS.no_accepted_coin, "Waiting for the coin", "waiting"));
  else if (frame && ref) {
    impliedHandMm = liveHandLengthMm(frame, ref.diameter_mm);
    const scale = { referenceDiameterMm: ref.diameter_mm, assumedHfovDeg: input.assumedHfovDeg, plausibleHandMm: input.plausibleHandMm };
    if (implausibleScale(frame, scale))
      cal.push(
        r(
          "calibration",
          "implausible_scale",
          `${CALIBRATION_CODE_WORDS.implausible_scale} (${impliedHandMm === null ? "?" : Math.round(impliedHandMm)} mm; accepted ${input.plausibleHandMm[0]}-${input.plausibleHandMm[1]} mm)`,
          LIVE_MESSAGES.implausible_scale,
        ),
      );
  }

  const groups = { hand: group("hand", hand), coin: group("coin", coin), calibration: group("calibration", cal) };
  const order = [...groups.hand.reasons, ...groups.coin.reasons, ...groups.calibration.reasons];
  const allowed = order.length === 0;
  const calOtherThanCoin = cal.filter((x) => x.code !== "no_accepted_coin");
  return {
    groups,
    allowed,
    blocking: order[0] ?? null,
    impliedHandMm,
    waitingForCoinOnly: input.camera === "running" && groups.hand.status === "ok" && groups.coin.status !== "ok" && calOtherThanCoin.length === 0,
  };
}

/** The segmentation group, from the scan's phase and segmentHand's result. */
export function segmentationGroup(phase: string, seg: { ok: boolean; reasons: string[]; error?: string } | null): Group {
  if (phase === "waiting_hand") return group("segmentation", [r("segmentation", "not_started", "not started: it starts when hand, coin and calibration pass", "", "waiting")]);
  if (!seg) return group("segmentation", [r("segmentation", "running", "running on the frozen frame", "", "waiting")]);
  if (seg.ok) return group("segmentation", []);
  const codes = seg.reasons.length ? seg.reasons : ["segmentation_failed"];
  return group(
    "segmentation",
    codes.map((c) => r("segmentation", c, reasonWords(c) + (c === "segmentation_failed" && seg.error ? ` (${seg.error})` : ""), "Scan again")),
  );
}
