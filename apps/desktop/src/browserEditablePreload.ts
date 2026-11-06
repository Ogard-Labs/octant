import { contextBridge, webFrame } from "electron";
import {
  BROWSER_EDITABLE_WORLD_ID,
  BROWSER_EDITABLE_WORLD_NAME,
  observeBrowserEditableTarget,
} from "./browserEditableObservation";
import { observeBrowserSelectPopup } from "./browserSelectObservation";

// This preload runs in every frame of Stable's hidden window. The name lets
// Stable find a nested frame's world through the protocol; Electron reaches
// the world by number only in the main frame.
webFrame.setIsolatedWorldInfo(BROWSER_EDITABLE_WORLD_ID, { name: BROWSER_EDITABLE_WORLD_NAME });
contextBridge.exposeInIsolatedWorld(
  BROWSER_EDITABLE_WORLD_ID,
  "octantBrowserEditable",
  observeBrowserEditableTarget(),
);
contextBridge.exposeInIsolatedWorld(
  BROWSER_EDITABLE_WORLD_ID,
  "octantBrowserSelect",
  observeBrowserSelectPopup(),
);
