// Builds the SIMULATED viewer-demo data off the main thread (the synthetic capsule hand: silhouettes, hull, mesh, labels).
import { buildDemo, buildStress } from "./buildDemo";

self.onmessage = (e: MessageEvent<{ kind: "hand" | "stress" }>) => {
  try {
    if (e.data.kind === "stress") {
      const s = buildStress();
      self.postMessage({ ok: true, kind: "stress", data: s }, { transfer: [s.mesh.vertices.buffer, s.mesh.indices.buffer, s.points.buffer, s.pointLabels.buffer] });
      return;
    }
    const d = buildDemo();
    const transfer = [d.mesh.vertices.buffer, d.mesh.indices.buffer, d.confidence.buffer, d.support.buffer, d.points.buffer, d.pointLabels.buffer, d.pointColors.buffer, d.landmarks.buffer];
    self.postMessage({ ok: true, kind: "hand", data: d }, { transfer });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err as Error)?.message ?? err) });
  }
};
