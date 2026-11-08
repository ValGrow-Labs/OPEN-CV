// SIMULATED: why the 12-to-17-still board capture cannot be registered without the board. Three renders of the capsule
// hand on a speckled table from the low (12 degree) ring: feature matches between views 5 degrees apart are almost all
// geometrically correct, between views 30 degrees apart (the stills' spacing) almost none are: at a grazing view the
// table texture is foreshortened and a change of azimuth shears it far beyond what a corner descriptor tolerates.
// Correctness is checked against the true geometry (the matched corner's table point reprojected into the other view).
import { describe, expect, it } from "vitest";
import type { CameraPose, Intrinsics } from "../common";
import { cameraCentre, pixelToNormalized } from "../multiview/image";
import { boardRig } from "../multiview/scene";
import { projectPoint } from "../reconstruction/linalg";
import { detectFeatures, matchFeatures, type Features } from "./features";
import { finishRender, makeSfmScene, renderClean, SFM_SURFACE, surfaceMask } from "./scene";

function tableHit(K: Intrinsics, pose: CameraPose, u: number, v: number): [number, number, number] | null {
  const [xn, yn] = pixelToNormalized(K, u, v);
  const R = pose.R;
  const d = [R[0] * xn + R[3] * yn + R[6], R[1] * xn + R[4] * yn + R[7], R[2] * xn + R[5] * yn + R[8]];
  const O = cameraCentre(pose);
  if (d[2] >= 0) return null;
  const t = -O[2] / d[2];
  return [O[0] + d[0] * t, O[1] + d[1] * t, 0];
}

describe("SIMULATED feature matching on the low ring (speckled table, hand excluded)", () => {
  it("matches views 5 degrees apart, not views 30 degrees apart", () => {
    const scene = makeSfmScene({ texture: "speckle" });
    const cams = boardRig(scene.hand, { width: 1280, height: 720, hfovDeg: 64, k1: -0.06, k2: 0.02, lowCount: 72, top: false });
    const pick = [0, 1, 6]; // azimuth 0, 5 and 30 degrees
    const feats = new Map<number, Features>();
    for (const i of pick) {
      const c = renderClean(scene, cams[i].intrinsics, cams[i].pose);
      feats.set(i, detectFeatures(finishRender(c, { seed: i + 1 }), { exclude: surfaceMask(c, SFM_SURFACE.hand), upright: true }));
    }
    const score = (a: number, b: number) => {
      const fa = feats.get(a)!, fb = feats.get(b)!;
      const m = matchFeatures(fa, fb, { ratio: 0.85 });
      let good = 0;
      for (const [p, q] of m) {
        const X = tableHit(cams[a].intrinsics, cams[a].pose, fa.x[p], fa.y[p]);
        const r = X && projectPoint(X, cams[b].intrinsics, cams[b].pose);
        if (r && Math.hypot(r.u - fb.x[q], r.v - fb.y[q]) < 3) good++;
      }
      return { matches: m.length, good };
    };
    const near = score(0, 1), far = score(0, 6);
    console.log(`SIMULATED low ring (12 deg), speckle: 5 deg apart ${near.good}/${near.matches} correct matches; 30 deg apart ${far.good}/${far.matches}`);
    expect(near.good).toBeGreaterThan(300);
    expect(near.good / near.matches).toBeGreaterThan(0.8);
    expect(far.good).toBeLessThan(20);
  }, 300_000);
});
