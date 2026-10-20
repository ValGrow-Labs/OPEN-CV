import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, enrolPilot, fetchPilotSession, submitPilotScan, withdrawPilot } from "../api/client";
import type { LengthUnit, PilotScanResult, PilotSession, PublicConfig, TrialCondition } from "../api/types";
import { HAND_LENGTH_RANGE_MM, referenceCheck, toMm } from "../ui/pilot";
import { ScanScreen } from "./ScanScreen";

interface Props {
  config: PublicConfig;
  token: string;
}

const STEP_TEXT: Record<TrialCondition, { title: string; how: string }> = {
  standard: {
    title: "Standard scan",
    how: "Prop the phone up (against a book or a cup) about 35-40 cm from your hand, or ask someone to hold it. Use the front camera so you can see the guide. Hand flat and open, palm to the camera, fingers together, coin flat in the middle of your palm.",
  },
  distance_near: { title: "A little closer", how: "As the standard scan, but closer: about 25-30 cm from the camera." },
  distance_far: { title: "A little further", how: "As the standard scan, but further: about 50-60 cm. Your hand should still fill the guide." },
  coin_off_centre: { title: "Coin off-centre", how: "Move the coin towards the base of your index finger, still lying flat on your palm." },
  lighting_changed: { title: "Different light", how: "Change the light: switch a lamp off or on, or move nearer a window." },
  hand_rotated: { title: "Hand turned slightly", how: "Turn your hand a little (about 15-20 degrees) so your fingers point slightly left or right." },
  fingers_slightly_bent: { title: "Fingers relaxed", how: "Relax your fingers so that they curve slightly." },
};

const REASONS: Record<string, string> = {
  coin_not_found: "the coin was not found",
  coin_tilted: "the hand or coin was tilted",
  too_close: "the camera was too close",
  coin_too_small: "the coin looked too small (move a little closer)",
  insufficient_frames: "not enough steady frames",
  scan_unstable: "the hand moved during the scan",
  coin_ambiguous: "more than one coin-like object was visible",
};

const num = (s: string) => (s.trim() === "" ? undefined : Number(s));

/** Plan steps with how many accepted scans each still needs. */
function planProgress(session: PilotSession) {
  const accepted: Partial<Record<TrialCondition, number>> = {};
  for (const s of session.scans) if (s.scan_status === "accepted") accepted[s.condition] = (accepted[s.condition] ?? 0) + 1;
  const seen: Partial<Record<TrialCondition, number>> = {};
  return session.scan_plan.map((condition) => {
    const k = (seen[condition] = (seen[condition] ?? 0) + 1);
    return { condition, done: (accepted[condition] ?? 0) >= k };
  });
}

/**
 * Remote pilot volunteer flow, opened from a personal invite link (#/pilot/<token>). Records
 * the volunteer's own ruler measurement and scans; never shows camera estimates or sizes.
 */
