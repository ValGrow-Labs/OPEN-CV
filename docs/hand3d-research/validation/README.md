# Physical validation of the experimental 3D hand reconstruction

**Status (2026-11-08): protocols and tooling only. No phantom has been made, no board has been verified, no physical
capture has been taken, no phone has been tested. There are no physical results.** The system is experimental and is
**not validated**; nothing here may be quoted as human-hand accuracy.

| Document | What it is |
|---|---|
| [PHANTOM_PROTOCOL.md](PHANTOM_PROTOCOL.md) | The rigid hand phantom: requirements, datum marks, how its reference values are measured (calipers, never design values) |
| [BOARD_VERIFICATION.md](BOARD_VERIFICATION.md) | Checking the printed marker board: page, print scale, spacing, flatness, glare; when to reject a board |
| [CAPTURE_EXPERIMENT.md](CAPTURE_EXPERIMENT.md) | The repeated capture test: conditions, repeats, sessions, expected rejections, what is recorded |
| [DEVICE_PERFORMANCE.md](DEVICE_PERFORMANCE.md) | How Android phone performance is measured, and the (empty) results table |
| [REMAINING_RISKS.md](REMAINING_RISKS.md) | What must be true before any trial on human hands |
| [physical/](physical/) | Where the report tool writes PHYSICAL results. Only real measurements go there |

Tooling: `frontend/src/experimental/validation/` (offline: reference checker, comparison, surface distance, device
summary, report) and the capture page's validation mode `/experiment/recon/?validation` (board check, run details, board
flatness, device log, export).

**Separation rule.** Synthetic results stay where they are (`frontend/src/experimental/{board,multiview,recon}/README.md`,
`reconstruction/README.md`, `AUDIT_3D_STATUS.md`) and are always labelled SIMULATED. Physical results go only in
`physical/`, produced by the report tool from real exports and a real caliper reference. The two are never merged into one
table.
