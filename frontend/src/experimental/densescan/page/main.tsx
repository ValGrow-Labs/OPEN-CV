import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "../../../styles.css";
import "../../../theme-blue.css";
import { DenseScanPage } from "./DenseScanPage";

// No StrictMode: this page owns a camera, a segmentation worker and an animation loop, which a development double mount
// would start twice (as the capture prototype's main.tsx explains).
createRoot(document.getElementById("root")!).render(<DenseScanPage />);
