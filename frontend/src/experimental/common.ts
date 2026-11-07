// Shared plain types of the experimental hand-segmentation and 3D research (src/experimental/**).
//
// EXPERIMENTAL: nothing here is used by the customer flow, the scan, the coin pipeline or the sizing, and nothing
// here changes a production setting. It is research code: its numbers are model estimates until they are compared
// with physical reference measurements, which have not been made.

/** A 2D point in image pixels (x right, y down). */
export interface Pt {
  x: number;
  y: number;
}

/** A 3D point. Units are stated where it is used (metres for MediaPipe world landmarks, millimetres for a point cloud). */
export interface Pt3 {
  x: number;
  y: number;
  z: number;
}

/** A binary mask, row-major, one byte per pixel: 0 = background, 255 = hand. */
export interface BinaryMask {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Why an experimental result must not be used (shown to the person, never hidden). */
export type RejectReason =
  | "no_hand"
  | "hand_incomplete" // touches the frame edge, or fewer than five fingertips found
  | "hand_blurred"
  | "hand_occluded" // landmarks fall outside the mask, or part of the hand is covered
  | "fingers_merged" // the gap between adjacent fingers is closed in the mask
  | "mask_implausible" // far too small, too large or fragmented for the landmarks
  | "segmentation_failed";

/** The scale of one image, from the coin on the palm (read from the existing coin detection, never recomputed here). */
export interface ImageScale {
  /** Millimetres per image pixel at the coin's plane. */
  mmPerPx: number;
  /** Relative standard uncertainty of that scale (0.02 = 2 %), a model estimate. */
  relUncertainty: number;
  source: "coin";
}

// ---------------------------------------------------------------------------------------------------------------
// Camera geometry and meshes (shared by scale/, reconstruction/ and depth/). One convention everywhere:
//   world: millimetres, right-handed; camera: OpenCV convention (x right, y down, z forward);
//   a world point X maps to the camera as  Xc = R * X + t  and to the image as  u = fx * Xc.x / Xc.z + cx,
//   v = fy * Xc.y / Xc.z + cy  (pixels, before distortion; k1/k2 are radial distortion of the normalised coordinates).

export interface Intrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
  /** Radial distortion coefficients (undefined = none / already corrected by the phone). */
  k1?: number;
  k2?: number;
}

/** World-to-camera pose: Xc = R * X + t. `R` is row-major 3x3. */
export interface CameraPose {
  R: readonly number[];
  t: readonly [number, number, number];
}

/** An indexed triangle mesh in millimetres. */
export interface Mesh {
  /** x, y, z per vertex. */
  vertices: Float32Array;
  /** Three vertex indices per triangle, counter-clockwise seen from outside. */
  indices: Uint32Array;
}

/** A value with the way it was obtained, so a model estimate is never shown as a measurement. */
export interface Quantity {
  value: number | null;
  unit: "mm" | "mm2" | "px" | "px2" | "ratio";
  /** "direct": measured geometry of the reconstruction; "model": needs a model or assumption; "none": not available. */
  basis: "direct" | "model" | "none";
  /** Why it is null, or the assumption it rests on. */
  note: string;
}