export function PilotScreen({ config, token }: Props) {
  const [session, setSession] = useState<PilotSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [step, setStep] = useState<"intro" | "consent" | "coin" | "measure">("intro");
  const [agreed, setAgreed] = useState(false);
  const [form, setForm] = useState({
    coin: "",
    coinValue: "",
    coinUnit: "mm" as LengthUnit,
    unit: "mm" as LengthUnit,
    r1: "",
    r2: "",
    r3: "",
    hand: "" as "" | "left" | "right",
    helper: "" as "" | "alone" | "with_helper",
    device: "",
  });
  const [scanning, setScanning] = useState<TrialCondition | null>(null);
  const [lighting, setLighting] = useState("indoor_bright");
  const [distance, setDistance] = useState("");
  const [last, setLast] = useState<PilotScanResult | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetchPilotSession(token)
      .then((s) => {
        setSession(s);
        setError(null);
      })
      .catch((e) => {
        if (e instanceof ApiError && (e.status === 404 || e.status === 410 || e.status === 401)) setGone(e.message);
        else setError(e instanceof ApiError ? e.message : "Could not reach the study server. Try again later.");
      });
  }, [token]);

  useEffect(load, [load]);

  if (gone)
    return (
      <Page title="This link is not active">
        <p className="muted">{gone}. Please contact the person who sent you the link.</p>
      </Page>
    );
  if (!session)
    return (
      <Page title="Hand measurement pilot">
        {error ? (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </Page>
    );

  const coin = session.coins.find((c) => c.id === (session.enrolment?.coin_object_id ?? form.coin));
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  if (scanning && session.enrolment) {
    return (
      <ScanScreen<PilotScanResult>
        config={config}
        chartId={config.default_chart_id}
        reference={{ object_id: session.enrolment.coin_object_id }}
        showIntro={session.scans.length === 0}
        requireCoinConfirm={false}
        submit={(scan) => submitPilotScan(token, { condition: scanning, lighting, distance_cm: num(distance), scan })}
        onCancel={() => setScanning(null)}
        onResult={(r) => {
          setLast(r);
          setScanning(null);
          setDistance("");
          load();
        }}
      />
    );
  }

  const withdraw = async () => {
    if (!window.confirm("Delete everything you have submitted and leave the study?")) return;
    try {
      const r = await withdrawPilot(token);
      setGone(`Your data has been deleted (${r.deleted_records} scans)`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not delete your data. Please contact the study team.");
    }
  };

  const banner = session.purpose === "test" && (
    <div className="notice notice-info small" role="note">
      Test link: scans from this link are never counted as study results.
    </div>
  );
  const footer = (
    <div className="stack" style={{ gap: 6, marginTop: 8 }}>
      <button className="link small" style={{ alignSelf: "flex-start" }} onClick={() => void withdraw()}>
        Withdraw and delete my data
      </button>
      <span className="small muted">Your code: {session.participant_code}. No photos or video leave your phone.</span>
    </div>
  );

  // ------------------------------------------------------------------ enrolled: scans
  if (session.enrolment) {
    const plan = planProgress(session);
    const next = plan.find((p) => !p.done);
    const limitReached = session.submissions >= session.max_submissions;
    return (
      <Page title={next ? "Scan your hand" : "Thank you!"}>
        {banner}
        {last && (
          <div className={`notice ${last.scan_status === "accepted" ? "notice-info" : "notice-error"} small`} role="status">
            {last.scan_status === "accepted"
              ? "Scan saved."
              : `That scan could not be used (${last.reasons.map((r) => REASONS[r] ?? r).join(", ") || "unknown reason"}). Please try it again.`}
          </div>
        )}
        <ol className="stack" style={{ gap: 6, paddingLeft: 20, margin: 0 }} aria-label="Scan plan">
          {plan.map((p, i) => (
            <li key={i} className={p.done ? "muted" : undefined}>
              {p.done ? "✓ " : ""}
              {STEP_TEXT[p.condition].title}
            </li>
          ))}
        </ol>
        {next && !limitReached && (
          <section className="card stack" aria-labelledby="next-step">
            <h2 id="next-step">{STEP_TEXT[next.condition].title}</h2>
            <p>{STEP_TEXT[next.condition].how}</p>
            <p className="small muted">
              Use your {session.enrolment.hand} hand and the {coin?.label ?? "same coin"}.
            </p>
            <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
              <div className="field" style={{ flex: 1, minWidth: 140 }}>
                <label htmlFor="p-light">Light</label>
                <select id="p-light" className="select" value={lighting} onChange={(e) => setLighting(e.target.value)}>
                  <option value="indoor_bright">Indoor, bright</option>
                  <option value="indoor_dim">Indoor, dim</option>
                  <option value="daylight">Daylight</option>
                  <option value="mixed">Mixed</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div className="field" style={{ flex: 1, minWidth: 140 }}>
                <label htmlFor="p-dist">Distance to camera (cm, if you can measure it)</label>
                <input id="p-dist" className="input num" inputMode="decimal" value={distance} onChange={(e) => setDistance(e.target.value)} />
              </div>
            </div>
            <div>
              <button className="btn btn-primary" onClick={() => setScanning(next.condition)}>
                Start this scan
              </button>
            </div>
          </section>
        )}
        {!next && <p>All scans are done. Thank you for taking part! You can close this page.</p>}
        {next && limitReached && <p>The maximum number of scans for this link has been reached. Thank you for taking part!</p>}
        {footer}
      </Page>
    );
  }

  // ------------------------------------------------------------------ enrolment steps
  if (step === "intro") {
    return (
      <Page title="Hand measurement pilot">
        {banner}
        <p>
          Thank you for helping us test a prototype that estimates hand length from a phone camera. It takes about 15
          minutes. It has not been validated, and it will not give you a glove size.
        </p>
        <section className="card stack">
          <h2>You will need</h2>
          <ul className="stack" style={{ gap: 4, paddingLeft: 20, margin: 0 }}>
            <li>A ruler with millimetre marks</li>
            <li>A book or other flat, straight object</li>
            <li>
              One of these coins:{" "}
              {session.coins.map((c) => `${c.label} (${c.diameter_mm} mm)`).join("; ")}
            </li>
            <li>A table, and something to prop your phone against</li>
            <li>If possible, someone to help you measure</li>
          </ul>
        </section>
        <div>
          <button className="btn btn-primary" onClick={() => setStep("consent")}>
            Continue
          </button>
        </div>
        {footer}
      </Page>
    );
  }

  if (step === "consent") {
    return (
      <Page title={session.consent.title}>
        {banner}
        {!session.consent.reviewed && (
          <div className="notice notice-error small" role="note">
            Draft consent text (not yet reviewed).
          </div>
        )}
        <section className="card stack" aria-label="Consent text">
          {session.consent.paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </section>
        <label className="radio-row">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>I have read this and agree to take part.</span>
        </label>
        <div className="row" style={{ gap: 12 }}>
          <button className="btn" onClick={() => setStep("intro")}>
            Back
          </button>
          <button className="btn btn-primary" disabled={!agreed} onClick={() => setStep("coin")}>
            I agree
          </button>
        </div>
        {footer}
      </Page>
    );
  }

  const coinMm = num(form.coinValue) !== undefined ? toMm(num(form.coinValue)!, form.coinUnit) : undefined;
  const coinOk = coin !== undefined && coinMm !== undefined && Math.abs(coinMm - coin.diameter_mm) <= session.coin_check_tolerance_mm;

  if (step === "coin") {
    return (
      <Page title="Your coin">
        {banner}
        <fieldset className="stack" style={{ gap: 8, border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 600, marginBottom: 8 }}>Which coin will you use?</legend>
          {session.coins.map((c) => (
            <label key={c.id} className="radio-row">
              <input type="radio" name="p-coin" checked={form.coin === c.id} onChange={() => setForm({ ...form, coin: c.id })} />
              <span>
                {c.label} <span className="small muted">({c.diameter_mm} mm across)</span>
              </span>
            </label>
          ))}
        </fieldset>
        <UnitSelect unit={form.coinUnit} onChange={set("coinUnit")} />
        <div className="field">
          <label htmlFor="p-coin-size">Measure the coin across its widest point with the ruler ({form.coinUnit})</label>
          <input id="p-coin-size" className="input num" inputMode="decimal" value={form.coinValue} onChange={set("coinValue")} />
          {coin && coinMm !== undefined && !coinOk && (
            <span className="small" role="status" style={{ color: "var(--warn)" }}>
              That is {coinMm.toFixed(1)} mm, but this coin should be {coin.diameter_mm} mm. It may be a different coin or an
              older series. Check the coin and measure again.
            </span>
          )}
        </div>
        <div className="row" style={{ gap: 12 }}>
          <button className="btn" onClick={() => setStep("consent")}>
            Back
          </button>
          <button className="btn btn-primary" disabled={!coinOk} onClick={() => setStep("measure")}>
            Continue
          </button>
        </div>
        {footer}
      </Page>
    );
  }

  // step === "measure"
  const readings = [form.r1, form.r2, form.r3].map(num).filter((v): v is number => v !== undefined && Number.isFinite(v));
  const readingsMm = readings.map((v) => toMm(v, form.unit));
  const inRange = readingsMm.every((v) => v >= HAND_LENGTH_RANGE_MM[0] && v <= HAND_LENGTH_RANGE_MM[1]);
  const check = referenceCheck(readingsMm, config.validation_reference_tolerance_mm);
  const ready = readings.length >= 2 && inRange && check?.reliability === "agreed" && form.hand && form.helper && form.device.trim();

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await enrolPilot(token, {
        consent_version: session.consent.version,
        consent_accepted: true,
        hand: form.hand as "left" | "right",
        helper: form.helper as "alone" | "with_helper",
        hand_length: readings.map((value) => ({ value, unit: form.unit })),
        tool: "ruler",
        coin_object_id: form.coin,
        coin_check: { value: num(form.coinValue)!, unit: form.coinUnit },
        device: form.device.trim(),
      });
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save your measurements.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="Measure your hand">
      {banner}
      <section className="card stack">
        <ol className="stack" style={{ gap: 6, paddingLeft: 20, margin: 0 }}>
          <li>Rest your forearm and hand palm up on a table. Keep your wrist straight and your fingers straight and together.</li>
          <li>Put the book against the tip of your middle finger.</li>
          <li>
            Lay the ruler along your palm, starting at the book. Read the number at the middle of the wrist crease
            closest to your palm.
          </li>
          <li>Lift your hand, relax it, put it back and measure again. If the two readings differ by more than 2 mm, measure a third time.</li>
        </ol>
      </section>
      <fieldset className="row" style={{ gap: 16, border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 8 }}>Which hand will you scan?</legend>
        {(["right", "left"] as const).map((h) => (
          <label key={h} className="radio-row" style={{ gridTemplateColumns: "20px auto" }}>
            <input type="radio" name="p-hand" checked={form.hand === h} onChange={() => setForm({ ...form, hand: h })} />
            <span>{h === "right" ? "Right" : "Left"}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="row" style={{ gap: 16, border: 0, padding: 0, margin: 0, flexWrap: "wrap" }}>
        <legend style={{ fontWeight: 600, marginBottom: 8 }}>Who measured?</legend>
        <label className="radio-row" style={{ gridTemplateColumns: "20px auto" }}>
          <input type="radio" name="p-helper" checked={form.helper === "alone"} onChange={() => setForm({ ...form, helper: "alone" })} />
          <span>I measured myself</span>
        </label>
        <label className="radio-row" style={{ gridTemplateColumns: "20px auto" }}>
          <input type="radio" name="p-helper" checked={form.helper === "with_helper"} onChange={() => setForm({ ...form, helper: "with_helper" })} />
          <span>Someone helped me</span>
        </label>
      </fieldset>
      <UnitSelect unit={form.unit} onChange={set("unit")} />
      <div className="row" style={{ gap: 8 }}>
        {(["r1", "r2", "r3"] as const).map((k, i) => (
          <input
            key={k}
            aria-label={`Reading ${i + 1}`}
            placeholder={i === 2 ? "3rd if needed" : `Reading ${i + 1}`}
            className="input num"
            inputMode="decimal"
            style={{ flex: 1, minWidth: 0 }}
            value={form[k]}
            onChange={set(k)}
          />
        ))}
      </div>
      {check && (
        <span className="small" role="status" style={check.reliability === "agreed" && inRange ? undefined : { color: "var(--warn)" }}>
          {!inRange
            ? `A reading is outside ${HAND_LENGTH_RANGE_MM[0]}-${HAND_LENGTH_RANGE_MM[1]} mm. Check the number and the unit.`
            : check.reliability === "agreed" && readings.length >= 2
              ? "Your readings agree."
              : check.reliability === "single_reading"
                ? "Now measure a second time."
                : `Your readings differ by ${check.spreadMm.toFixed(1)} mm. Measure once more and enter a third reading.`}
        </span>
      )}
      <div className="field">
        <label htmlFor="p-device">Phone model</label>
        <input id="p-device" className="input" value={form.device} onChange={set("device")} placeholder="e.g. Redmi Note 12" maxLength={80} />
      </div>
      {error && (
        <div className="notice notice-error small" role="alert">
          {error}
        </div>
      )}
      <div className="row" style={{ gap: 12 }}>
        <button className="btn" onClick={() => setStep("coin")}>
          Back
        </button>
        <button className="btn btn-primary" disabled={!ready || busy} onClick={() => void save()}>
          Save and start scanning
        </button>
      </div>
      {footer}
    </Page>
  );
}

function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="page stack" style={{ maxWidth: 640, gap: 16 }}>
      <span className="eyebrow">Research pilot</span>
      <h1 style={{ fontSize: "clamp(1.5rem, 5vw, 2rem)" }}>{title}</h1>
      {children}
    </main>
  );
}

function UnitSelect({ unit, onChange }: { unit: LengthUnit; onChange: (e: { target: { value: string } }) => void }) {
  return (
    <div className="row" style={{ gap: 8 }}>
      <label htmlFor="p-unit" className="small">
        Ruler units
      </label>
      <select id="p-unit" aria-label="Unit" className="select" value={unit} onChange={onChange} style={{ minHeight: 36 }}>
        <option value="mm">mm</option>
        <option value="cm">cm</option>
        <option value="in">in</option>
      </select>
    </div>
  );
}
