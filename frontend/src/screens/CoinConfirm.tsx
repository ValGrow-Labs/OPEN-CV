import { Coin } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { PublicConfig, ReferenceSelection } from "../api/types";
import { ButtonIcon } from "../ui/motion";
import { customerCoins, referenceLabel } from "../ui/settings";

interface Props {
  config: PublicConfig;
  reference: ReferenceSelection;
  onConfirm: (sel: ReferenceSelection) => void;
  onCancel: () => void;
}

const MM_PER_INCH = 25.4;

/**
 * Explicit reference confirmation before every scan session. The coin sets the scale for
 * every measurement, and the camera cannot tell a quarter from a nickel or a button, so the
 * customer must say which coin they are holding.
 */
export function CoinConfirm({ config, reference, onConfirm, onCancel }: Props) {
  const refs = customerCoins(config);
  const custom = reference.custom_diameter_mm !== undefined ? referenceLabel(config, reference) : null;
  const [choice, setChoice] = useState<string>(custom ? "custom" : (reference.object_id ?? config.reference_objects.default));
  const [sizeChecked, setSizeChecked] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const chosen = refs.find((o) => o.id === choice);
  const needsSizeCheck = Boolean(chosen?.size_check);

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  const confirm = () => {
    if (choice === "custom" && custom) onConfirm(reference);
    else onConfirm(needsSizeCheck ? { object_id: choice, size_checked: true } : { object_id: choice });
  };

  return (
    <div className="guide-overlay" role="dialog" aria-modal="true" aria-labelledby="coin-title">
      <div className="guide-card">
        <div className="guide-head">
          <span className="eyebrow-pill">Before you scan</span>
          <button className="link small guide-skip" onClick={onCancel}>
            Cancel
          </button>
        </div>
        <div className="stack" style={{ gap: 10 }}>
          <h2 id="coin-title" ref={titleRef} tabIndex={-1} className="confirm-title">
            Which coin are you holding?
          </h2>
          <p className="muted">
            The coin is the ruler for every measurement. A different coin gives wrong sizes, so check it before you scan.
          </p>
        </div>
        <div className="product-options" role="radiogroup" aria-labelledby="coin-title">
          {refs.map((o) => (
            <label key={o.id} className={`product-option ${choice === o.id ? "is-selected" : ""}`}>
              <input
                type="radio"
                name="coin"
                className="visually-hidden"
                value={o.id}
                checked={choice === o.id}
                onChange={() => {
                  setChoice(o.id);
                  setSizeChecked(false);
                }}
              />
              <span className="po-text">
                <strong>{o.label}</strong>
                <span className="po-maker">
                  {o.diameter_mm.toFixed(2)} mm ({(o.diameter_mm / MM_PER_INCH).toFixed(3)} in) across
                </span>
                {o.customer_hint && <span className="po-maker">{o.customer_hint}</span>}
              </span>
              <Coin className="po-check" size={22} weight="fill" aria-hidden="true" />
            </label>
          ))}
          {custom && (
            <label className={`product-option ${choice === "custom" ? "is-selected" : ""}`}>
              <input type="radio" name="coin" className="visually-hidden" value="custom" checked={choice === "custom"} onChange={() => setChoice("custom")} />
              <span className="po-text">
                <strong>{custom.label}</strong>
                <span className="po-maker">{custom.diameter.toFixed(2)} mm, set by an operator</span>
              </span>
              <Coin className="po-check" size={22} weight="fill" aria-hidden="true" />
            </label>
          )}
        </div>
        {refs.length === 1 && !custom && <p className="small muted">Other coins are not supported yet.</p>}
        {needsSizeCheck && chosen && (
          <label className="radio-row">
            <input type="checkbox" checked={sizeChecked} onChange={(e) => setSizeChecked(e.target.checked)} />
            <span>I checked: my coin is {chosen.diameter_mm} mm across (for example against a ruler).</span>
          </label>
        )}
        <div className="guide-foot">
          <span />
          <button className="btn btn-primary btn-island" onClick={confirm} disabled={needsSizeCheck && !sizeChecked}>
            Yes, this is my coin
            <ButtonIcon />
          </button>
        </div>
      </div>
    </div>
  );
}
