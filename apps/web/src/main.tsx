import { DEFAULT_PRODUCT_SURFACE_SETTINGS } from "@octant/contracts/modes";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IconDefaults } from "./ui/IconDefaults";
import { App } from "./App";
import { followInputModality } from "./lib/inputModality";
import { getInjectedHostBridge } from "./shell/hostBridge";
import { applyRememberedThemeMode } from "./theme/firstPaintTheme";
import { followSystemIncreasedContrast } from "./theme/increasedContrastAttribute";

const root = document.getElementById("root");
if (!root) throw new Error("Octant root element is missing");
const hostBridge = getInjectedHostBridge();
// Before the first render: screens ahead of the settings provider still honour
// the system contrast preference.
followSystemIncreasedContrast();
applyRememberedThemeMode();
followInputModality();

createRoot(root).render(
  <StrictMode>
    <IconDefaults>
      <App
        settings={DEFAULT_PRODUCT_SURFACE_SETTINGS}
        {...(hostBridge === undefined ? {} : { hostBridge })}
      />
    </IconDefaults>
  </StrictMode>,
);
