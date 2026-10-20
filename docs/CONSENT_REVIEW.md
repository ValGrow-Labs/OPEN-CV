# Consent and data-protection review: comparison study

**Status:** for review. Nothing in this document is approved. `config/pilot_consent.json` stays
`reviewed: false`. No contact details or deletion dates have been invented: they are
placeholders for the study owner. Volunteer invites stay locked, and no public tunnel is used for
this study.

## 1. Which consent text applies

| Study | Where people take part | Consent text | Images |
|---|---|---|---|
| Remote coin pilot (`docs/PILOT_PROTOCOL.md` §5) | Own phone, own home | `config/pilot_consent.json`, shown in the app | None leave the phone |
| **Coin vs paper comparison** (`docs/COMPARISON_STUDY_PROTOCOL.md`) | In person, study phone and computer | **A separate signed paper form** (section 4 draft) | **Paper method: hand photos are transferred to and processed on the study computer** |

The remote-pilot text must **not** be reused for the comparison study.

## 2. Audit of the existing remote-pilot text against the comparison study

| Statement in `pilot_consent.json` | True for the remote pilot? | True for the comparison study? | Action |
|---|---|---|---|
| "DRAFT FOR REVIEW…" | Placeholder | n/a | Remove after review (the app refuses `reviewed: true` while it remains) |
| Prototype estimates hand length with a coin on the palm | Yes | Incomplete: there are **two** methods, one using paper and a photo | New text |
| "You will measure your own hand length with a ruler…" | Yes (self-measurement) | **No:** trained staff measure with calipers | New text |
| What is recorded: code, hand, ruler readings, coin, phone model, scan numbers | Yes | Incomplete: also breadth, timings, ease ratings, age band, sex, skin-tone band, fingernail overhang, measurer and operator codes, paper-method numbers | New text |
| **"No photos or video leave your phone."** | Yes for the coin method | **No.** The paper method photographs the hand and transfers the photo to a computer. The phone is the study's, not the participant's. | **Must not be reused.** State the photo handling exactly (section 3). |
| "We do not record your name, phone number, email address or location" | Yes | Partly: the name is on the signed paper form, kept separately from the data | State where names are kept and who holds the link |
| Sent through Cloudflare, stored on the study team's computer | Yes (tunnel) | **No:** no tunnel or internet transfer in this study | Remove; state local-only processing |
| Withdraw with the button on your link | Yes | **No:** there is no link | Withdrawal through staff, with the participant's code |
| Contact: [placeholder] | Placeholder | Placeholder | Study owner fills it in |
| Deleted by [date] | Placeholder | Placeholder | Study owner sets it |

## 3. Exactly what the paper method requires

| Question | Answer for this study |
|---|---|
| What is photographed | The **back** of one hand (palm down) and the wrist, lying on a white sheet on a dark table, photographed from above. No face. No palm side, so no palm print. Fingertip pads face down. Rings and watches removed. Tattoos, scars or nail polish on the back of the hand may be visible and could identify someone: note this in the consent text. |
| Captured with | The **study's** phone and its default camera app. Before the study: cloud photo backup and sync **off**, location tagging **off**, no messaging or cloud apps signed in. |
| Transferred how | A **USB cable** to the study computer (`C:\study\incoming`). Never by messaging apps, email, cloud drives or the tunnel. |
| Processed where | **Only on the study computer, offline**, by `python -m validation.comparison process-paper … --delete-processed` (the experimental paper method). |
| What is kept | **Numbers only:** hand length and breadth estimates, accepted/rejected, rejection reasons, in `paper_attempts.csv` under the participant code. |
| Are photos stored | **No.** On the computer, each photo is deleted right after its numbers are extracted (seconds). On the phone, it is deleted after transfer, and the "recently deleted" album is emptied at the end of every session. Photos the processor cannot read are not deleted automatically: the operator deletes them by hand and logs it. Keeping photos for later re-analysis would need a **separate, optional** consent, a retention period and secure storage. **That is not planned.** |
| Who can see photos | The scan operator, while capturing and transferring. The data manager, if a transfer needs checking. Nobody else. |
| Deletion limits | Deleting from flash storage is not forensic erasure. Mitigations: full-disk encryption on the study computer (for example BitLocker), the phone's built-in encryption, short residence times, and the logged checks in section 6. |

**Coin method in this study:** the camera frames are processed in the browser on the capture
device. Only numbers (landmark coordinates, coin metrics) reach the study computer, in validation
mode. No images are stored or transferred.

## 4. Draft consent text for the comparison study (DRAFT, not reviewed)

