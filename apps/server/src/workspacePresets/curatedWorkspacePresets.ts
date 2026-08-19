import { decodeWorkspacePreset, type WorkspacePreset } from "@octant/contracts/workspace-presets";

/**
 * The workspace presets Octant offers out of the box.
 *
 * A preset pins an arrangement, not a capability. Every pane it opens is one
 * the thread could already open for itself, and every skill it names is a
 * suggestion the person acts on or ignores — applying a preset installs
 * nothing, trusts nothing, and enables nothing.
 */
export const CURATED_WORKSPACE_PRESETS: ReadonlyArray<WorkspacePreset> = [
  decodeWorkspacePreset({
    id: "design-studio",
    displayName: "Design studio",
    summary:
      "Front-end design work: the project, a live preview of its dev server, and a side conversation to iterate in.",
    mode: "code",
    // The preview pane is a Browser surface on this thread; the person Opens
    // their running dev server in it, which is what binds it to that one
    // origin. Nothing here names an origin, because the server is not running
    // yet when the preset is applied.
    scaffoldId: "web-app",
    panes: ["code-overview", "browser", "side-chat"],
    defaultSkills: ["frontend-design", "accessibility-review"],
  }),
];
