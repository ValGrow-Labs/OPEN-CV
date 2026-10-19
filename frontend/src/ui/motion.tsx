// Motion helpers. All animation is transform/opacity (or SVG stroke) only, and everything is
// disabled under prefers-reduced-motion (see styles.css). The live camera screen deliberately
// uses almost none of this, so animation never competes with frame processing.
import { ArrowUpRight } from "@phosphor-icons/react";
import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

let observer: IntersectionObserver | null = null;

/** Reveal every not-yet-revealed `[data-reveal]` element as it enters the viewport. */
export function observeReveals(root: ParentNode = document): void {
  const els = root.querySelectorAll<HTMLElement>("[data-reveal]:not(.is-in)");
  if (typeof IntersectionObserver === "undefined" || prefersReducedMotion()) {
    els.forEach((el) => el.classList.add("is-in"));
    return;
  }
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("is-in");
          observer?.unobserve(e.target);
        }
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  els.forEach((el) => observer!.observe(el));
}

/** Stagger index for reveal delays (`--i`). */
export const stagger = (i: number): CSSProperties => ({ ["--i" as string]: i });

const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/** Counts up to a real, already-computed value. Never used for placeholder numbers. */
export function CountUp({ value, decimals = 0, duration = 900, suffix = "" }: { value: number; decimals?: number; duration?: number; suffix?: string }) {
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? value : 0));
  const frame = useRef(0);
  useEffect(() => {
    if (prefersReducedMotion()) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      setShown(value * easeOutExpo(t));
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [value, duration]);
  return (
    <span className="num" data-value={value.toFixed(decimals)}>
      {shown.toFixed(decimals)}
      {suffix}
    </span>
  );
}

/** Heading whose words rise out of a mask, one after another (real spaces keep the text readable). */
export function SplitWords({ text, delay = 0 }: { text: string; delay?: number }) {
  const words = text.split(" ");
  return (
    <span className="split">
      {words.map((w, i) => (
        <Fragment key={i}>
          <span className="split-mask">
            <span className="split-word" style={{ animationDelay: `${delay + i * 70}ms` }}>
              {w}
            </span>
          </span>
          {i < words.length - 1 ? " " : null}
        </Fragment>
      ))}
    </span>
  );
}

/** Trailing icon nested in its own circle ("button-in-button"). */
export function ButtonIcon({ children }: { children?: ReactNode }) {
  return (
    <span className="btn-icon" aria-hidden="true">
      {children ?? <ArrowUpRight size={16} weight="bold" />}
    </span>
  );
}
