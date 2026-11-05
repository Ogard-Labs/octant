import { contextBridge } from "electron";
import {
  BROWSER_EDITABLE_WORLD_ID,
  observeBrowserEditableTarget,
} from "./browserEditableObservation";

contextBridge.exposeInIsolatedWorld(
  BROWSER_EDITABLE_WORLD_ID,
  "octantBrowserEditable",
  observeBrowserEditableTarget(),
);
