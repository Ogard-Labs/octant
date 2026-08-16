import { DEFAULT_PRODUCT_SURFACE_SETTINGS } from "@octant/contracts/modes";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { getInjectedHostBridge } from "./shell/hostBridge";

const root = document.getElementById("root");
if (!root) throw new Error("Octant root element is missing");
const hostBridge = getInjectedHostBridge();

createRoot(root).render(
  <StrictMode>
    <App
      settings={DEFAULT_PRODUCT_SURFACE_SETTINGS}
      {...(hostBridge === undefined ? {} : { hostBridge })}
    />
  </StrictMode>,
);
