// The manifest of the capture bundle (manifest.json): everything about the capture EXCEPT the pixels, which are separate files.
// Versioned, so a later tool can read old bundles. Pure: it takes plain data and returns plain JSON-safe data.
import type { PoseConsistencyResult } from "../geometry";
import type { DepthCapabilityReport } from "../depth";
import type { CapturedView } from "./types";

export const MANIFEST_SCHEMA = "glovesize-experimental-capture/1";

export const BUNDLE_README = [
  "EXPERIMENTAL capture bundle (research prototype, not the customer app).",
  "",
  "These files contain photographs of a hand and of a coin. Photographs of a person's hand are PERSONAL DATA:",
  "keep them private, store them only where the person agreed, and delete them when no longer needed.",
  "Nothing in this bundle was uploaded anywhere: it was built in the browser on the device that took the pictures.",
  "",
  "manifest.json describes every view (landmarks, coin detection, camera settings, quality checks, analysis) without the pixels.",
  "views/*.png are the captured frames; masks/*.png are the experimental hand masks (white = hand); highres/* are optional stills",
  "from the browser's photo API.",
  "",
  "No camera poses are recorded: marker-sheet pose estimation is not implemented, so these captures cannot be reconstructed in 3D yet.",
  "Every millimetre figure in the manifest is a model estimate from the coin's plane scale, unvalidated against physical measurements.",
  "",
].join("\n");

export interface ManifestInput {
  views: readonly CapturedView[];
  createdAt: Date;
  device: { userAgent: string; screenWidth: number; screenHeight: number; devicePixelRatio: number };
  config: {
    referenceObjectId: string | null;
    referenceLabel: string;
    referenceDiameterMm: number;
    referenceDiameterUncertaintyMm: number;
    assumedHfovDeg: readonly [number, number];
    calibrationStatus: string;
    calibrationValidated: boolean;
  };
  poseConsistency: PoseConsistencyResult | null;
  depth: DepthCapabilityReport | null;
  /** Relative file names inside the archive, by view id. */
  files: Record<string, { still: string; mask: string | null; highRes: string | null }>;
}

/** JSON-safe deep copy: drops functions and undefined, turns Infinity/NaN into null (JSON.stringify's own rule), copies typed arrays out. */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function buildManifest(input: ManifestInput) {
  const views = input.views.map((v) => {
    const f = input.files[v.def.id];
    return jsonSafe({
      id: v.def.id,
      title: v.def.title,
      order: v.order,
      optional: v.def.optional,
      requiresCoin: v.def.requiresCoin,
      posture: v.def.posture,
      capturedAt: v.capturedAt,
      quality: v.quality,
      files: { still: f?.still ?? null, mask: f?.mask ?? null, highRes: f?.highRes ?? null },
      still: { width: v.still.width, height: v.still.height },
      highRes: v.highRes ? { width: v.highRes.width, height: v.highRes.height, mime: v.highRes.mime } : null,
      landmarksImagePx: v.landmarks,
      landmarksWorldMetres: v.world,
      handedness: v.handedness,
      handednessScore: v.handednessScore,
      coin: v.coin,
      stream: v.stream,
      analysis: v.analysis,
    });
  });
  return jsonSafe({
    schema: MANIFEST_SCHEMA,
    experimental: true,
    createdAt: input.createdAt.toISOString(),
    notice: "EXPERIMENTAL research capture. Not validated. Contains no pixels; see the image files. Personal data when combined with them.",
    device: input.device,
    config: { ...input.config, assumedHfovDeg: [...input.config.assumedHfovDeg], source: "public /api/config (the existing production settings, read only)" },
    // Marker-sheet pose estimation does not exist yet: the bundle carries no camera poses and none are invented.
    marker: {
      implemented: false,
      note: "Marker-sheet pose estimation is not implemented (the bundled OpenCV.js has no aruco, chessboard, cornerSubPix or calibrateCamera). No camera pose is recorded.",
    },
    poseConsistency: input.poseConsistency,
    depthCapability: input.depth,
    views,
  });
}

export type CaptureManifest = ReturnType<typeof buildManifest>;
