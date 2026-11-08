import { it } from "vitest";
import { boardRig, makeBoardScene, renderView, SKIN_TONES } from "../../multiview/scene";
import { estimateCameras } from "../chain";
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
it("scene", () => {
  const scene = makeBoardScene();
  const cameras = boardRig(scene, { width: 1280, height: 720, hfovDeg: 64, k1: -0.06, k2: 0.02, lowCount: 16, highCount: 0 });
  const views = cameras.map((c, i) => ({ id: c.id, image: renderView(scene, c.intrinsics, c.pose, { skin: SKIN_TONES.medium, seed: i + 1 }).image }));
  const c = estimateCameras(views).cameras;
  const per = new Map<number, number[]>();
  for (const v of c.views) { if (!v.pose) continue; for (const r of v.markerResiduals) (per.get(r.id) ?? per.set(r.id, []).get(r.id)!).push(r.rmsPx); }
  console.log(c.views.map((v) => `${v.id} ${v.poseRmsPx?.toFixed(2)} ${v.rejected ?? ""} | ${v.markerResiduals.map((r) => `${r.id}:${r.rmsPx.toFixed(2)}${r.used ? "" : "x"}`).join(" ")}`).join("\n"));
  console.log("per marker median: " + [...per.entries()].sort((a, b) => a[0] - b[0]).map(([id, xs]) => `${id}:${med(xs).toFixed(2)}(${xs.length})`).join(" "));
  console.log("map median", med([...per.values()].map(med)).toFixed(2), "worst", Math.max(...[...per.values()].map(med)).toFixed(2), "cal rms", (c.calibration as any).rmsPx);
}, 600_000);
