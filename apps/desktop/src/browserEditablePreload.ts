import { contextBridge } from "electron";
import {
  BROWSER_EDITABLE_WORLD_ID,
  observeBrowserEditableTarget,
} from "./browserEditableObservation";
import { observeBrowserSelectPopup } from "./browserSelectObservation";

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
