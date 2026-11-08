// Named thresholds of the experimental hand segmentation. EVERY value here is PROVISIONAL and UNVALIDATED: it was
// chosen by looking at a few images, not fitted to labelled data, and must not be read as a quality guarantee.
// Lengths that scale with the hand are given as fractions of the PALM WIDTH (landmark 5 to landmark 17, in the
// pixels of the image being processed), so they hold at any camera distance or orientation.

/** Longest side of the working image the backends run on (the source frame is shrunk to it, never enlarged). */
export const DEFAULT_WORKING_SIZE = 512;

// ---- seeds (landmarks only seed a segmentation, they are never the mask) -------------------------------------
/** Radius of the "sure hand" stroke drawn along every bone, as a fraction of the palm width (a finger is ~0.22 wide). */
export const SURE_FG_BONE_RADIUS = 0.045;
/** The palm polygon is shrunk by this much to make the sure-hand palm core. */
export const SURE_FG_PALM_ERODE = 0.08;
/** Probable hand: the landmark hull grown by this much (skin edges lie beyond the joint centres). */
export const PROBABLE_FG_GROW = 0.3;
/** Probable background band: out to here from the hull; beyond it is sure background. */
export const PROBABLE_BG_GROW = 0.75;
export const GRABCUT_ITERATIONS = 4;

// ---- post-processing ------------------------------------------------------------------------------------------
/** Background holes smaller than this share of the hand area are filled (a closed gap between touching fingers is not). */
export const MAX_FILLED_HOLE_FRACTION = 0.004;
/** Opening then closing radius (smoothing), as a fraction of the palm width. */
export const SMOOTH_RADIUS = 0.012;

// ---- finger gaps ---------------------------------------------------------------------------------------------
/**
 * Two adjacent digits need at least this centre-line separation (fraction of palm width) for a gap to be expected.
 * Neighbouring knuckles are ~0.33 palm widths apart and a finger is ~0.25 wide, so fingers held TOGETHER have centre
 * lines about 0.3 apart; spread fingers are well beyond 0.42.
 */
export const GAP_EXPECTED_MIN_SEPARATION = 0.42;
/** Share of valley samples that must be background for the gap to count as preserved. */
export const GAP_PRESERVED_MIN_SHARE = 0.6;
/** Valley samples start this far along the proximal-to-tip axis of the fingers (0 = PIP joint, 1 = tip). */
export const GAP_SAMPLE_FROM = 0.35;
export const GAP_SAMPLE_TO = 1.15;
export const GAP_SAMPLE_COUNT = 12;

// ---- quality gates -------------------------------------------------------------------------------------------
/** A mask pixel this close to the image border (fraction of the shorter side) means the hand is cut off. */
export const EDGE_MARGIN_FRACTION = 0.008;
/** Minimum number of border-touching mask pixels that makes the hand "incomplete" (noise tolerance). */
export const EDGE_TOUCH_MIN_PIXELS = 3;
/** At least this share of the 21 landmarks must lie in (or within 3% of the palm width of) the mask. */
export const MIN_LANDMARKS_INSIDE = 0.85;
/**
 * Landmark seeds are forced to "hand", so a backend cannot leave them out. If something covers part of the hand the
 * seed pixels there are not skin-coloured: at least this share of the seed pixels must have a chroma (YCrCb) within
 * 3 robust standard deviations (never less than 10 units) of the seeds' median chroma.
 */
export const MIN_SEED_CONSISTENCY = 0.8;
/** Mask area divided by the landmark hull area must lie in this range (the skin edge lies beyond the joint centres). */
export const AREA_RATIO_RANGE: readonly [number, number] = [0.85, 2.4];
/** A refined fingertip must lie within this fraction of the palm width of the landmark fingertip. */
export const MAX_TIP_OFFSET = 0.3;
/** Edge width (10-90 % rise across the contour, in working-image pixels) above which the picture is called blurred. */
export const MAX_EDGE_WIDTH_PX = 6;
/** Contour points whose in/out grey contrast is below this are not used to judge sharpness (grey levels, 0-255). */
export const MIN_EDGE_CONTRAST = 12;
/** At least this share of the sampled contour points must have enough contrast, else sharpness is "unknown". */
export const MIN_EDGE_VALID_SHARE = 0.3;

