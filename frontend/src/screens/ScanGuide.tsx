import { useEffect, useRef, useState } from "react";
import { CoachIcon, GUIDE_STEPS, HandScene, type GuideStage } from "../ui/guide";
import { ButtonIcon } from "../ui/motion";

interface Props {
  /** "intro" runs before the camera starts; "help" re-opens the tips during a scan. */
  mode: "intro" | "help";
  referenceLabel: string;
  onDone: () => void;
}

interface Slide {
  title: string;
  stage: GuideStage | null;
  tips: string[];
}

export function ScanGuide({ mode, referenceLabel, onDone }: Props) {
  const slides: Slide[] = [
    {
      title: "Before you start",
      stage: null,
      tips: [],
    },
    {
      title: GUIDE_STEPS[0].title,
      stage: 0,
      tips: [
        "Palm towards the camera, fingers straight and together.",
        "Keep your whole hand and wrist inside the outline.",
        "About 30-40 cm (12-16 in) from the camera works well.",
      ],
    },
    {
      title: GUIDE_STEPS[1].title,
      stage: 1,
      tips: ["Lay the coin flat in the middle of your palm.", "The whole coin edge must be visible.", "Avoid shiny glare on the coin."],
    },
    {
      title: GUIDE_STEPS[2].title,
      stage: 2,
      tips: [
        "Hold still for about 3 seconds while the bar fills.",
        "If something needs fixing, the tip at the top tells you how.",
        mode === "intro"
          ? "Your browser will now ask for camera access. Video stays on this device."
          : "Collection restarts when you return to the scan.",
      ],
    },
  ];
  const [i, setI] = useState(0);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const last = i === slides.length - 1;
  const slide = slides[i];

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, [i]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight" && !last) setI(i + 1);
    else if (e.key === "ArrowLeft" && i > 0) setI(i - 1);
    else if (e.key === "Escape") onDone();
  };

  return (
    <div className="guide-overlay" role="dialog" aria-modal="true" aria-labelledby="guide-title" onKeyDown={onKey}>
      <div className="guide-card">
        <div className="guide-head">
          <span className="eyebrow-pill">{mode === "intro" ? "Quick guide" : "Scan tips"}</span>
          <button className="link small guide-skip" onClick={onDone}>
            {mode === "intro" ? "Skip guide" : "Close"}
          </button>
        </div>

        <div key={i} className="guide-body">
          {slide.stage === null ? (
            <ul className="guide-needs" aria-label="What you need">
              <li>
                <CoachIcon kind="coin" />
                <span>
                  <strong>A coin</strong>
                  <span>{referenceLabel}</span>
                </span>
              </li>
              <li>
                <CoachIcon kind="light" />
                <span>
                  <strong>Good, even light</strong>
                  <span>Face a window or lamp; avoid strong light behind you.</span>
                </span>
              </li>
              <li>
                <CoachIcon kind="still" />
                <span>
                  <strong>About a minute</strong>
                  <span>Prop up your phone or laptop so one hand is free.</span>
                </span>
              </li>
            </ul>
          ) : (
            <HandScene stage={slide.stage} className="guide-scene" />
          )}
          <div className="stack" style={{ gap: 10 }}>
            <h2 id="guide-title" ref={titleRef} tabIndex={-1}>
              {slide.title}
            </h2>
            {slide.tips.length > 0 && (
              <ul className="guide-tips">
                {slide.tips.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="guide-foot">
          <div className="guide-dots" aria-label={`Page ${i + 1} of ${slides.length}`}>
            {slides.map((_, k) => (
              <button
                key={k}
                className={`guide-dot ${k === i ? "is-active" : ""}`}
                aria-label={`Go to page ${k + 1}`}
                aria-current={k === i ? "step" : undefined}
                onClick={() => setI(k)}
              />
            ))}
          </div>
          <div className="row" style={{ gap: 8 }}>
            {i > 0 && (
              <button className="btn" onClick={() => setI(i - 1)}>
                Back
              </button>
            )}
            {last ? (
              <button className="btn btn-primary btn-island" onClick={onDone}>
                {mode === "intro" ? "Start camera" : "Back to scan"}
                <ButtonIcon />
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => setI(i + 1)}>
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
