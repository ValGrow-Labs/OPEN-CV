// Known-board segmentation against the exact masks of SIMULATED photos (capsule hand, Lambertian skin, soft shadow,
// blur, noise, radial distortion). These numbers say how the method behaves on the test renderer, NOT on real photos.
// Full table (5 skin tones x 25 views): RUN_MULTIVIEW_E2E=1 npx vitest run --no-file-parallelism src/experimental/multiview/segment.test.ts
import { describe, expect, it } from "vitest";
import { perturbPose } from "../reconstruction/synthetic";
import { boardVolume, forearmBox } from "./reconstruct";
import { boardRig, makeBoardScene, renderView, SKIN_TONES, type BoardCamera, type RGB } from "./scene";
import { scoreMask, segmentBoardView, type MaskScore, type SegmentOptions } from "./segment";

const FULL = !!process.env.RUN_MULTIVIEW_E2E;
const scene = makeBoardScene();
const volume = boardVolume();
const segOpts: Partial<SegmentOptions> = { volume, forearmBox: forearmBox(volume) };
const allCams = boardRig(scene, { highCount: 8, k1: 0.02 });
const subset = (cams: BoardCamera[]) => cams.filter((c) => c.id === "top" || ["e12-000", "e12-090", "e12-180", "e12-270", "e35-045", "e35-225"].includes(c.id));

interface Row extends MaskScore {
  tone: string;
  elevation: string;
  views: number;
  unknownInVolume: number;
}

function evaluate(tone: keyof typeof SKIN_TONES, cams: BoardCamera[], extra: { table?: RGB } = {}): Row[] {
  const groups = new Map<string, { s: MaskScore[]; unk: number[] }>();
  cams.forEach((c, i) => {
    const r = renderView(scene, c.intrinsics, c.pose, { skin: SKIN_TONES[tone], seed: 11 + i, ...(extra.table ? { table: extra.table } : {}) });
    const seg = segmentBoardView(r.image, c.intrinsics, c.pose, segOpts);
    const key = c.elevationDeg === 90 ? "top (90)" : `${c.elevationDeg} deg`;
    const g = groups.get(key) ?? { s: [], unk: [] };
    g.s.push(scoreMask(seg, r.mask));
    g.unk.push(seg.stats.unknownInVolume);
    groups.set(key, g);
  });
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  return [...groups].map(([elevation, g]) => ({
    tone,
    elevation,
    views: g.s.length,
    iou: mean(g.s.map((x) => x.iou)),
    iouKnown: mean(g.s.map((x) => x.iouKnown)),
    boundaryMeanPx: mean(g.s.map((x) => x.boundaryMeanPx)),
    boundaryP95Px: Math.max(...g.s.map((x) => x.boundaryP95Px)),
    handKnown: mean(g.s.map((x) => x.handKnown)),
    missedKnown: Math.max(...g.s.map((x) => x.missedKnown)),
    falseHand: Math.max(...g.s.map((x) => x.falseHand)),
    unknownInVolume: mean(g.unk),
  }));
}

function table(rows: Row[]): string {
  const head = "| skin | elevation | views | IoU | IoU (known px) | boundary mean px | boundary p95 px (max) | true hand px known | known-but-missed hand px (max/view) | false hand px (max/view) | unknown share of volume px |";
  const lines = rows.map((r) => `| ${r.tone} | ${r.elevation} | ${r.views} | ${r.iou.toFixed(3)} | ${r.iouKnown.toFixed(3)} | ${r.boundaryMeanPx.toFixed(2)} | ${r.boundaryP95Px.toFixed(1)} | ${(100 * r.handKnown).toFixed(1)} % | ${r.missedKnown} | ${r.falseHand} | ${(100 * r.unknownInVolume).toFixed(1)} % |`);
  return [head, "|" + "---|".repeat(11), ...lines].join("\n");
}

describe("SIMULATED known-board segmentation", () => {
  const tones = (FULL ? ["light", "medium", "tan", "dark", "veryDark"] : ["light", "veryDark"]) as (keyof typeof SKIN_TONES)[];
  const rows: Row[] = [];
  for (const t of tones)
    it(`${t} skin, top / 12 deg / 35 deg views: IoU above 0.95 and almost no hand pixel lost as known background`, () => {
      const r = evaluate(t, FULL ? allCams : subset(allCams));
      rows.push(...r);
      for (const x of r) {
        expect(x.iou).toBeGreaterThan(0.95);
        expect(x.boundaryMeanPx).toBeLessThan(1.5);
        // a known-background pixel inside the true hand carves real hand away: keep these rare
        expect(x.missedKnown).toBeLessThan(150);
      }
    }, 600_000);
  it("segmentation table", () => {
    console.log(`SIMULATED segmentation (${FULL ? "full" : "subset"}):` + String.fromCharCode(10) + table(rows));
    expect(rows.length).toBeGreaterThan(0);
  });

  it("a skin-coloured table: off-paper pixels become unknown rather than wrongly known", () => {
    const cams = allCams.filter((c) => ["e12-000", "e12-090", "e12-270"].includes(c.id));
    const rows = evaluate("medium", cams, { table: SKIN_TONES.medium });
    console.log("SIMULATED segmentation, skin-coloured table:\n" + table(rows));
    for (const r of rows) {
      expect(r.unknownInVolume).toBeGreaterThan(0.1);
      expect(r.missedKnown).toBeLessThan(300);
    }
  }, 300_000);

  it("pose error: the predicted print shifts, but in the top view the hand lies on plain paper away from the markers (report)", () => {
    const c = allCams.find((x) => x.id === "top")!;
    const r = renderView(scene, c.intrinsics, c.pose, { seed: 5 });
    const out: string[] = [];
    for (const [deg, tol] of [[0, 3], [1, 3], [1, 12]] as const) {
      const pose = deg ? perturbPose(c.pose, deg, 2, 77) : c.pose;
      const s = scoreMask(segmentBoardView(r.image, c.intrinsics, pose, { ...segOpts, edgeTolPx: tol }), r.mask);
      out.push(`pose error ${deg} deg / ${deg ? 2 : 0} mm, edgeTolPx ${tol}: IoU ${s.iou.toFixed(3)}, false hand px ${s.falseHand}, known-but-missed ${s.missedKnown}`);
      if (tol === 12) expect(s.iou).toBeGreaterThan(0.9);
    }
    console.log("SIMULATED segmentation under pose error (top view):\n" + out.join("\n"));
  }, 120_000);
});
