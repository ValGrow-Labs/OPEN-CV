import { useCallback, useEffect, useState } from "react";
import { ApiError, fetchConfig, fetchRecommendation } from "./api/client";
import type { Measurement, PublicConfig, Recommendation, ReferenceSelection, ScanResponse } from "./api/types";
import { CalibrationScreen } from "./screens/CalibrationScreen";
import { MeasurementsScreen, type ManualEntries } from "./screens/MeasurementsScreen";
import { PilotScreen } from "./screens/PilotScreen";

const MANUAL_LABELS: Record<keyof ManualEntries, string> = {
  hand_length_mm: "Hand length",
  hand_circumference_mm: "Hand circumference",
  palm_breadth_mm: "Palm breadth (skin edge to skin edge)",
};
import { ResultsScreen } from "./screens/ResultsScreen";
import { preloadScanTools, type ScanTimingBreakdown } from "./scan/scanController";
import { ScanScreen } from "./screens/ScanScreen";
import { ValidationScreen } from "./screens/ValidationScreen";
import { WelcomeScreen } from "./screens/WelcomeScreen";
import { BrandMark } from "./ui/components";
import { observeReveals } from "./ui/motion";
import { loadChart, loadReference, saveChart, saveReference } from "./ui/settings";

type Screen = "welcome" | "scan" | "measurements" | "results" | "calibration" | "validation";

const HASH_SCREENS: Record<string, Screen> = { "#/calibration": "calibration", "#/validation": "validation" };
const hashScreen = (): Screen | undefined => HASH_SCREENS[window.location.hash];
// Remote pilot invite links: #/pilot/<token>. The token stays in the fragment, which browsers never send to servers.
const pilotTokenFromHash = (): string | null =>
  window.location.hash.startsWith("#/pilot/") ? decodeURIComponent(window.location.hash.slice("#/pilot/".length)) || null : null;

