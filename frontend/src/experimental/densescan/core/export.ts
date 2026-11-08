// A reproducible numerical export of a point set (no image pixels). Same input and seed give byte-identical output.
import type { PointSet } from "./types";

export const POINTSET_SCHEMA = "densescan.pointset/1";

const r3 = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);

export function exportPointSet(set: PointSet, meta: Record<string, unknown> = {}): { json: string; csv: string } {
  const points = set.points.map((p) => ({
    id: p.id,
    x: r3(p.x),
    y: r3(p.y),
    gx: p.gx,
    gy: p.gy,
    region: p.region,
    accepted: p.accepted,
    reject: p.reject,
    quality: r3(p.quality),
    edgeDistPx: r3(p.edgeDistPx),
    depth: p.depth,
    z: r3(p.z),
  }));
  const doc = {
    schema: POINTSET_SCHEMA,
    note: "Experimental. A 2D sampling of the visible hand in one frame; z is measured only where depth == 'measured'. No accuracy is claimed.",
    frame: { width: set.frameWidth, height: set.frameHeight },
    config: set.config,
    calibration: { mmPerPx: set.mmPerPx, source: set.mmPerPx === null ? null : "coin (scale at the coin's plane)" },
    spacing: set.spacing,
    counts: set.counts,
    meta,
    points,
  };
  const json = JSON.stringify(doc, null, 1);
  const header = "id,x,y,gx,gy,region,accepted,reject,quality,edgeDistPx,depth,z";
  const rows = points.map((p) => [p.id, p.x, p.y, p.gx, p.gy, p.region, p.accepted ? 1 : 0, p.reject ?? "", p.quality, p.edgeDistPx, p.depth, p.z ?? ""].join(","));
  return { json, csv: [header, ...rows].join("\n") + "\n" };
}
