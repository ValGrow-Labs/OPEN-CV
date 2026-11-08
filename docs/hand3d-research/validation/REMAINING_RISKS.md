# Remaining risks and requirements before any human-hand trial

Status: the 3D reconstruction is **experimental, unvalidated**, tested only on SIMULATED renders. Each item below must be
resolved, with evidence, before a trial on people is proposed. None is resolved yet.

## A. Must pass on the phantom first (this phase)

1. **Board production**: printed boards pass `BOARD_VERIFICATION.md` reliably (scale, flatness after mounting, no sheen at
   grazing angles); the coin check agrees with the ruler.
2. **Camera geometry on real prints**: self-calibration RMS and focal-length spread across repeated captures on the same
   phone are small and stable; poses good enough that the gates accept baseline captures.
3. **Gates do their job**: every fault condition in `CAPTURE_EXPERIMENT.md` (curl, wrong scale, missing low ring, moved
   phantom) is rejected; benign conditions are not mostly rejected.
4. **Phantom accuracy and repeatability** against calipers, reported per dimension with the reference error floor;
   tolerances set by the client in advance.
5. **Phones**: real capture and build times, memory and stability on the client's chosen Android phones
   (`DEVICE_PERFORMANCE.md`).

## B. Known gaps a phantom cannot close

6. **A living hand moves.** A 30 to 60 s sweep needs the hand still to within a few millimetres; the hand-moved check is
   untested on real tremor. Requirement: measure on consented team members first how many captures it rejects.
7. **Soft tissue and posture**: the palm flattens on the board, fingers press down; the board-bounded palm side and the
   thickness then describe the hand as rested, which may differ from how a glove fits. The client must say which state
   their sizing assumes.
8. **Concavities and finger gaps**: a visual hull fills the palm hollow and closes gaps no view looks through; the
   circumference is an upper bound. If the client's sizing needs a true circumference, a different method (depth, or a
   tape) is needed.
9. **Landmarks**: the hand frame and every length depend on MediaPipe. It may find a real hand in more views than the
   synthetic one (untested), or only in the top view, where the one-view lift assumes joints at half the hand's height
   (SIMULATED hand length error -4.8 mm with that fallback).
10. **Skin tones and backgrounds**: segmentation was tested on five SIMULATED skin tones; real skin, rings, tattoos,
    sleeves, nail polish, a skin-coloured table are untested. Requirement: a stratified pilot.
11. **Definitions**: the software's hand and finger lengths are landmark-based (joint centres), the reference ones datum-
    or crease-based. The client's measurement definitions (ISO 7250-1 / EN ISO 21420 texts not yet read) must be fixed and
    the software mapped to them.
12. **Coin thickness** is not in the settings; the coin check assumes 1.5 mm. Requirement: the coin's thickness from its
    official specification, added to the configuration by its owner (not by this work).

## C. Before people (governance, unchanged rules)

13. Consent and privacy review signed (`docs/CONSENT_REVIEW.md`, `docs/DATA_COLLECTION_AND_PRIVACY.md`); photos only with
    explicit consent; no volunteer invites and no public tunnel until then.
14. The pilot and study design in `docs/hand3d-research/VALIDATION_PLAN.md` (G2 pilot, G3 at least 120 participants with a
    held-out half, G4 sign-off); participants, not captures, are the unit; calibration never fitted and evaluated on the
    same people.
15. Nothing from the 3D pipeline enters the customer sizing flow, and the system is not called validated, until G4 is
    signed.
