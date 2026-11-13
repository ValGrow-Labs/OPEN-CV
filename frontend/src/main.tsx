import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/fraunces/opsz.css";
import { App } from "./App";
import "./styles.css";
import "./theme-blue.css";
import "./millimesh/millimesh.css";
import "./millimesh/responsive.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
