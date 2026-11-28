import {
  decodeAppBackground,
  DEFAULT_THEME_SETTINGS,
  type SidebarVibrancyMode,
  type ThemeSettings,
} from "@octant/contracts/theme";
import { decodeWindowId } from "@octant/contracts/shell";
import { defaultShellSettings, defaultWindowWorkspace } from "@octant/domain/shell-policy";
import {
  enforceSidebarBackgroundAccessibility,
  resolveAppBackground,
  type ResolvedAppBackground,
} from "@octant/domain/theme-policy";
import type { ReactNode } from "react";
import { AgentsCenter } from "../agents/AgentsCenter";
import { ProjectSidebarSection } from "../projects/ProjectSidebarSection";
import { ShellFrame } from "../shell/ShellFrame";
import { ShellSidebar } from "../shell/ShellSidebar";
import { usePrefersReducedMotion } from "../shell/useShellPresentation";
import { AppBackdrop } from "../theme/AppBackdrop";
import { PlanUsageProvider } from "../usage/PlanUsageContext";
import {
  agentRunClient,
  CODE_PROJECT,
  planUsageClient,
  RAIL_ACCOUNTS,
  SIDEBAR_THREADS,
  VISUAL_NOW,
} from "./fixtures";

/**
 * The application ground under a slice of the shell: the sidebar column and
 * one workspace column, a start screen or a destination page, each set the way
 * the window sets it for that ground, Glass level and Tint, so a change that
 * blurs, recolours, covers or resizes a ground or its coat shows in the
 * picture. Each ground is drawn once in each scheme; together they reach every
 * background, effect, Glass level, Tint, both scopes, and the two
 * accessibility fallbacks, without drawing the whole cross product.
 */

const noop = (): void => undefined;

const WINDOW_ID = "00000000-0000-4000-8000-000000000301";

/** The photo a person uploaded, read from a picture that ships in the repo. */
const PHOTO_ID = "00000000-0000-4000-8000-000000000901";
const PHOTO_URL = "zen-backgrounds/nordic-fjord-aurora.jpg";
const photoFetcher = async (): Promise<Blob> => {
  const response = await fetch(PHOTO_URL);
  if (!response.ok) throw new Error("The fixture photo could not be read.");
  return response.blob();
};

/**
 * The desktop a Glass window shows through: a stand-in picture where the
 * native material would show the person's desktop. The stylesheet draws it
 * (see visualCheck.css); these are the same files, decoded before the picture.
 */
const DESKTOP_URL = {
  dark: "zen-backgrounds/soft-sunset.jpg",
  light: "zen-backgrounds/soft-sunset-light.jpg",
};

type Glass = SidebarVibrancyMode;

interface Ground {
  readonly id: string;
  /** The stored application ground, as Settings would save it. */
  readonly background: Readonly<Record<string, unknown>>;
  readonly glass: Glass;
  /** A Tint the person set; absent, the Glass level's own coat. */
  readonly tint?: number;
  /** What the workspace column shows: the start screen, or a destination page. */
  readonly column: "start" | "page";
  readonly reducedTransparency?: boolean;
  readonly increasedContrast?: boolean;
}

const welcome = { scope: "welcome" } as const;
const everywhere = { scope: "everywhere" } as const;