> **DRAFT — to be reviewed by the study owner and, where required, an ethics or legal reviewer.
> Fill in every [placeholder].**
>
> **Comparing two ways of measuring hand size with a phone camera.** We are testing two
> prototype methods. Neither is validated, and neither gives you a glove size in this study.
>
> **What happens.** A trained person measures your hand length and width with a measuring
> instrument (a caliper). You then use two phone methods, in a random order:
> (1) your hand held up to the camera with a coin on your palm, and
> (2) your hand lying flat on a sheet of paper, photographed from above. You will repeat each
> method a few times, including once on your own, and rate how easy it was. About [N] minutes.
>
> **Photos.** Method 2 takes photos of the **back of your hand and wrist** on the paper (not your
> face or palm). They are taken with the study's phone, copied by cable to the study computer,
> measured there without any internet connection, and **deleted immediately after measuring**.
> They are also deleted from the phone at the end of your session. Marks on the back of your hand
> (for example tattoos) may be visible in a photo before it is deleted. Method 1 does not keep
> any picture: the phone turns the video into numbers on the device.
>
> **What we keep.** Under a random code (not your name): the caliper measurements, the numbers
> each method produced, whether each try worked, the time taken, your ease ratings, your age
> band, sex, a skin-tone band, and whether your fingernails extend past your fingertips. Your
> signed form, which links your name to the code, is kept separately by [ROLE], locked away.
>
> **Who sees it.** Only the study team at [ORGANISATION]. It is not shared with anyone else and
> not used to train AI models. Data is kept on an encrypted study computer, not in the cloud, and
> deleted by [DATE].
>
> **Your choice.** Taking part is voluntary. You can stop at any time. To withdraw your data
> later, contact [CONTACT] with your code. We will delete everything stored under it.
> Photos are already deleted.
>
> Questions: [CONTACT].

## 5. Checklist: the final consent must match the actual workflow

Tick every item before the first participant. Any "no" blocks the study.

* [ ] The consent text is the comparison-study text, **not** `pilot_consent.json`.
* [ ] The text names **both** methods and says that method 2 takes photos.
* [ ] It says what the photos show (back of the hand and wrist on paper; no face, no palm),
      which device takes them, how they are transferred (cable), where they are processed
      (study computer, offline), and when they are deleted (immediately after measuring; from
      the phone at the end of the session).
* [ ] It does **not** say "no photos leave your phone" or anything else contradicted by the
      paper method.
* [ ] It lists every data item actually recorded (compare with the CRF and CSV templates).
* [ ] It says who holds the name-to-code link and where the signed forms are kept.
* [ ] It mentions no Cloudflare, tunnel or remote link, because none is used in this study.
* [ ] It gives a real contact and a real deletion date (set by the study owner, not invented).
* [ ] The withdrawal route works in practice: the data manager can delete one code's rows in
      every file and in validation mode (tested with a test code).
* [ ] Ethics or legal review is completed where the site requires it. Hand geometry may be
      treated as biometric or sensitive data under local law; the reviewer has assessed this.
* [ ] If the workflow changes after feasibility (section 8 of the protocol), the consent text has
      been re-checked against it.

## 6. Checklist: protecting participant data

**Set-up (once):**

* [ ] The study computer has full-disk encryption on, a separate study user account, a screen
      lock, and no cloud sync for `C:\study`.
* [ ] The study phone has cloud photo backup **off**, location tagging **off**, no personal
      accounts, and a screen lock.
* [ ] Validation mode runs locally (`127.0.0.1`), or with an operator token behind local HTTPS
      for the phone. No public tunnel. Remote-pilot volunteer invites stay locked.
* [ ] `GLOVESIZE_VALIDATION_PATH` points to `C:\study\records.jsonl`, outside the repository.
* [ ] The allocation list and its seed are held only by the data manager.
* [ ] Paper CRFs and consent forms are kept in a locked cabinet, separately from each other.
* [ ] The data-entry procedure is double entry for `reference.csv`, with discrepancies resolved
      against the CRF.

**Each session:**

* [ ] The participant code was assigned before any data was captured. No names in any file or
      in the notes.
* [ ] The validation screen was in **Blinded session** mode.
* [ ] Every paper photo was processed with `--delete-processed`; `C:\study\incoming` is empty.
* [ ] The phone's gallery **and** "recently deleted" album are empty.
* [ ] The deletion check is logged: date, session, operator code, "photos remaining: 0".

**End of study:**

* [ ] The final data files are checked for names, phone numbers and free-text identifiers.
* [ ] The analysis is done on the study computer, and results are shared as aggregate tables only.
* [ ] Data and forms are deleted by the consented date, and the deletion is logged.
