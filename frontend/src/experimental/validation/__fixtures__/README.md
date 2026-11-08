# Test fixtures, not measurements

Every file in this folder is a **hand-written test fixture** for the unit tests of `../` (the EXPERIMENTAL phantom
validation tooling). The numbers were typed in to make the arithmetic checkable by hand. **No person measured anything,
no phone captured anything, and nothing here describes a real phantom, hand or device.**

* Every fixture reference has a phantom id starting with `synthetic`, so the report tool refuses it unless `--test` is
  passed, and then labels the output SYNTHETIC TEST.
* Never copy a fixture, or a report made from one, into `docs/hand3d-research/validation/physical/`.
