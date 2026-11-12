// The MILLIMESH "Surface Swarm" scan: the live customer scan flow. Seven steps: Start, Select a Reference Coin, Allow Camera
// Access, the three capture screens (Palm, Side, Back) and the 3D Reconstruction. What it hands on is exactly what the old
// scan screen handed on: a ScanResponse from the existing pipeline (measurements, recommendation) for the measurements screen.
import { useCallback, useMemo, useState } from "react";
import type { PublicConfig, ReferenceSelection, ScanResponse } from "../api/types";
import type { ScanTimingBreakdown } from "../scan/scanController";
import { hasSavedReference, markCoinConfirmed, referenceLabel } from "../ui/settings";
import { CaptureStep, type CaptureResult } from "./CaptureStep";
import { fitHand, type FittedHand } from "./fitHand";
import { orderedViews } from "./phases";
import { ReconStep } from "./ReconStep";
import { CameraStep, CoinStep, StartStep } from "./steps";

export type FlowStep = "start" | "coin" | "camera" | "capture" | "recon";

interface Props {
  config: PublicConfig;
  chartId: string;
  reference: ReferenceSelection;
  onChartChange: (id: string) => void;
  onReferenceChange: (sel: ReferenceSelection) => void;
  /** "capture" starts straight at the camera (a rescan: the coin is already chosen). */
  initialStep?: FlowStep;
  onResult: (r: ScanResponse, mirrored: boolean, timing?: ScanTimingBreakdown) => void;
  /** Leave the scan (the close button): back to the start, or to the measurements already on screen. */
  onCancel: () => void;
}

export function MillimeshFlow({ config, chartId, reference, onChartChange, onReferenceChange, initialStep = "start", onResult, onCancel }: Props) {
  const [step, setStep] = useState<FlowStep>(initialStep);
  const [scanKey, setScanKey] = useState(0);
  const [recon, setRecon] = useState<{ result: CaptureResult; fit: FittedHand } | null>(null);
  const views = useMemo(() => orderedViews(config), [config]);
  const diameter = referenceLabel(config, reference).diameter;

  const onDone = useCallback(
    (result: CaptureResult) => {
      // A scan the pipeline refused goes straight to the page that says what to correct: no model is shown for it.
      if (result.response.status === "accepted") {
        const fit = fitHand({ palm: result.frames.palm, side: result.frames.side, back: result.frames.back, referenceDiameterMm: diameter });
        if (fit) {
          setRecon({ result, fit });
          setStep("recon");
          return;
        }
      }
      onResult(result.response, result.mirrored, result.timing);
    },
    [diameter, onResult],
  );

  if (step === "start") {
    return <StartStep config={config} chartId={chartId} onChartChange={onChartChange} onStart={() => setStep("coin")} />;
  }
  if (step === "coin") {
    return (
      <CoinStep
        config={config}
        previous={hasSavedReference() ? reference : null}
        onBack={() => setStep("start")}
        onContinue={(sel) => {
          onReferenceChange(sel);
          markCoinConfirmed(sel);
          setStep("camera");
        }}
      />
    );
  }
  if (step === "camera") {
    return <CameraStep onAllow={() => setStep("capture")} onNotNow={() => setStep("start")} />;
  }
  if (step === "recon" && recon) {
    return (
      <ReconStep
        fit={recon.fit}
        onContinue={() => onResult(recon.result.response, recon.result.mirrored, recon.result.timing)}
        onRescan={() => {
          setRecon(null);
          setScanKey((k) => k + 1);
          setStep("capture");
        }}
      />
    );
  }
  return (
    <CaptureStep
      key={scanKey}
      config={config}
      chartId={chartId}
      reference={reference}
      views={views}
      // A scan opened from the start goes back to the start; a rescan goes back to the screen it came from.
      onCancel={() => (initialStep === "capture" ? onCancel() : setStep("start"))}
      onBack={() => setStep(initialStep === "capture" ? "start" : "camera")}
      onDone={onDone}
    />
  );
}
