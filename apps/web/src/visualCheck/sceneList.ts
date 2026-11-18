/**
 * The scenes the visual check draws. Kept apart from the components that draw
 * them so the check, which runs in Node, can read the list without importing
 * a stylesheet.
 */
export interface SceneMeta {
  readonly id: string;
  /** A selector for the control to click once the scene has drawn, for a popup. */
  readonly open?: string;
  /** The scene is also drawn at 760 wide, where its table or panel reflows. */
  readonly narrow?: boolean;
}

export const SCENE_LIST: ReadonlyArray<SceneMeta> = [
  { id: "home" },
  { id: "code-side-panel", narrow: true },
  { id: "settings-appearance" },
  { id: "settings-usage" },
  { id: "agents-table", narrow: true },
  { id: "artifacts-table", narrow: true },
  { id: "automations-table", narrow: true },
  { id: "where-menu", open: "button[aria-label^='Where this thread works']" },
  { id: "project-picker", open: "button[aria-label^='Project:']" },
  { id: "mode-picker", open: "button[aria-haspopup='menu']" },
  { id: "rail" },
];

/** The two window sizes a scene is drawn at. */
export const WIDE = { width: 1280, height: 800 } as const;
export const NARROW = { width: 760, height: 900 } as const;
