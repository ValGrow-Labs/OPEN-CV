import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "../../../styles.css";
import "../../../theme-blue.css";
import { ReconPage } from "./ReconPage";

// No StrictMode: the page owns a camera, two workers and a frame loop, which a development double mount would start twice.
createRoot(document.getElementById("root")!).render(<ReconPage />);