const GROUNDS: ReadonlyArray<Ground> = [
  // A built-in picture, plain and through each effect.
  {
    id: "ground-builtin",
    background: { kind: "builtin", presetId: "soft-glow", ...welcome },
    glass: "off",
    column: "start",
  },
  {
    id: "ground-builtin-everywhere-strong",
    background: { kind: "builtin", presetId: "lofoten-night", ...everywhere },
    glass: "strong",
    column: "page",
  },
  {
    id: "ground-builtin-pixelate",
    background: { kind: "builtin", presetId: "lofoten-night", effect: "pixelate", ...welcome },
    glass: "off",
    column: "start",
  },
  {
    id: "ground-builtin-dither-subtle",
    background: { kind: "builtin", presetId: "lofoten-night", effect: "dither", ...everywhere },
    glass: "subtle",
    column: "start",
  },
  {
    id: "ground-builtin-ascii",
    background: { kind: "builtin", presetId: "lofoten-night", effect: "ascii", ...everywhere },
    glass: "off",
    column: "page",
  },
  // A person's photo.
  {
    id: "ground-photo",
    background: { kind: "photo", backgroundId: PHOTO_ID, effect: "none", ...welcome },
    glass: "off",
    column: "start",
  },
  {
    id: "ground-photo-everywhere-subtle-tint",
    background: { kind: "photo", backgroundId: PHOTO_ID, effect: "none", ...everywhere },
    glass: "subtle",
    tint: 55,
    column: "page",
  },
  {
    id: "ground-photo-pixelate",
    background: { kind: "photo", backgroundId: PHOTO_ID, effect: "pixelate", ...everywhere },
    glass: "off",
    column: "start",
  },
  {
    id: "ground-photo-dither-strong",
    background: { kind: "photo", backgroundId: PHOTO_ID, effect: "dither", ...welcome },
    glass: "strong",
    column: "start",
  },
  {
    id: "ground-photo-ascii-strong-tint",
    background: { kind: "photo", backgroundId: PHOTO_ID, effect: "ascii", ...welcome },
    glass: "strong",
    tint: 82,
    column: "start",
  },
  // The ASCII field of characters.
  {
    id: "ground-characters",
    background: { kind: "characters", ...welcome },
    glass: "off",
    column: "start",
  },
  {
    id: "ground-characters-everywhere",
    background: { kind: "characters", ...everywhere },
    glass: "off",
    column: "start",
  },
  {
    id: "ground-characters-subtle",
    background: { kind: "characters", ...welcome },
    glass: "subtle",
    column: "start",
  },
  {
    id: "ground-characters-everywhere-strong-tint",
    background: { kind: "characters", ...everywhere },
    glass: "strong",
    tint: 64,
    column: "start",
  },
  // The pixel ground, each scene, in its two prints.
  {
    id: "ground-pixels",
    background: { kind: "pixels", scene: "drift", ...welcome },
    glass: "off",
    column: "start",
  },
  {
    id: "ground-pixels-ridges-pixelate-everywhere",
    background: { kind: "pixels", scene: "ridges", effect: "pixelate", ...everywhere },
    glass: "off",
    column: "page",
  },
  {
    id: "ground-pixels-burst-strong",
    background: { kind: "pixels", scene: "burst", effect: "dither", ...welcome },
    glass: "strong",
    column: "start",
  },
  {
    id: "ground-pixels-picture-subtle",
    background: {
      kind: "pixels",
      scene: "picture",
      backgroundId: PHOTO_ID,
      effect: "dither",
      ...everywhere,
    },
    glass: "subtle",
    column: "start",
  },
  // Flowing colour.
  {
    id: "ground-flowing",
    background: { kind: "flowing", ...welcome },
    glass: "off",
    column: "start",
  },
  {
    id: "ground-flowing-everywhere-subtle",
    background: { kind: "flowing", ...everywhere },
    glass: "subtle",
    column: "page",
  },
  // No ground: the plain page, and Glass alone.
  {
    id: "ground-none",
    background: { kind: "none" },
    glass: "off",
    column: "start",
  },
  {
    id: "ground-none-strong",
    background: { kind: "none" },
    glass: "strong",
    column: "page",
  },
  {
    // Below the floor: the coat is clamped to it, whatever Tint says.
    id: "ground-none-subtle-tint-floor",
    background: { kind: "none" },
    glass: "subtle",
    tint: 20,
    column: "start",
  },
  // The fallbacks a person or the system can ask for.
  {
    id: "ground-reduced-transparency",
    background: { kind: "characters", ...everywhere },
    glass: "strong",
    column: "start",
    reducedTransparency: true,
  },
  {
    id: "ground-increased-contrast",
    background: { kind: "builtin", presetId: "lofoten-night", ...welcome },
    glass: "subtle",
    column: "start",
    increasedContrast: true,
  },
];

