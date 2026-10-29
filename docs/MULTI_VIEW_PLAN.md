# Scanning more than the palm: what is built, what it does, and what comes next

For the client (glove manufacturer) and the project team. Plain language; technical terms are
explained where they first appear. This app is still an **unvalidated prototype**: no number in
this note is a measured accuracy of the app on real people.

## 1. What the client asked

Today the app looks at the **palm only**. The client's view: other angles (the back of the hand and
the side of the hand) will "help the computer know the measurements more precisely".

## 2. What is built now

The guided scan is now **three mandatory views, one after the other**: **palm → back of hand → side
of hand**. A coin of known size lies on the hand in each view (the coin is the ruler). On a phone
the whole scan takes about **15 seconds** (roughly 5 s per view; informal estimate from test runs).

The views are **settings, not code**. In `config/measurement.json`, under `capture.views`, each view
has: `id`, `label`, `required`, `used_for_size`, `title`, `instruction`, `note`, and its own
on-screen guidance messages. The team can reorder views, make one optional, switch one off, or
reword the instructions without changing the program.

## 3. What each view does today (honestly)

| View | Counts toward the size? | What it does |
|---|---|---|
| **Palm** | **Yes, it drives the size** | The primary view. Hand length and finger lengths come from here. |
| **Back of hand** | **Yes, as a cross-check** | A second, independent reading of hand length. |
| **Side of hand** | **No, not yet** | Captured with basic checks only (a hand in frame, large enough, in usable light; the coin is optional). Not used in the size. |

**How the back view is used.** Each view is measured on its own, then the views are averaged (one
vote per view, not per frame). **How much the two views disagree is added to the uncertainty**, so a
disagreement makes the answer less certain, never more. If the two hand lengths differ by more than
**6%** (a provisional threshold, not validated), the app shows a warning. This can catch a wrong
coin, or a coin that is not lying flat.

**What it does not do.** The back view does **not, by itself, shrink the typical ±7 mm**
uncertainty. That figure is dominated by stored default allowances that both views share: how the
hand model's joint points differ from the anatomical wrist and fingertip (5.0 mm), the depth between
the coin and the joints (about 3 mm), and the coin's own size tolerance. These are assumptions, not
measurements. Only **tape-measured participants** can replace them with measured values. So the
honest benefit of the second view today is a **cross-check**, not a more precise number.

## 4. Why the side view is not used for the size yet

An angled or side view **foreshortens** the hand (the hand turns away from the camera, so it looks
shorter), and the method used for the palm assumes a flat hand facing the camera. Informal evidence
from the client's two sample photos (**two photos, one hand that looks the same: not a validation**):

| Reading of hand length | Back-of-hand photo | Angled/side photo |
|---|---|---|
| Straight distance in the image, scaled by the coin | about 175 mm | about 143 mm (about **19% short**) |
| Using the hand model's depth values as well | about 177 mm | about 144 mm |
| The hand model's own metric lengths | about 156 mm | about 189 mm (inconsistent) |

Using depth information does not repair the angled view, and the model's own metric lengths are not
consistent from one view to the next. So the flat-hand method **cannot** be applied to the side view.

**The side view's real value is hand thickness** (the depth from the palm to the back of the hand).
Together with the palm breadth from the palm and back views, thickness can estimate the **hand
circumference** (the distance around the hand at the knuckles) with an ellipse approximation.
Circumference is the measurement gloves are often sized by, and **the camera cannot give it
today**; the app currently asks the customer for a tape measurement instead. This is where the
side view could genuinely add something new.

## 5. What is needed to make the side view count

1. **A thickness method**: for example, the silhouette of the hand seen edge-on, scaled by the
   coin. *Owner: the project team.*
2. **Caliper-measured thickness** for **60 or more study participants** (the same people as the
   length study). *Owner: the client or pilot team provides the participants and the calipers.*
3. **Fit and validate on held-out people**: build the method on some participants, check it on
   others it has never seen. *Owner: the project team.*
4. **Only then** set `used_for_size` to `true` for the side view and add the method to the size
   calculation.

Rough effort (informal estimate): a few weeks for the method and the study tooling, plus the time
to recruit and measure participants. The length study and the thickness study can run together.

## 6. What the client needs to decide or provide

- **Mandatory or optional views.** Mandatory views cost each customer about **10 extra seconds**,
  and the side view does not change the size until step 5 is done. **Recommendation:** keep the
  side view mandatory only for **study sessions** (to collect data), and optional or off for
  everyday customers until it is used.
- **The real size chart.** Size bands wider than about **±8 mm** per size help the camera name a
  single size; narrow bands make the app answer "most likely size" plus a range.
- **Whether circumference is a sizing input**, and which product it applies to.
- **Consent and legal review** before collecting data from volunteers (consent text, retention, any
  biometric-data rules). Volunteer invites stay off until this is reviewed.

## 7. Suggested wording for customers

> "We'll take three quick photos of your hand, about 15 seconds in total: your palm, the back of
> your hand, and the side. Keep a coin flat on your hand each time. The palm and back views are used
> to check each other. The side view is not part of your size yet, as we are still testing it. Your
> result is an estimate and cannot guarantee fit."
