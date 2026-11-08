// Shared types of the EXPERIMENTAL board-free reconstruction chain (boardfree/). Research only; not used by the customer
// app. Every number this chain has produced so far is SIMULATED (see README.md).
import type { BinaryMask, CameraPose, Intrinsics, Pt } from "../common";
import type { RGBAImage } from "../multiview/image";

/** One captured frame as the chain receives it. */
export interface BoardFreeFrame {
  id: string;
  /** RGBA picture; every frame the same size (one camera, one zoom). */
  image: RGBAImage;
  /** The capture guide's APPROXIMATE direction for this frame (degrees above the table, around the hand), used only to
   *  choose which frame pairs to match and which frames neighbour each other. */
  elevationDeg?: number;
  azimuthDeg?: number | null;
  /** The hand landmark detector's 21 points in pixels of this picture (null entries / null = not found). */
  landmarks?: readonly (Pt | null)[] | null;
  /** The coin detector's outline edge points in this picture (distorted pixels); null = no whole coin found. */
  coinEdges?: readonly Pt[] | null;
  /** A guided still meant for the carving (the top view and the low ring at its fixed directions). When no frame is
   *  flagged, the chain picks the top view and low-ring frames about 22.5 degrees apart. */
  carve?: boolean;
}

export type SegmentationMethod = "grabcut" | "plane" | "combined";

/** One carving view's segmentation, at the reconstruction size. */
export interface ViewSegmentation {
  id: string;
  method: SegmentationMethod;
  mask: BinaryMask;
  /** 255 = classified, 0 = unknown (the view abstains there in the carving and the reprojection check). */
  known: BinaryMask;
  /** Named reasons this view's mask must not be used (empty = usable). */
  rejected: string[];
  stats: {
    handPixels: number;
    /** Share of the pixels inside the predicted hand region (the projected carving volume) that are unknown. */
    unknownShare: number;
    /** Plane-consistency only: share of the predicted hand region whose table-plane warp agreed with a neighbour. */
    tableAgreeShare: number | null;
    /** Landmarks of this view that fall inside the mask (the detector and the mask agree). */
    landmarksInside: number | null;
    neighbours: string[];
    ms: number;
  };
}

/** The metric table frame of the board-free chain. */
export interface BoardFreeFrameDef {
  /** How the in-plane axes were chosen. */
  method: "landmarks" | "silhouette";
  /** Rows: table x, y, z in SfM coordinates; origin (SfM units) maps to `offset` (mm). */
  Rf: [number, number, number, number, number, number, number, number, number];
  origin: [number, number, number];
  offset: [number, number, number];
  mmPerUnit: number;
  /** The table plane in SfM units (n . X = d, n toward the cameras), its RANSAC inliers and RMS (SfM units). */
  plane: { n: [number, number, number]; d: number; inliers: number; rmsMm: number };
  /** The forearm cut: the volume's -x face (table mm). */
  cutXMm: number;
  notes: string[];
}

/** A carving view in the table frame (reconstruction size). */
export interface CarveInput {
  id: string;
  frameIndex: number;
  intrinsics: Intrinsics;
  pose: CameraPose;
  landmarks: (Pt | null)[] | null;
}