function groundTheme(ground: Ground, plain: ThemeSettings): ThemeSettings {
  return {
    ...plain,
    reducedTransparency: ground.reducedTransparency === true,
    increasedContrast: ground.increasedContrast === true,
    appBackground: decodeAppBackground(ground.background),
    sidebarBackground: { ...plain.sidebarBackground, vibrancyMode: ground.glass },
    ...(ground.tint === undefined ? {} : { glassTint: ground.tint }),
  };
}

/** Resolves once `selector` matches, or fails the picture after a few seconds. */
async function drawn(selector: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (document.querySelector(selector) === null) {
    if (performance.now() > deadline) throw new Error(`Nothing matched ${selector} in time.`);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

async function decoded(url: string): Promise<void> {
  const image = new Image();
  image.src = new URL(url, document.baseURI).href;
  await image.decode();
}

function lightPage(): boolean {
  return document.documentElement.dataset.octantThemeMode === "light";
}

/** Waits for what the ground draws after the first render: a picture or a canvas. */
async function groundSettled(ground: Ground, resolved: ResolvedAppBackground): Promise<void> {
  if (hostGlass(ground)) await decoded(lightPage() ? DESKTOP_URL.light : DESKTOP_URL.dark);
  if (resolved.kind === "builtin" && resolved.effect.kind === "none") {
    const url = lightPage()
      ? (resolved.backgroundLightUrl ?? resolved.backgroundUrl)
      : resolved.backgroundUrl;
    if (url !== null) await decoded(url);
  } else if (resolved.kind === "builtin" || resolved.kind === "photo") {
    await drawn(".app-backdrop__photo[data-photo-ready='true']");
  } else if (resolved.kind === "characters") {
    await drawn(".app-backdrop__characters[data-ready='true']");
  } else if (resolved.kind === "pixels") {
    await drawn(".app-backdrop__pixels[data-ready='true']");
  } else if (resolved.kind === "flowing") {
    await drawn(".app-backdrop__flowing[data-engine]");
  }
}

/**
 * The settings the window draws from: the accessible draft, as the app makes
 * it. Neither the ground nor the Glass level it keeps depends on the scheme,
 * so the plain settings stand in for the scene's own.
 */
function accessibleTheme(ground: Ground): ThemeSettings {
  return enforceSidebarBackgroundAccessibility(groundTheme(ground, DEFAULT_THEME_SETTINGS));
}

function resolvedGround(ground: Ground, reducedMotion: boolean): ResolvedAppBackground {
  return resolveAppBackground(accessibleTheme(ground), reducedMotion);
}

/**
 * Whether the host confirms Glass. The window asks for the level the
 * accessible draft keeps, and the host turns its material on for any level but
 * Off; Reduce transparency sets it Off, so the host leaves the window opaque.
 */
function hostGlass(ground: Ground): boolean {
  return accessibleTheme(ground).sidebarBackground.vibrancyMode !== "off";
}

const PROFILE = { ...defaultShellSettings().userProfile, displayName: "Ada Lovelace" };

function Sidebar(props: { readonly nativeHost: boolean; readonly coveredByWorkspace: boolean }) {
  const actions = {
    "new-code-thread": noop,
    inbox: noop,
    "thread-board": noop,
    "pull-requests": noop,
    projects: noop,
    plugins: noop,
  };
  return (
    <ShellSidebar
      backgroundCoveredByWorkspace={props.coveredByWorkspace}
      codeNavigation={{ actions }}
      inboxCount={3}
      nativeHost={props.nativeHost}
      onAddFolder={noop}
      onOpenArchive={noop}
      onOpenNavigator={noop}
      onOpenSettings={noop}
      onSelectMode={noop}
      projectSection={
        <ProjectSidebarSection
          activityMode="code"
          archivedProjects={[]}
          availabilityByProject={new Map()}
          now={new Date(VISUAL_NOW)}
          onArchive={noop}
          onMove={noop}
          onProjectOpen={noop}
          onReorder={noop}
          onRestore={noop}
          onSelectThread={noop}
          projects={[CODE_PROJECT]}
          threads={SIDEBAR_THREADS}
        />
      }
      settings={{ ...defaultShellSettings(), userProfile: PROFILE }}
      settingsShortcut="⌘,"
      workspace={{ ...defaultWindowWorkspace(decodeWindowId(WINDOW_ID)), activeMode: "code" }}
    />
  );
}

/**
 * The workspace column the way the window builds it around one pane: a start
 * screen on the welcome stage when the ground is shown behind start screens,
 * or a destination page over the hidden workspace.
 */
function Column(props: {
  readonly ground: Ground;
  readonly resolved: ResolvedAppBackground;
  readonly start: ReactNode;
}) {
  const onStage = props.resolved.kind !== "none" && props.resolved.scope === "welcome";
  const page = props.ground.column === "page";
  return (
    <div className="primary-workspace-layer">
      {page ? (
        <div className="agents-center-layer">
          <AgentsCenter client={agentRunClient()} />
        </div>
      ) : null}
      <main
        className="workspace"
        hidden={page}
        {...(onStage ? { "data-octant-start-only": "true" } : {})}
      >
        <div className="workspace-root">
          <section
            aria-label="Workspace pane: New task"
            className="workspace-pane"
            data-active="true"
            data-focused="false"
            data-header="false"
            data-surface-kind="draft-thread"
          >
            <div className="workspace-pane__panel">
              {onStage ? (
                <div className="welcome-stage" data-octant-welcome-stage>
                  {props.start}
                </div>
              ) : (
                props.start
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

function GroundScene(props: { readonly ground: Ground; readonly start: ReactNode }) {
  const reducedMotion = usePrefersReducedMotion();
  const resolved = resolvedGround(props.ground, reducedMotion);
  const glass = hostGlass(props.ground);
  const shown = resolved.kind !== "none";
  const behindEverything = shown && resolved.scope === "everywhere";
  const backdrop = (placement: "welcome" | "shell") => (
    <AppBackdrop fetcher={photoFetcher} placement={placement} resolved={resolved} />
  );
  return (
    <PlanUsageProvider client={planUsageClient()} instances={RAIL_ACCOUNTS}>
      <ShellFrame
        {...(behindEverything
          ? { backdrop: backdrop("shell"), backdropCoversSidebar: resolved.coversSidebar }
          : {})}
        {...(shown && !behindEverything ? { welcomeGround: backdrop("welcome") } : {})}
        chrome={<header className="window-chrome" />}
        contextSidebarWidth={360}
        material={glass ? "translucent" : "opaque"}
        onCommitSidebarWidth={noop}
        onPreviewSidebarWidth={noop}
        sidebar={
          <Sidebar
            coveredByWorkspace={behindEverything && resolved.coversSidebar}
            nativeHost={props.ground.glass !== "off"}
          />
        }
        sidebarResizable={false}
        sidebarVibrancyMode={accessibleTheme(props.ground).sidebarBackground.vibrancyMode}
        sidebarWidth={280}
        wideContextOpen={false}
        workspace={<Column ground={props.ground} resolved={resolved} start={props.start} />}
      />
    </PlanUsageProvider>
  );
}

export interface GroundRenderer {
  readonly id: string;
  readonly render: () => ReactNode;
  readonly theme: (plain: ThemeSettings) => ThemeSettings;
  readonly desktop?: "opaque" | "glass";
  readonly seededRandom: true;
  readonly settled: () => Promise<void>;
}

/** The ground scenes, each drawing `start` as its start screen. */
export function groundRenderers(start: () => ReactNode): ReadonlyArray<GroundRenderer> {
  return GROUNDS.map((ground) => ({
    id: ground.id,
    render: () => <GroundScene ground={ground} start={start()} />,
    theme: (plain) => groundTheme(ground, plain),
    // A Glass level is set only in the desktop app; a browser never gets Glass.
    ...(ground.glass === "off" ? {} : { desktop: hostGlass(ground) ? "glass" : "opaque" }),
    seededRandom: true,
    settled: () =>
      groundSettled(
        ground,
        resolvedGround(ground, window.matchMedia("(prefers-reduced-motion: reduce)").matches),
      ),
  }));
}
