// Entry of the EXPERIMENTAL capture page (frontend/experiment/index.html). Not the customer app; not in the production build.
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
// The app's colour tokens, read only (nothing is changed in these files).
import "../../styles.css";
import "../../theme-blue.css";
import { CapturePage } from "./CapturePage";

// No StrictMode: this page owns a camera and workers, and a development double-mount would start and stop them twice.
createRoot(document.getElementById("root")!).render(<CapturePage />);
