# Physical phantom validation results (REAL DATA ONLY)

This folder is the default output of `frontend/scripts/phantom-report.ts`, the offline report tool of the EXPERIMENTAL
board-capture reconstruction (`frontend/src/experimental/validation/`). It holds reports made from:

* caliper and tape readings of a **real, manufactured phantom**, taken by people (measurer codes, never names), with a
  gauge-block check recorded; and
* capture exports (ZIPs) made on **real phones** with the page `/experiment/recon/`, of that phantom on a printed board.

Rules:

* **Only real data go here.** Synthetic, simulated or fixture results stay in the synthetic documents and test output
  (`multiview/README.md`, `board/README.md`, `recon/README.md`, the vitest output). The tool refuses a reference whose
  phantom id starts with `synthetic`, and refuses to write `--test` output into this folder.
* **Nothing is invented.** A missing reading is missing; the tool refuses an incomplete reference and writes nothing
  numeric without one.
* **A phantom is not a person.** A report here describes one rigid object, captured repeatedly. It is not human-hand
  accuracy, it does not validate the system, and it must not be used for glove sizing.
* Keep the inputs (reference JSON, the export ZIPs, the reference mesh) in the study folder named in each report, outside
  the repository if they contain photos.

Until the first physical test is run this folder contains only this README.