export function App() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>(hashScreen() ?? "welcome");
  const [pilotToken, setPilotToken] = useState(pilotTokenFromHash);
  const [chartId, setChartId] = useState("");
  const [reference, setReference] = useState<ReferenceSelection>({});
  const [result, setResult] = useState<ScanResponse | null>(null);
  const [scanTiming, setScanTiming] = useState<ScanTimingBreakdown | null>(null);
  const [mirrored, setMirrored] = useState(false);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [extra, setExtra] = useState<Measurement[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanKey, setScanKey] = useState(0);

  const loadConfig = useCallback(() => {
    setConfigError(null);
    fetchConfig()
      .then((c) => {
        setConfig(c);
        setChartId(loadChart(c));
        setReference(loadReference(c));
      })
      .catch((e) => setConfigError(e instanceof ApiError ? e.message : "Could not load the sizing service."));
  }, []);

  useEffect(loadConfig, [loadConfig]);

  // The server sleeps when idle; say so if the first request is slow.
  const [waking, setWaking] = useState(false);
  useEffect(() => {
    if (config || configError) {
      setWaking(false);
      return;
    }
    const t = setTimeout(() => setWaking(true), 4000);
    return () => clearTimeout(t);
  }, [config, configError]);

  // Fetch and start the measuring tools (OpenCV.js, the hand model) in the background soon after
  // the page opens, so a scan starts at once instead of waiting for them after "Start camera".
  useEffect(() => {
    if (!config) return;
    const id = window.setTimeout(() => preloadScanTools("scan"), 1500);
    return () => window.clearTimeout(id);
  }, [config]);

  useEffect(() => {
    const onHash = () => {
      setScreen(hashScreen() ?? "welcome");
      setPilotToken(pilotTokenFromHash());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Move focus to the new screen's heading so keyboard and screen-reader users follow along.
  useEffect(() => {
    window.scrollTo(0, 0);
    const h1 = document.querySelector<HTMLElement>("main h1");
    if (h1) {
      h1.setAttribute("tabindex", "-1");
      h1.focus({ preventScroll: true });
    }
  }, [screen, config]);

  // Scroll-reveal any newly rendered [data-reveal] elements.
  useEffect(() => {
    observeReveals();
  });

  const startScan = () => {
    setResult(null);
    setScanTiming(null);
    setRecommendation(null);
    setExtra([]);
    setError(null);
    setScanKey((k) => k + 1);
    setScreen("scan");
  };

  const goHome = () => {
    if (hashScreen()) window.location.hash = "";
    setScreen("welcome");
  };

  const onContinue = async (entries: ManualEntries) => {
    if (!config || !result) return;
    setError(null);
    const keys = Object.keys(entries) as (keyof ManualEntries)[];
    if (keys.length === 0) {
      setExtra([]);
      setRecommendation(result.recommendation);
      setScreen("results");
      return;
    }
    // Tape measurements replace the camera estimate of the same quantity for sizing.
    const manual: Measurement[] = keys.map((key) => ({
      key,
      label: MANUAL_LABELS[key],
      value_mm: Math.round(entries[key]! * 10) / 10,
      uncertainty_mm: config.manual_measurement_sd_mm,
      interval95_mm: null,
      status: "user_entered",
      source: "user_entered",
      method: "Entered by the customer (ruler or tape measure)",
      definition: MANUAL_LABELS[key],
      calibrated: false,
      frames_used: 0,
      uncertainty_components_mm: {},
      reasons: [],
    }));
    const inputs = [...result.measurements.filter((m) => m.value_mm !== null && !keys.includes(m.key as keyof ManualEntries)), ...manual].map(
      (m) => ({ key: m.key, value_mm: m.value_mm!, uncertainty_mm: m.uncertainty_mm ?? 0, status: m.status }),
    );
    setBusy(true);
    try {
      setRecommendation(await fetchRecommendation(chartId, inputs));
      setExtra(manual);
      setScreen("results");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not calculate your size.");
    } finally {
      setBusy(false);
    }
  };

  if (!config) {
    return (
      <div className="app">
        <Header onHome={goHome} />
        <main className="page stack" style={{ maxWidth: 560 }}>
          {configError ? (
            <div className="card stack" role="alert">
              <h1 style={{ fontSize: "1.5rem" }}>The sizing service is unavailable</h1>
              <p className="muted">{configError}</p>
              <div>
                <button className="btn btn-primary" onClick={loadConfig}>
                  Try again
                </button>
              </div>
            </div>
          ) : (
            <p className="muted">{waking ? "Waking up the sizing service. The first visit can take up to a minute." : "Loading…"}</p>
          )}
        </main>
      </div>
    );
  }

  const chart = config.charts.find((c) => c.chart_id === chartId) ?? config.charts[0];

  if (pilotToken) {
    return (
      <div className="app">
        <header className="topbar">
          <span className="brand">
            <BrandMark />
            Glove Size Finder
          </span>
        </header>
        <PilotScreen config={config} token={pilotToken} />
      </div>
    );
  }

  return (
    <div className="app">
      {screen !== "scan" && <Header onHome={goHome} />}
      {screen === "welcome" && (
        <WelcomeScreen
          config={config}
          chartId={chart.chart_id}
          reference={reference}
          onChartChange={(id) => {
            setChartId(id);
            saveChart(id);
          }}
          onReferenceChange={(sel) => {
            setReference(sel);
            saveReference(sel);
          }}
          onStart={startScan}
        />
      )}
      {screen === "scan" && (
        <ScanScreen
          key={scanKey}
          config={config}
          chartId={chart.chart_id}
          reference={reference}
          views={config.capture.views}
          onCancel={() => setScreen(result ? "measurements" : "welcome")}
          onReferenceConfirm={(sel) => {
            setReference(sel);
            saveReference(sel);
          }}
          onResult={(r, m, t) => {
            setResult(r);
            setMirrored(m);
            setScanTiming(t ?? null);
            setRecommendation(r.recommendation);
            setScreen("measurements");
          }}
        />
      )}
      {screen === "measurements" && result && (
        <MeasurementsScreen
          config={config}
          chart={chart}
          result={result}
          mirrored={mirrored}
          scanTiming={scanTiming}
          onRescan={startScan}
          onContinue={(m) => void onContinue(m)}
          busy={busy}
          error={error}
        />
      )}
      {screen === "results" && result && recommendation && (
        <ResultsScreen
          recommendation={recommendation}
          result={result}
          extraMeasurements={extra}
          onRescan={startScan}
          onBack={() => setScreen("measurements")}
          onStartOver={goHome}
        />
      )}
      {screen === "validation" && (
        <ValidationScreen config={config} chartId={chart.chart_id} reference={reference} onClose={goHome} />
      )}
      {screen === "calibration" && (
        <CalibrationScreen
          config={config}
          reference={reference}
          onSave={(sel) => {
            setReference(sel);
            saveReference(sel);
          }}
          onClose={goHome}
        />
      )}
      {screen !== "scan" && (
        <footer className="footer">
          <span>
            {config.calibration_validated ? "Camera-based estimate" : "Unvalidated prototype · camera-based estimate"} · not a
            guarantee of fit
          </span>
          <span className="row" style={{ gap: 16 }}>
            {screen !== "calibration" && <a href="#/calibration">Operator calibration</a>}
            {config.validation_mode_enabled && screen !== "validation" && <a href="#/validation">Validation</a>}
          </span>
        </footer>
      )}
    </div>
  );
}

function Header({ onHome }: { onHome: () => void }) {
  return (
    <header className="topbar">
      <button className="brand link" style={{ textDecoration: "none", color: "inherit" }} onClick={onHome}>
        <BrandMark />
        Glove Size Finder
      </button>
    </header>
  );
}
