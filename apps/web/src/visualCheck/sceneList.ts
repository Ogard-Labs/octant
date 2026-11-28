/**
 * The scenes the visual check draws. Kept apart from the components that draw
 * them so the check, which runs in Node, can read the list without importing
 * a stylesheet.
 */
export interface SceneMeta {
  readonly id: string;
  /** A selector for the control to click once the scene has drawn, for a popup. */
  readonly open?: string;
  /** A selector for the part of a long scene the picture should show, scrolled into view. */
  readonly scrollTo?: string;
  /** The scene is also drawn at 760 wide, where its table or panel reflows. */
  readonly narrow?: boolean;
  /**
   * How far a colour channel may move before a pixel counts as changed, when
   * the scene needs a finer eye than the check's default. The ground scenes
   * do: the ASCII field inks at most 38 of 255 and sits under a half-opacity
   * backdrop, so clearing it moves a pixel by about 19, inside the default.
   */
  readonly tolerance?: number;
}

/** A pixel differs when any colour channel is off by more than this. */
export const CHANNEL_TOLERANCE = 24;

/**
 * The ground scenes' tolerance. Their baselines are drawn on the same CI
 * runner that checks them, and two runs of the same ground differ by at most
 * 1 per channel, so 6 leaves room for that and still sees a faint field go.
 */
export const GROUND_TOLERANCE = 6;

export const SCENE_LIST: ReadonlyArray<SceneMeta> = [
  {
    id: "qa-remote-access",
    narrow: true,
    scrollTo: '[aria-label="Pause remote access"]',
  },
  {
    id: "qa-remote-access-paused",
    narrow: true,
    scrollTo: '[aria-label="Pause remote access"]',
  },
  { id: "qa-paired-devices", narrow: true },
  {
    id: "qa-paired-devices-confirm",
    narrow: true,
    open: "div.flex.flex-wrap.items-center.gap-1 > button:nth-last-child(2)",
  },
  { id: "qa-device-self-read-only", narrow: true },
  { id: "qa-device-self-full", narrow: true },
  { id: "home" },
  { id: "first-run", narrow: true },
  { id: "code-side-panel", narrow: true },
  { id: "settings-appearance" },
  {
    id: "settings-background-custom",
    open: ".settings-app-background__customize > summary",
  },
  { id: "settings-usage" },
  { id: "settings-usage-history", narrow: true },
  { id: "dock-artifacts" },
  { id: "dock-artifacts-tiled" },
  { id: "agents-table", narrow: true },
  { id: "artifacts-table", narrow: true },
  { id: "automations-table", narrow: true },
  { id: "where-menu", open: "button[aria-label^='Where this thread works']" },
  { id: "project-picker", open: "button[aria-label^='Project:']" },
  { id: "mode-picker", open: "button[aria-haspopup='menu']" },
  { id: "rail" },
  { id: "rail-beside", open: "button[aria-label^='Account menu']" },
  { id: "subagent-progress", narrow: true },
  // The application ground under the sidebar and a workspace column; see
  // groundScenes.tsx for what each one covers.
  { id: "ground-builtin", tolerance: GROUND_TOLERANCE },
  { id: "ground-builtin-everywhere-strong", tolerance: GROUND_TOLERANCE },
  { id: "ground-builtin-pixelate", tolerance: GROUND_TOLERANCE },
  { id: "ground-builtin-dither-subtle", tolerance: GROUND_TOLERANCE },
  { id: "ground-builtin-ascii", tolerance: GROUND_TOLERANCE },
  { id: "ground-photo", tolerance: GROUND_TOLERANCE },
  { id: "ground-photo-everywhere-subtle-tint", tolerance: GROUND_TOLERANCE },
  { id: "ground-photo-pixelate", tolerance: GROUND_TOLERANCE },
  { id: "ground-photo-dither-strong", tolerance: GROUND_TOLERANCE },
  { id: "ground-photo-ascii-strong-tint", tolerance: GROUND_TOLERANCE },
  { id: "ground-characters", tolerance: GROUND_TOLERANCE },
  { id: "ground-characters-everywhere", tolerance: GROUND_TOLERANCE },
  { id: "ground-characters-subtle", tolerance: GROUND_TOLERANCE },
  { id: "ground-characters-everywhere-strong-tint", tolerance: GROUND_TOLERANCE },
  { id: "ground-pixels", tolerance: GROUND_TOLERANCE },
  { id: "ground-pixels-ridges-pixelate-everywhere", tolerance: GROUND_TOLERANCE },
  { id: "ground-pixels-burst-strong", tolerance: GROUND_TOLERANCE },
  { id: "ground-pixels-picture-subtle", tolerance: GROUND_TOLERANCE },
  { id: "ground-flowing", tolerance: GROUND_TOLERANCE },
  { id: "ground-flowing-everywhere-subtle", tolerance: GROUND_TOLERANCE },
  { id: "ground-none", tolerance: GROUND_TOLERANCE },
  { id: "ground-none-strong", tolerance: GROUND_TOLERANCE },
  { id: "ground-none-subtle-tint-floor", tolerance: GROUND_TOLERANCE },
  { id: "ground-reduced-transparency", tolerance: GROUND_TOLERANCE },
  { id: "ground-increased-contrast", tolerance: GROUND_TOLERANCE },
];

/** The two window sizes a scene is drawn at. */
export const WIDE = { width: 1280, height: 800 } as const;
export const NARROW = { width: 760, height: 900 } as const;

export type UpdateMode = "off" | "changed" | "all";

/**
 * Whether the visual check writes baselines. Only the exact words turn it on:
 * CI passes an empty string on a run that must compare, and an empty string
 * (or anything else) once wrote baselines and let a changed screen pass.
 */
export function updateMode(value: string | undefined): UpdateMode {
  if (value === "1") return "changed";
  if (value === "all") return "all";
  return "off";
}

/** One picture the check takes: a scene, in one scheme, at one window size. */
export interface VisualShot {
  readonly name: string;
  readonly scene: string;
  readonly scheme: "light" | "dark";
  readonly size: { readonly width: number; readonly height: number };
  /** How far a colour channel may move before a pixel counts as changed. */
  readonly tolerance: number;
}

/** Every picture the check takes, each with the tolerance it is compared at. */
export function visualShots(): ReadonlyArray<VisualShot> {
  return SCENE_LIST.flatMap((scene) =>
    (["light", "dark"] as const).flatMap((scheme) =>
      [WIDE, ...(scene.narrow === true ? [NARROW] : [])].map((size) => ({
        name: `${scene.id}-${scheme}-${String(size.width)}`,
        scene: scene.id,
        scheme,
        size,
        tolerance: scene.tolerance ?? CHANNEL_TOLERANCE,
      })),
    ),
  );
}