// ---- stage 2a: part labels, finger gaps, confidence, analysis gates (analyse.ts) ------------------------------
// Same rule as above: PROVISIONAL, chosen on synthetic hands and the composite scenes, never fitted to real labelled data.
/** Palm pixels within this distance of the wrist cut (towards the fingers) are labelled "wrist". */
export const WRIST_BAND = 0.2;
/** Length of the palm skeleton stub that ends at each knuckle along the finger's axis (sets the knuckle-line convention). */
export const PALM_STUB = 0.5;
/** Width-profile stations, as fractions of a finger's mask length measured from its knuckle line. */
export const WIDTH_STATIONS: readonly number[] = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
/** Gap widths are reported at these distances from the valley point towards the fingertips (fractions of palm width). */
export const GAP_WIDTH_DISTANCES: readonly number[] = [0.05, 0.1, 0.2, 0.3, 0.5];
/** A background region between two fingers counts as a gap when at least this deep (fraction of palm width)... */
export const GAP_MIN_DEPTH = 0.12;
/** ...and at least this large (fraction of the palm width squared). */
export const GAP_MIN_AREA = 0.004;
/** ...and at least this share of the landmark reference depth (shallower notches, e.g. between touching fingertips, are not gaps). */
export const GAP_OPEN_MIN_RATIO = 0.25;
/**
 * Two fingers the landmarks show apart are "merged" when the open gap between them reaches less than this share of the
 * reference depth (the less advanced landmark fingertip's height above the knuckle line). On the composite scenes clean
 * spread hands gave 0.37-1.3 (lowest: ring-little, whose web sits high, under JPEG quality 25), a skin-coloured bridge
 * 0.30, the small-hand and blurred masks 0-0.36: the margin is narrow and was set on those same scenes.
 */
export const GAP_MERGED_DEPTH_RATIO = 0.35;
/** A finger whose mask reaches less than this share of its landmark chain length (knuckle to tip) is called occluded. */
export const OCCLUDED_LENGTH_RATIO = 0.7;
/**
 * A finger narrowing below this share of its own median width between 20 % and 80 % of its length is called occluded
 * (on the composite scenes natural tapering bottomed out at 0.73, the thumb; a bar over a finger gave 0.57).
 */
export const OCCLUDED_NECK_RATIO = 0.65;
/** A finger widening beyond this multiple of its own median width between 20 % and 80 % of its length: something lies over it. */
export const OCCLUDED_BULGE_RATIO = 1.6;
/** A cross-band of a finger with more than this share of pixels outside the hand's chromaticity range: an object over it. */
export const COLOUR_BREAK_SHARE = 0.5;
/** Colour bands are checked from 10 % up to this fraction of the finger's length (beyond it the nail changes the colour). */
export const COLOUR_BREAK_MAX_AT = 0.6;
/** A finger with less than this share of the area its landmarks imply (length x 0.2 palm widths) is "missing". */
export const MISSING_FINGER_AREA_RATIO = 0.25;
/** Distance from the mask boundary (fraction of palm width) at which the distance part of the confidence saturates. */
export const CONF_DIST_SCALE = 0.06;
/** Image gradient (grey levels per pixel) along the boundary that counts as a fully supporting edge. */
export const CONF_EDGE_REF = 18;
/** Colour log-likelihood ratio scale of the colour part of the confidence (logistic slope). */
export const CONF_COLOUR_SCALE = 2;
/** Gate: mean confidence in the band around the boundary must be at least this... */
export const MIN_BOUNDARY_CONFIDENCE = 0.45;
/** ...and no more than this share of the hand pixels may have a confidence below 0.5. */
export const MAX_LOW_CONFIDENCE_SHARE = 0.3;
/** Boundary-to-gradient agreement: a boundary pixel agrees when the strongest gradient along its normal is this close (px). */
export const GRADIENT_AGREE_PX = 1.5;
/** Gradients weaker than this (grey levels per pixel) do not count as an image edge. */
export const MIN_GRADIENT = 6;
