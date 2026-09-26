import {
  FileText,
  Globe,
  LayoutGrid,
  Link2,
  ListChecks,
  Maximize2,
  MessageCircle,
  Minus,
  NotebookPen,
  Sparkles,
  SquareTerminal,
  Timer,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  planZenWall,
  resolveAccessibilityFallbacks,
  resolveZenLiveCardActivity,
} from "@octant/domain";
import type { ResolvedAppBackground, ZenLiveCardActivity } from "@octant/domain";
import type {
  ZenAssistantSnapshot,
  ZenAppearance,
  ZenChecklistItemId,
  ZenElementPayload,
  ZenFocusZone,
  ZenGeometry,
  ZenGroundEffect,
  ZenSourceContext,
  ZenSpace,
  ZenSpaceId,
  ZenSpaceLayout,
  ZenTimerAction,
  ZenThreadCatalogEntry,
  ZenThreadCatalogRef,
  ZenViewport,
} from "@octant/contracts/zen";
import {
  DEFAULT_ZEN_BACKGROUND,
  DEFAULT_ZEN_TIMER_DURATION_MS,
  LEGACY_DEFAULT_ZEN_GROUND_COLOR,
  getZenBuiltinBackground,
} from "@octant/contracts/zen";
import type { SettingsDeepLink } from "@octant/contracts";
import type { ProjectId } from "@octant/contracts/projects";
import {
  UNSUPPORTED_NAVIGATOR_ASSISTANT,
  type NavigatorAssistantController,
} from "../navigator/useNavigatorAssistant";
import { relativeTimeLabel } from "../lib/relativeTime";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantCard } from "../ui/base/OctantCard";
import { OctantInput } from "../ui/base/OctantInput";
import { AppBackdrop, type BackgroundImageFetcher } from "../theme/AppBackdrop";
import { ZenAppearancePanel } from "./ZenAppearancePanel";
import { ZenGroundEffectLayer } from "./ZenGroundEffectLayer";
import { ZenBar } from "./ZenBar";
import { ZenAssistant } from "./ZenAssistant";
import { ZenSpaceSwitcher } from "./ZenSpaceSwitcher";
import { ZenThreadElement, type ZenLiveThreadCard } from "./ZenThreadElement";
import { ZenThreadPicker } from "./ZenThreadPicker";
import { ZenTimer } from "./widgets/ZenTimer";
import { ZenChecklist } from "./widgets/ZenChecklist";
import { ZenNotes } from "./widgets/ZenNotes";
import { ZenReference } from "./widgets/ZenReference";
import {
  bringElementToFront,
  clampGeometryToBounds,
  computeVisibleRegion,
  nudgeGeometry,
  resizeGeometry,
  translateGeometry,
  type ZenResizeEdge,
} from "./zenGeometry";

export interface ZenSurfaceProps {
  readonly barCollapsed: boolean;
  /** The spaces this window holds, or null before the zone has been read. */
  readonly focusZone?: ZenFocusZone | null;
  readonly spacesBusy?: boolean;
  readonly onAddSpace?: (name: string) => void;
  readonly onRemoveSpace?: (spaceId: ZenSpaceId) => void;
  readonly onRenameSpace?: (spaceId: ZenSpaceId, name: string) => void;
  readonly onShowSpace?: (spaceId: ZenSpaceId) => void;
  readonly message?: string;
  readonly onExit: () => void;
  readonly onAddTimer?: (durationMs: number) => void;
  /** Adds a terminal owned by the chosen Code thread to this space. */
  readonly onAddTerminal?: (sourceContext: ZenSourceContext) => void;
  /** Whether the Code thread is present in the current Code snapshot. */
  readonly canAddTerminal?: (sourceContext: ZenSourceContext) => boolean;
  /** Docks a research browser for the chosen Work or Code thread. */
  readonly onAddBrowser?: (sourceContext: ZenSourceContext) => void;
  /** Reads the thread catalog without opening the Threads panel. */
  readonly onLoadThreads?: () => void;
  /**
   * The Code Project this window holds, offered as "This Project" for a
   * terminal with no thread. Absent when the window holds no Code Project or
   * the host cannot open Project terminals.
   */
  readonly projectTerminalTarget?: { readonly projectId: ProjectId; readonly name: string };
  /** Starts a terminal at that Project's root and pins its card. */
  readonly onAddProjectTerminal?: (projectId: ProjectId) => void;
  /**
   * The Work or Code Project this window holds, offered as "This Project" for
   * a browser with no thread. Absent when the window holds neither.
   */
  readonly projectBrowserTarget?: { readonly projectId: ProjectId; readonly name: string };
  /** Docks that Project's own browser at the space's edge. */
  readonly onAddProjectBrowser?: (projectId: ProjectId) => void;
  readonly onExpandBar: () => void;
  readonly onHideBar: () => void;
  readonly onCreateWidget?: (kind: "notes" | "checklist") => void;
  readonly onCreateReference?: (url: string, label?: string) => void;
  readonly onUploadBackground?: (file: File) => void;
  /**
   * The application's own ground, already resolved against the theme and the
   * accessibility settings. A space whose background is `theme` stands on
   * this one rather than on a ground of Zen's own; without it, such a space
   * shows the plain workspace ground.
   */
  readonly appBackground?: ResolvedAppBackground;
  /** Reads an application-ground photo through the window's own authority. */
  readonly appBackgroundFetcher?: BackgroundImageFetcher;
  readonly backgroundImageUrl?: string;
  readonly backgroundStatus?: "ready" | "loading" | "unavailable";
  readonly onSaveNotes?: (
    elementId: ZenElementPayload["elementId"],
    content: string,
    expectedWidgetVersion: number,
  ) => Promise<void>;
  readonly onAddChecklistItem?: (
    elementId: ZenElementPayload["elementId"],
    text: string,
    expectedWidgetVersion: number,
  ) => Promise<void>;
  readonly onSetChecklistItemCompleted?: (
    elementId: ZenElementPayload["elementId"],
    itemId: ZenChecklistItemId,
    done: boolean,
    expectedWidgetVersion: number,
  ) => Promise<void>;
  readonly onReorderChecklistItem?: (
    elementId: ZenElementPayload["elementId"],
    itemId: ZenChecklistItemId,
    beforeItemId: ZenChecklistItemId | null,
    expectedWidgetVersion: number,
  ) => Promise<void>;
  readonly onRemoveChecklistItem?: (
    elementId: ZenElementPayload["elementId"],
    itemId: ZenChecklistItemId,
    expectedWidgetVersion: number,
  ) => Promise<void>;
  readonly onRemoveElement?: (elementId: ZenElementPayload["elementId"]) => void;
  readonly onUpdateElement: (element: ZenElementPayload) => void | Promise<void>;
  readonly onUpdateViewport: (viewport: ZenViewport) => void;
  /** Switches the space between the wall and a hand-made arrangement. */
  readonly onSetLayout?: (layout: ZenSpaceLayout) => void;
  readonly assistant?: ZenAssistantSnapshot | null;
  readonly assistantOpen?: boolean;
  readonly panelBusy?: boolean;
  readonly threadEntries?: ReadonlyArray<ZenThreadCatalogEntry>;
  readonly threadPickerOpen?: boolean;
  readonly threadQuery?: string;
  readonly onPinThread?: (catalogRef: ZenThreadCatalogRef) => void;
  readonly onCloseAssistant?: () => void;
  readonly onCloseThreadPicker?: () => void;
  /**
   * Builds the live surface for one pinned card, or returns undefined when
   * this window hosts no live card for that source context. The focus zone holds no
   * thread clients of its own: it says which cards may stream and hands each
   * one its own source context, and the shell decides what that context is
   * allowed to open. Nothing here is shared between cards.
   */
  readonly renderLiveThread?: (input: {
    readonly sourceContext: ZenSourceContext;
    readonly entry: ZenThreadCatalogEntry;
    readonly activity: ZenLiveCardActivity;
  }) => ZenLiveThreadCard | undefined;
  /**
   * Builds the surface for one pinned terminal, or returns undefined when this
   * window cannot open one. The focus zone holds no Code client of its own: it
   * says which cards may stream and hands each one the shell it was pinned to,
   * and the shell decides what that terminal is allowed to do.
   */
  readonly renderTerminal?: (input: {
    readonly element: Extract<ZenElementPayload, { kind: "terminal" }>;
    readonly activity: ZenLiveCardActivity;
  }) => ReactNode | undefined;
  /**
   * Builds the surface for one pinned Project terminal, or returns undefined
   * when this window cannot open one. The card names a Project and a shell and
   * nothing else; the host decides what that shell may still do.
   */
  readonly renderProjectTerminal?: (input: {
    readonly element: Extract<ZenElementPayload, { kind: "project-terminal" }>;
    readonly activity: ZenLiveCardActivity;
  }) => ReactNode | undefined;
  /**
   * Builds the surface for one pinned canvas, or returns undefined when this
   * window cannot read one. The focus zone holds no Canvas client of its own:
   * it hands over the document the card was pinned to, and the host decides
   * whether that canvas may be read at all.
   */
  readonly renderCanvas?: (input: {
    readonly element: Extract<ZenElementPayload, { kind: "canvas" }>;
  }) => ReactNode | undefined;
  /**
   * Builds the docked research browser, or returns undefined when this window
   * cannot show one. Rendered outside the canvas on purpose: the page is a
   * native view the host places by absolute window bounds, so it cannot live
   * under the canvas's CSS transform. As with every other surface here, the
   * zone holds no browser client of its own and only hands over the dock the
   * space is bound to.
   */
  readonly renderResearchDock?: (input: {
    readonly dock: NonNullable<ZenSpace["research"]>;
  }) => ReactNode | undefined;
  /**
   * Opens this window's Zen assistant surface. Awaited before a turn is sent,
   * because opening is what binds the surface to the conversation, and a turn
   * that overtakes the binding is answered without Zen's own actions.
   */
  readonly onOpenAssistant?: () => void | Promise<void>;
  readonly onOpenThreads?: (query?: string) => void;
  readonly onOpenSettings?: (target: SettingsDeepLink) => void;
  /**
   * The shared Navigator reader. Absent means this Zen surface was given no
   * Navigator, which its assistant reports rather than papers over.
   */
  readonly navigatorAssistant?: NavigatorAssistantController;
  /**
   * Re-reads what is Zen's about the assistant surface once a turn has been
   * accepted. The conversation is the host's, but a recipe the turn proposed is
   * Zen's, and nothing else asks the host for it.
   */
  readonly onAssistantTurn?: () => void | Promise<void>;
  readonly onConfirmRecipePreview?: (action: "save" | "place") => void;
  readonly onTimerAction?: (
    elementId: ZenElementPayload["elementId"],
    action: ZenTimerAction,
    durationMs?: number,
  ) => void;
  readonly onRefreshTimers?: () => void;
  readonly onUpdateAppearance?: (
    patch: Partial<ZenAppearance> & Pick<ZenAppearance, "dimming" | "elementOpacity">,
  ) => void;
  readonly space: ZenSpace;
}

type ElementInteraction = {
  readonly kind: "move" | "resize";
  readonly edge: ZenResizeEdge;
  readonly element: ZenElementPayload;
  readonly startX: number;
  readonly startY: number;
};

/* Every edge and corner resizes. One invisible corner grip was the only way
   to size a card, and nobody found it. */
const RESIZE_EDGES: ReadonlyArray<ZenResizeEdge> = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

function useMediaQueryMatches(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }
    if (typeof media.addListener === "function") {
      media.addListener(update);
      return () => media.removeListener(update);
    }
    return;
  }, [query]);

  return matches;
}

function useZenEffectiveAppearance(appearance: ZenAppearance): ZenAppearance {
  const reducedMotion = useMediaQueryMatches("(prefers-reduced-motion: reduce)");
  const reducedTransparency = useMediaQueryMatches("(prefers-reduced-transparency: reduce)");
  const increasedContrast = useMediaQueryMatches("(prefers-contrast: more)");

  return useMemo(
    () =>
      resolveAccessibilityFallbacks(
        appearance,
        reducedMotion,
        reducedTransparency,
        increasedContrast,
      ),
    [appearance, increasedContrast, reducedMotion, reducedTransparency],
  );
}

export function ZenSurface(props: ZenSurfaceProps) {
  const hostNavigator = props.navigatorAssistant ?? UNSUPPORTED_NAVIGATOR_ASSISTANT;
  // Zen's fronts read and send through the host's one controller; what is added
  // here is Zen's own follow-up read, so a recipe the turn proposed reaches the
  // surface that is meant to show it.
  const navigatorAssistant: NavigatorAssistantController = {
    ...hostNavigator,
    send: async (prompt) => {
      await hostNavigator.send(prompt);
      await props.onAssistantTurn?.();
    },
  };
  const [focusedId, setFocusedId] = useState<string | undefined>(undefined);
  const [interaction, setInteraction] = useState<ElementInteraction | null>(null);
  const [previewGeometry, setPreviewGeometry] = useState<
    { readonly elementId: string; readonly geometry: ZenGeometry } | undefined
  >(undefined);
  // "Add" and "Widgets" were two panels for one act, and both offered a way to
  // pin a thread. One destination now holds everything a person can put on the
  // wall.
  const [manualPanel, setManualPanel] = useState<"add" | "appearance" | null>(null);
  const [toolTarget, setToolTarget] = useState<"terminal" | "browser" | null>(null);
  const [timerMinutes, setTimerMinutes] = useState(DEFAULT_ZEN_TIMER_DURATION_MS / 60_000);
  const [referenceUrl, setReferenceUrl] = useState("");
  const [referenceLabel, setReferenceLabel] = useState("");
  const surfaceRef = useRef<HTMLDivElement>(null);
  // Which cards may stream depends on how much of the space is on screen, and
  // the surface fills the window, so the only thing that changes that size is a
  // window resize.
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    function measure(): void {
      const node = surfaceRef.current;
      if (node === null) return;
      setSurfaceSize({ width: node.clientWidth, height: node.clientHeight });
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const storedAppearance = useMemo(
    () => withCurrentDefaultGround(props.space.appearance),
    [props.space.appearance],
  );
  const appearance = useZenEffectiveAppearance(storedAppearance);
  const sorted = useMemo(
    () => [...props.space.elements].sort((a, b) => a.zIndex - b.zIndex),
    [props.space.elements],
  );
  // A space is a desk: every card stays where the person puts it and sizes
  // the way they drag it. The wall's tiling survives as two things only: the
  // first arrangement of a space that has never been arranged (it is written
  // down as ordinary geometry, below), and Tidy, which re-tiles on request. A
  // wall that re-tiled on its own refused every drag, so a card could not be
  // moved or resized at all outside a mode nobody found.
  const wall = props.space.layout === "wall";
  const laidOut = useMemo(() => {
    if (!wall) return sorted;
    const tiles = planZenWall(props.space.elements.length, surfaceSize, {
      // The spaces pill floats over the top of the surface and the Navigator
      // bar over the bottom; a wall that filled the whole area would put its
      // first and last rows underneath them.
      insetTop: ZEN_WALL_INSET_TOP,
      insetBottom: props.barCollapsed ? ZEN_WALL_INSET_BOTTOM_COLLAPSED : ZEN_WALL_INSET_BOTTOM,
    });
    return props.space.elements.map((element, index) => {
      const tile = tiles[index];
      return tile === undefined ? element : { ...element, geometry: tile };
    });
  }, [props.barCollapsed, props.space.elements, sorted, surfaceSize, wall]);
  // The desk is the window: nothing is off screen to pan to or zoom out for,
  // and a stored pan or zoom from the old canvas would strand cards out of
  // reach, so the surface always draws at one to one.
  const scale = 1;
  const background = appearance.background;
  const forceOpaque = appearance.reducedTransparency || appearance.increasedContrast;
  const focusedElement = props.space.elements.find(
    (element) => String(element.elementId) === focusedId,
  );
  const focusedThreadContext =
    focusedElement?.kind === "thread" ? focusedElement.sourceContext : undefined;
  // The Project this window holds, when it can take a terminal or browser of
  // its own. Offered first in the pickers, before any thread.
  const projectTerminal =
    props.onAddProjectTerminal === undefined ? undefined : props.projectTerminalTarget;
  const projectBrowser =
    props.onAddProjectBrowser === undefined ? undefined : props.projectBrowserTarget;
  // The threads a terminal or browser can open in, the focused card's first.
  const toolCandidates = (props.threadEntries ?? [])
    .filter((entry) =>
      toolTarget === "terminal"
        ? entry.sourceContext.threadKind === "code" &&
          props.canAddTerminal?.(entry.sourceContext) !== false
        : entry.sourceContext.threadKind === "code" || entry.sourceContext.threadKind === "work",
    )
    .sort((left, right) => {
      const focused = (entry: ZenThreadCatalogEntry) =>
        focusedThreadContext !== undefined &&
        String(entry.threadId) === String(focusedThreadContext.threadId)
          ? 0
          : 1;
      return focused(left) - focused(right);
    });
  const threadCardActivity = useMemo(() => {
    const focusedElementId = focusedElement?.elementId;
    const resolved = resolveZenLiveCardActivity({
      // The laid-out geometry, not the stored one: on a wall the stored
      // rectangles are whatever an earlier arrangement left behind, and a card
      // would be judged off screen while it is plainly in front of the reader.
      elements: laidOut,
      visibleRegion: computeVisibleRegion({ panX: 0, panY: 0, scale: 1 }, surfaceSize),
      ...(focusedElementId === undefined ? {} : { focusedElementId }),
    });
    return new Map(resolved.map((card) => [String(card.elementId), card]));
  }, [focusedElement?.elementId, laidOut, surfaceSize]);

  // A space still on the wall is settled once: its tiles are written as each
  // card's geometry, in order, and the space leaves the wall. From then on the
  // cards are where they were drawn, and moving one moves only that one.
  const settledSpace = useRef<string | undefined>(undefined);
  const onUpdateElement = props.onUpdateElement;
  const onSetLayout = props.onSetLayout;
  useEffect(() => {
    if (!wall || onSetLayout === undefined) return;
    if (surfaceSize.width === 0 || surfaceSize.height === 0) return;
    const spaceId = String(props.space.spaceId);
    if (settledSpace.current === spaceId) return;
    settledSpace.current = spaceId;
    const tiles = laidOut;
    void (async () => {
      try {
        for (const element of tiles) {
          await onUpdateElement(element);
        }
        onSetLayout("arrange");
      } catch {
        // A write that failed leaves the space on the wall, where nothing
        // moves. Forget that it was settled so the next render tries again
        // rather than stranding it for the session.
        if (settledSpace.current === spaceId) settledSpace.current = undefined;
      }
    })();
  }, [laidOut, onSetLayout, onUpdateElement, props.space.spaceId, surfaceSize, wall]);

  // A space arranged under the old canvas kept the geometry its pan and zoom
  // drew it at, up to thousands of pixels outside the window. With no pan or
  // zoom left to reach them, such windows are tidied onto the desk once when
  // the space opens; a desk whose windows are all within reach is left alone.
  const rescuedSpace = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (wall || surfaceSize.width === 0 || surfaceSize.height === 0) return;
    const spaceId = String(props.space.spaceId);
    if (rescuedSpace.current === spaceId) return;
    rescuedSpace.current = spaceId;
    if (props.space.elements.some((element) => outOfReach(element.geometry, surfaceSize))) {
      void tidy();
    }
    // Once per space: tidy reads the elements and surface it is called with.
  }, [props.space.spaceId, surfaceSize, wall]);

  /** Re-tiles every card to the room the surface has now, in reading order. */
  async function tidy(): Promise<void> {
    const ordered = [...props.space.elements].sort(
      (left, right) => left.geometry.y - right.geometry.y || left.geometry.x - right.geometry.x,
    );
    const tiles = planZenWall(ordered.length, surfaceSize, {
      insetTop: ZEN_WALL_INSET_TOP,
      insetBottom: props.barCollapsed ? ZEN_WALL_INSET_BOTTOM_COLLAPSED : ZEN_WALL_INSET_BOTTOM,
    });
    for (const [index, element] of ordered.entries()) {
      const tile = tiles[index];
      if (tile === undefined || sameGeometry(tile, element.geometry)) continue;
      await props.onUpdateElement({ ...element, geometry: tile, minimized: false });
    }
  }

  /**
   * The card's own reading of its own thread.
   *
   * Every lookup is keyed by this element's source context, never by whatever
   * the shell happens to have open, so a card can only ever show the thread it
   * was pinned to.
   */
  function resolveThreadCard(element: Extract<ZenElementPayload, { kind: "thread" }>): {
    readonly entry?: ZenThreadCatalogEntry;
    readonly live?: ZenLiveThreadCard;
  } {
    const entry = props.threadEntries?.find(
      (candidate) =>
        candidate.mode === element.sourceContext.mode &&
        String(candidate.threadId) === String(element.sourceContext.threadId),
    );
    if (entry === undefined) return {};
    const activity = threadCardActivity.get(String(element.elementId));
    if (props.renderLiveThread === undefined || activity === undefined) return { entry };
    const live = props.renderLiveThread({
      sourceContext: element.sourceContext,
      entry,
      activity,
    });
    return live === undefined ? { entry } : { entry, live };
  }
  /**
   * The card's own window onto its own shell, keyed by the terminal it was
   * pinned to rather than by whatever Code the shell happens to be showing.
   */
  function renderTerminalCard(
    element: Extract<ZenElementPayload, { kind: "terminal" }>,
  ): ReactNode | undefined {
    const activity = threadCardActivity.get(String(element.elementId));
    if (props.renderTerminal === undefined || activity === undefined) return undefined;
    return props.renderTerminal({ element, activity });
  }

  function renderProjectTerminalCard(
    element: Extract<ZenElementPayload, { kind: "project-terminal" }>,
  ): ReactNode | undefined {
    const activity = threadCardActivity.get(String(element.elementId));
    if (props.renderProjectTerminal === undefined || activity === undefined) return undefined;
    return props.renderProjectTerminal({ element, activity });
  }

  const resolvedBackground = resolveZenBackgroundStyle(background, props.backgroundImageUrl);
  /**
   * The application ground as this space should show it.
   *
   * The value arrives already resolved against the theme and the app's own
   * accessibility settings, and Zen draws that rather than deciding again —
   * so Increased contrast, which resolves the ground to `none`, clears it
   * here exactly as it does under the shell. Zen resolves the same two
   * preferences for its own surface as well, and honours whichever reading
   * asks for less, rather than drifting a cloud a space was told to hold
   * still.
   */
  const appGround =
    !resolvedBackground.appGround || props.appBackground === undefined
      ? undefined
      : appearance.increasedContrast
        ? undefined
        : appearance.reducedMotion
          ? { ...props.appBackground, animated: false }
          : props.appBackground;
  const groundEffectLayer = resolveGroundEffect(appearance, props.backgroundImageUrl);
  const overlay = Math.max(
    appearance.dimming,
    background.kind === "image" || background.kind === "builtin" ? background.overlay : 0,
  );

  function focusElement(element: ZenElementPayload): void {
    setFocusedId(element.elementId);
    // Raising a card is how one stops hiding another. Nothing on a wall is
    // behind anything, so focusing a card writes no z-index there; the wall
    // reads the space's own order and would ignore the new one anyway.
    if (wall) return;
    const raised = bringElementToFront(props.space.elements, element.elementId);
    const next = raised.find((el) => el.elementId === element.elementId);
    if (next !== undefined && next.zIndex !== element.zIndex) {
      props.onUpdateElement(next);
    }
  }

  function beginElementInteraction(
    event: PointerEvent<HTMLElement>,
    element: ZenElementPayload,
    kind: "move" | "resize",
    edge: ZenResizeEdge = "se",
  ): void {
    if (element.locked) return;
    if (event.button !== 0) return;
    // For the moment a never-arranged space is being written down, its cards
    // are still drawn from the wall; a drag started then would begin from a
    // rectangle the stored one has not caught up with.
    if (wall) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is unavailable in the DOM test environment; the
      // surface-level pointer handlers still complete the interaction there.
    }
    setFocusedId(element.elementId);
    const raised = bringElementToFront(props.space.elements, element.elementId).find(
      (candidate) => candidate.elementId === element.elementId,
    );
    setInteraction({
      kind,
      edge,
      element: raised ?? element,
      startX: event.clientX,
      startY: event.clientY,
    });
  }

  function handlePointerMove(event: PointerEvent<HTMLElement>): void {
    if (interaction === null) return;
    const dx = event.clientX - interaction.startX;
    const dy = event.clientY - interaction.startY;
    const contentDx = dx / scale;
    const contentDy = dy / scale;
    const nextGeometry =
      interaction.kind === "move"
        ? translateGeometry(interaction.element.geometry, contentDx, contentDy)
        : resizeGeometry(interaction.element.geometry, interaction.edge, contentDx, contentDy);
    setPreviewGeometry({
      elementId: interaction.element.elementId,
      geometry: clampGeometryToBounds(nextGeometry),
    });
  }

  function finishPointerInteraction(): void {
    if (interaction === null) return;
    const geometry =
      previewGeometry?.elementId === interaction.element.elementId
        ? previewGeometry.geometry
        : interaction.element.geometry;
    const elementId = interaction.element.elementId;
    const completion = props.onUpdateElement({ ...interaction.element, geometry });
    setInteraction(null);
    if (completion === undefined) {
      setPreviewGeometry(undefined);
      return;
    }
    void completion.finally(() => {
      setPreviewGeometry((current) =>
        current?.elementId === elementId && sameGeometry(current.geometry, geometry)
          ? undefined
          : current,
      );
    });
  }

  function handleElementKeyDown(
    event: KeyboardEvent<HTMLDivElement>,
    element: ZenElementPayload,
  ): void {
    if (event.target !== event.currentTarget) return;
    if (element.locked) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      props.onRemoveElement?.(element.elementId);
      return;
    }
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "ArrowUp" &&
      event.key !== "ArrowDown"
    ) {
      return;
    }
    // Nudge and resize move a card within an arrangement. On a wall they would
    // write a geometry the wall ignores, so the arrows stay with the surface
    // and Delete keeps working.
    if (wall) return;
    event.preventDefault();
    const nextGeometry = clampGeometryToBounds(
      event.altKey
        ? resizeGeometry(
            element.geometry,
            event.key === "ArrowRight"
              ? "e"
              : event.key === "ArrowLeft"
                ? "w"
                : event.key === "ArrowDown"
                  ? "s"
                  : "n",
            event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0,
            event.key === "ArrowUp" ? -16 : event.key === "ArrowDown" ? 16 : 0,
          )
        : nudgeGeometry(element.geometry, event.key, event.shiftKey),
    );
    props.onUpdateElement({ ...element, geometry: nextGeometry });
  }

  function handleSurfaceKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Escape") return;
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    props.onExit();
  }

  // Escape closes what is open before it leaves Zen. Handled on the document
  // because a panel holds focus inside itself, so the key never reaches the
  // surface, and a person pressing Escape in the thread picker expects the
  // picker to close, not the whole focus zone.
  const closeTopPanel = useCallback((): boolean => {
    if (manualPanel !== null) {
      setManualPanel(null);
      return true;
    }
    if (props.threadPickerOpen === true) {
      props.onCloseThreadPicker?.();
      return true;
    }
    if (props.assistantOpen === true) {
      props.onCloseAssistant?.();
      return true;
    }
    return false;
  }, [manualPanel, props]);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key !== "Escape") return;
      if (!closeTopPanel()) return;
      event.preventDefault();
      event.stopPropagation();
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [closeTopPanel]);

  return (
    <div
      aria-label="Zen workspace"
      className="zen-surface"
      data-layout={wall ? "wall" : "arrange"}
      onKeyDown={handleSurfaceKeyDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerInteraction}
      onPointerCancel={finishPointerInteraction}
      ref={surfaceRef}
      role="application"
      style={resolvedBackground.style}
      tabIndex={0}
    >
      {resolvedBackground.systemGround ? <div aria-hidden="true" className="zen-ground" /> : null}
      {appGround === undefined || props.appBackgroundFetcher === undefined ? null : (
        <AppBackdrop fetcher={props.appBackgroundFetcher} placement="zen" resolved={appGround} />
      )}
      {groundEffectLayer === null ? null : <ZenGroundEffectLayer {...groundEffectLayer} />}
      <div className="zen-surface__titlebar window-drag-region" aria-hidden="true" />
      {props.focusZone === null || props.focusZone === undefined ? null : (
        <div className="zen-surface__spaces-anchor window-no-drag">
          <ZenSpaceSwitcher
            busy={props.spacesBusy === true}
            zone={props.focusZone}
            {...(props.onAddSpace === undefined ? {} : { onAddSpace: props.onAddSpace })}
            {...(props.onRemoveSpace === undefined ? {} : { onRemoveSpace: props.onRemoveSpace })}
            {...(props.onRenameSpace === undefined ? {} : { onRenameSpace: props.onRenameSpace })}
            {...(props.onShowSpace === undefined ? {} : { onShowSpace: props.onShowSpace })}
          />
        </div>
      )}
      {overlay > 0 ? (
        <div
          aria-hidden="true"
          className="zen-surface__overlay"
          style={{ opacity: overlay / 100 }}
        />
      ) : null}
      {background.kind === "image" && props.backgroundStatus !== "ready" ? (
        <div className="zen-surface__background-status" role="status">
          {props.backgroundStatus === "loading"
            ? "Loading local Zen background…"
            : "Zen background unavailable; using the safe default."}
        </div>
      ) : null}
      {props.space.elements.length === 0 ? (
        <div className="zen-surface__empty">
          <strong>Build your focus space</strong>
          <span>Open Threads to pin active work, or Add a note, checklist, or timer.</span>
        </div>
      ) : null}
      <div className="zen-surface__canvas" data-interacting={interaction?.kind}>
        {laidOut.map((element) => {
          const threadCard = element.kind === "thread" ? resolveThreadCard(element) : undefined;
          const title =
            element.kind === "terminal" || element.kind === "project-terminal"
              ? `Terminal · ${element.title ?? "Terminal"}`
              : "title" in element && typeof element.title === "string"
                ? element.title
                : element.kind === "notes"
                  ? "Notes"
                  : element.kind === "checklist"
                    ? "Checklist"
                    : element.kind === "thread"
                      ? // A card that hosts a conversation is named by that
                        // thread; three cards all labelled "Thread" tell a
                        // keyboard reader nothing about which one they are on.
                        (threadCard?.entry?.title ?? "Thread")
                      : element.kind === "timer"
                        ? "Timer"
                        : element.kind === "canvas"
                          ? // A card that hosts a document is named by that
                            // document; three cards all labelled "Canvas" tell
                            // a keyboard reader nothing about which one they
                            // are on.
                            (element.title ?? "Canvas")
                          : element.kind;
          const geometry =
            previewGeometry?.elementId === element.elementId
              ? previewGeometry.geometry
              : element.geometry;
          return (
            <div
              aria-label={title}
              className={`zen-el${focusedId === element.elementId ? " zen-element--focused" : ""}`}
              data-locked={element.locked ? "true" : undefined}
              data-minimized={element.minimized ? "true" : undefined}
              key={element.elementId}
              onFocus={() => focusElement(element)}
              onKeyDown={(event) => handleElementKeyDown(event, element)}
              role="group"
              style={{
                left: geometry.x,
                top: geometry.y,
                width: geometry.width,
                // A minimised card keeps only its title bar, so the bar's own
                // height is the honest one; the stored geometry height waits
                // for the restore.
                ...(element.minimized ? {} : { height: geometry.height }),
                zIndex: element.zIndex,
                opacity: forceOpaque ? 1 : appearance.elementOpacity,
              }}
              tabIndex={0}
            >
              <header
                className="zen-el-head"
                onPointerDown={(event) => beginElementInteraction(event, element, "move")}
              >
                <ZenElementIcon kind={element.kind} />
                <span className="zen-el-title">{title}</span>
                {/* How long ago this thread last moved, beside its name. A
                    person supervising several cards reads that before
                    anything in the body. */}
                {threadCard?.entry === undefined ? null : (
                  <span className="zen-el-state">
                    <time dateTime={threadCard.entry.recentActivityAt}>
                      {relativeTimeLabel(threadCard.entry.recentActivityAt)}
                    </time>
                  </span>
                )}
                <span className="zen-el-gap" />
                {/* Two quiet icons instead of two words: a person running
                    several cards reads the titles, not "Minimize Remove"
                    repeated on every one. */}
                <span
                  className="zen-el-actions window-no-drag"
                  onPointerDown={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <OctantIconButton
                    disabled={element.locked}
                    label={`${element.minimized ? "Restore" : "Minimize"} ${title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onUpdateElement({ ...element, minimized: !element.minimized });
                    }}
                    type="button"
                  >
                    {element.minimized ? (
                      <Maximize2 aria-hidden="true" size={12} strokeWidth={1.75} />
                    ) : (
                      <Minus aria-hidden="true" size={14} strokeWidth={1.75} />
                    )}
                  </OctantIconButton>
                  <OctantIconButton
                    disabled={element.locked}
                    label={`Remove ${title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onRemoveElement?.(element.elementId);
                    }}
                    type="button"
                  >
                    <X aria-hidden="true" size={14} strokeWidth={1.75} />
                  </OctantIconButton>
                </span>
              </header>
              {element.minimized ? null : (
                <>
                  <div className="zen-el-body">
                    {element.kind === "thread" ? (
                      <ZenThreadElement
                        {...(threadCard ?? {})}
                        sourceContext={element.sourceContext}
                      />
                    ) : element.kind === "notes" ? (
                      <ZenNotes
                        element={element}
                        {...(props.onSaveNotes === undefined ? {} : { onSave: props.onSaveNotes })}
                      />
                    ) : element.kind === "checklist" ? (
                      <ZenChecklist
                        element={element}
                        {...(props.onAddChecklistItem === undefined
                          ? {}
                          : { onAddItem: props.onAddChecklistItem })}
                        {...(props.onRemoveChecklistItem === undefined
                          ? {}
                          : { onRemoveItem: props.onRemoveChecklistItem })}
                        {...(props.onReorderChecklistItem === undefined
                          ? {}
                          : { onReorder: props.onReorderChecklistItem })}
                        {...(props.onSetChecklistItemCompleted === undefined
                          ? {}
                          : { onSetCompleted: props.onSetChecklistItemCompleted })}
                      />
                    ) : element.kind === "timer" ? (
                      <ZenTimer
                        onAction={(action) => props.onTimerAction?.(element.elementId, action)}
                        onElapsed={() => props.onRefreshTimers?.()}
                        reducedMotion={appearance.reducedMotion}
                        timer={element}
                      />
                    ) : element.kind === "recipe" ? (
                      <ZenRecipeElement
                        recipe={props.space.recipes?.find(
                          (candidate) => candidate.recipeId === element.recipeId,
                        )}
                        state={element.state}
                      />
                    ) : element.kind === "reference" ? (
                      <ZenReference element={element} />
                    ) : element.kind === "terminal" ? (
                      (renderTerminalCard(element) ?? (
                        <p role="status">This window cannot open a terminal.</p>
                      ))
                    ) : element.kind === "project-terminal" ? (
                      (renderProjectTerminalCard(element) ?? (
                        <p role="status">This window cannot open a terminal.</p>
                      ))
                    ) : element.kind === "canvas" ? (
                      (props.renderCanvas?.({ element }) ?? (
                        <p role="status">This window cannot read a canvas.</p>
                      ))
                    ) : (
                      "Unsupported Zen element"
                    )}
                  </div>
                  {/* Every edge and corner is a handle. The corner one also
                      carries a small mark so a person can see a card resizes
                      at all; the others show only as a cursor. */}
                  {wall || element.locked
                    ? null
                    : RESIZE_EDGES.map((edge) => (
                        <span
                          aria-hidden="true"
                          className={`zen-el-resize zen-el-resize--${edge} window-no-drag`}
                          key={edge}
                          onMouseDown={(event) => event.stopPropagation()}
                          onPointerDown={(event) =>
                            beginElementInteraction(event, element, "resize", edge)
                          }
                          // Above a live thread's composer, which stacks at 2.
                          style={{ zIndex: 4 }}
                        />
                      ))}
                </>
              )}
            </div>
          );
        })}
      </div>

      {props.space.research === null || props.space.research === undefined
        ? null
        : props.renderResearchDock?.({ dock: props.space.research })}

      {/* The one layout control a desk needs: put everything back in a
          tidy grid. Moving and sizing are the cards' own handles. */}
      {props.space.elements.length < 2 ? null : (
        <div className="zen-bar zen-surface__controls window-no-drag">
          <OctantButton
            aria-label="Tidy windows"
            onClick={() => void tidy()}
            size="sm"
            type="button"
            variant="ghost"
          >
            <LayoutGrid aria-hidden="true" size={14} strokeWidth={1.75} />
            Tidy
          </OctantButton>
        </div>
      )}

      {props.message === undefined ? null : (
        <div className="zen-surface__message" role="status">
          {props.message}
        </div>
      )}

      {props.threadPickerOpen ? (
        <div className="zen-surface__panel-anchor window-no-drag">
          <ZenThreadPicker
            {...(props.panelBusy === undefined ? {} : { busy: props.panelBusy })}
            entries={props.threadEntries ?? []}
            onPin={(catalogRef) => props.onPinThread?.(catalogRef)}
            onClose={() => props.onCloseThreadPicker?.()}
            onQueryChange={(query) => props.onOpenThreads?.(query)}
            query={props.threadQuery ?? ""}
          />
        </div>
      ) : null}

      {props.assistantOpen ? (
        <div className="zen-surface__panel-anchor window-no-drag">
          <ZenAssistant
            {...(props.panelBusy === undefined ? {} : { busy: props.panelBusy })}
            controller={navigatorAssistant}
            onClose={() => props.onCloseAssistant?.()}
            onOpenSettings={(target) => props.onOpenSettings?.(target)}
            onOpenThreads={() => props.onOpenThreads?.()}
            {...(props.onConfirmRecipePreview === undefined
              ? {}
              : { onConfirmRecipe: props.onConfirmRecipePreview })}
            snapshot={props.assistant ?? null}
          />
        </div>
      ) : null}

      {manualPanel === null ? null : (
        <OctantCard
          aria-label={manualPanel === "appearance" ? "Zen appearance" : "Add to this space"}
          className="zen-panel zen-surface__manual-panel window-no-drag px-6"
          role="dialog"
          variant="glass"
        >
          <header className="card-head">
            <h2>{manualPanel === "appearance" ? "Appearance" : "Add"}</h2>
            <OctantButton
              aria-label="Close"
              className="zen-panel__close"
              onClick={() => setManualPanel(null)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <X aria-hidden="true" size={16} />
            </OctantButton>
          </header>
          {manualPanel === "appearance" ? (
            <ZenAppearancePanel
              appearance={storedAppearance}
              {...(props.onUpdateAppearance === undefined
                ? {}
                : { onUpdateAppearance: props.onUpdateAppearance })}
              {...(props.onUploadBackground === undefined
                ? {}
                : { onUploadBackground: props.onUploadBackground })}
            />
          ) : (
            <div className="zen-add">
              <section className="zen-add__section">
                <h3 className="zen-appearance__heading">Windows</h3>
                <div className="zen-add__tiles">
                  <AddTile
                    icon={MessageCircle}
                    label="Pin a thread"
                    onClick={() => props.onOpenThreads?.()}
                    text="Thread"
                  />
                  <AddTile
                    disabled={props.onAddTerminal === undefined && projectTerminal === undefined}
                    expanded={toolTarget === "terminal"}
                    icon={SquareTerminal}
                    label="Add terminal"
                    onClick={() => setToolTarget(toolTarget === "terminal" ? null : "terminal")}
                    text="Terminal"
                  />
                  <AddTile
                    disabled={props.onAddBrowser === undefined && projectBrowser === undefined}
                    expanded={toolTarget === "browser"}
                    icon={Globe}
                    label="Add browser"
                    onClick={() => setToolTarget(toolTarget === "browser" ? null : "browser")}
                    text="Browser"
                  />
                </div>
                {/* A terminal runs in a Code thread's checkout and a browser in
                    a Work or Code thread's browsing context, under that thread's
                    authority. The person picks which one here instead of first
                    having to focus a card they may not have pinned. */}
                {toolTarget === null ? null : (
                  <div
                    aria-label={
                      toolTarget === "terminal"
                        ? "Choose where the terminal runs"
                        : "Choose a browser"
                    }
                    className="zen-add-targets"
                    role="group"
                  >
                    {/* The Project itself comes first: a terminal at its root
                        or its own browser, with no thread's authority. */}
                    {toolTarget === "terminal" && projectTerminal !== undefined ? (
                      <OctantButton
                        aria-label={`Add terminal for this Project, ${projectTerminal.name}`}
                        className="zen-add-target"
                        onClick={() => {
                          props.onAddProjectTerminal?.(projectTerminal.projectId);
                          setToolTarget(null);
                          setManualPanel(null);
                        }}
                        type="button"
                        variant="ghost"
                      >
                        <span className="zen-add-target__title">This Project</span>
                        <span className="zen-add-target__detail">
                          {projectTerminal.name} · a terminal at its root
                        </span>
                      </OctantButton>
                    ) : null}
                    {toolTarget === "browser" && projectBrowser !== undefined ? (
                      <OctantButton
                        aria-label={`Add browser for this Project, ${projectBrowser.name}`}
                        className="zen-add-target"
                        onClick={() => {
                          props.onAddProjectBrowser?.(projectBrowser.projectId);
                          setToolTarget(null);
                          setManualPanel(null);
                        }}
                        type="button"
                        variant="ghost"
                      >
                        <span className="zen-add-target__title">This Project</span>
                        <span className="zen-add-target__detail">
                          {projectBrowser.name} · its own browser
                        </span>
                      </OctantButton>
                    ) : null}
                    <p className="zen-add-picker__hint">
                      {toolTarget === "terminal"
                        ? "Or open it in a thread's checkout."
                        : "Or open it in a thread's browsing context."}
                    </p>
                    {toolCandidates.length === 0 ? (
                      <p className="zen-add-picker__hint" role="status">
                        {toolTarget === "terminal"
                          ? "No Code thread can open a terminal yet. Start a Code thread in a Project first."
                          : "No Work or Code thread yet. Start one first."}
                      </p>
                    ) : (
                      toolCandidates.map((entry) => (
                        <OctantButton
                          className="zen-add-target"
                          key={String(entry.catalogRef)}
                          onClick={() => {
                            if (toolTarget === "terminal")
                              props.onAddTerminal?.(entry.sourceContext);
                            else props.onAddBrowser?.(entry.sourceContext);
                            setToolTarget(null);
                            setManualPanel(null);
                          }}
                          type="button"
                          variant="ghost"
                        >
                          <span className="zen-add-target__title">{entry.title}</span>
                          <span className="zen-add-target__detail">
                            {entry.projectLabel} · {entry.mode === "code" ? "Code" : "Work"}
                          </span>
                        </OctantButton>
                      ))
                    )}
                  </div>
                )}
              </section>

              <section className="zen-add__section">
                <h3 className="zen-appearance__heading">On this desk</h3>
                <div className="zen-add__tiles">
                  <AddTile
                    disabled={props.onCreateWidget === undefined}
                    icon={NotebookPen}
                    label="Add Notes"
                    onClick={() => {
                      props.onCreateWidget?.("notes");
                      setManualPanel(null);
                    }}
                    text="Notes"
                  />
                  <AddTile
                    disabled={props.onCreateWidget === undefined}
                    icon={ListChecks}
                    label="Add Checklist"
                    onClick={() => {
                      props.onCreateWidget?.("checklist");
                      setManualPanel(null);
                    }}
                    text="Checklist"
                  />
                </div>
                <div className="zen-add__row">
                  <Timer aria-hidden="true" className="zen-add__row-icon" size={16} />
                  <OctantInput
                    aria-label="Timer duration in minutes"
                    className="zen-add__minutes"
                    max="480"
                    min="1"
                    onChange={(event) => setTimerMinutes(Number(event.currentTarget.value))}
                    type="number"
                    value={timerMinutes}
                  />
                  <span className="zen-add__unit">min</span>
                  <OctantButton
                    aria-label="Add timer"
                    className="zen-add__row-action"
                    disabled={
                      !Number.isInteger(timerMinutes) || timerMinutes < 1 || timerMinutes > 480
                    }
                    onClick={() => {
                      props.onAddTimer?.(timerMinutes * 60 * 1000);
                      setManualPanel(null);
                    }}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Add timer
                  </OctantButton>
                </div>
                <div className="zen-add__row zen-add__row--link">
                  <Link2 aria-hidden="true" className="zen-add__row-icon" size={16} />
                  <OctantInput
                    aria-label="Reference URL"
                    onChange={(event) => setReferenceUrl(event.currentTarget.value)}
                    placeholder="https://"
                    type="url"
                    value={referenceUrl}
                  />
                  <OctantInput
                    aria-label="Reference label"
                    onChange={(event) => setReferenceLabel(event.currentTarget.value)}
                    placeholder="Label"
                    type="text"
                    value={referenceLabel}
                  />
                  <OctantButton
                    aria-label="Add Reference"
                    className="zen-add__row-action"
                    disabled={
                      props.onCreateReference === undefined || referenceUrl.trim().length === 0
                    }
                    onClick={() => {
                      props.onCreateReference?.(
                        referenceUrl.trim(),
                        referenceLabel.trim().length === 0 ? undefined : referenceLabel.trim(),
                      );
                      setReferenceUrl("");
                      setReferenceLabel("");
                      setManualPanel(null);
                    }}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Add link
                  </OctantButton>
                </div>
                <p className="zen-appearance__note">
                  Notes, checklists, timers, and links stay local to this Zen space.
                </p>
              </section>
            </div>
          )}
        </OctantCard>
      )}

      <div className="zen-surface__bar-anchor window-no-drag">
        <ZenBar
          collapsed={props.barCollapsed}
          onExit={props.onExit}
          onExpand={props.onExpandBar}
          onHide={props.onHideBar}
          {...(props.onOpenAssistant === undefined
            ? {}
            : { onOpenNavigator: props.onOpenAssistant })}
          onOpenAdd={() => {
            setManualPanel("add");
            setToolTarget(null);
            // The catalog is read when the panel opens, so the terminal and
            // browser choices list today's threads without opening Threads.
            props.onLoadThreads?.();
          }}
          onOpenAppearance={() => setManualPanel("appearance")}
          onOpenThreads={() => props.onOpenThreads?.()}
        />
      </div>
    </div>
  );
}

function ZenRecipeElement(props: {
  readonly recipe: ZenSpace["recipes"] extends ReadonlyArray<infer Recipe> | undefined
    ? Recipe | undefined
    : undefined;
  readonly state: Record<string, unknown>;
}) {
  if (props.recipe === undefined) return <p role="status">Recipe source is unavailable.</p>;
  return (
    <section aria-label={`${props.recipe.name} recipe`} className="zen-recipe">
      <p>{props.recipe.description ?? "Saved Zen recipe"}</p>
      <ul>
        {props.recipe.primitives.map((primitive) => (
          <li key={primitive}>{primitive}</li>
        ))}
      </ul>
      {props.recipe.fields.map((field) => (
        <p key={field.key}>
          <strong>{field.label}</strong>:{" "}
          {String(props.state[field.key] ?? field.defaultValue ?? "—")}
        </p>
      ))}
    </section>
  );
}

type ResolvedZenBackground = {
  readonly style: CSSProperties;
  /**
   * True when the surface shows the system's own ground, which also renders
   * the design system's dot grid. The grid appears only here: over a user's
   * colour or imagery it would read as the app's texture on their choice.
   */
  readonly systemGround: boolean;
  /**
   * True when the space stands on the application's ground. The cloud is
   * drawn by the app's own backdrop over the theme's workspace colour, so
   * the dot grid stays off: two textures on one floor read as neither.
   */
  readonly appGround: boolean;
};

/* The theme's workspace ground. Used whenever no user choice paints the
   surface, so the safe fallback is the same ground every other surface
   stands on rather than a colour of Zen's own. */
/* Room the wall leaves for the surface's own floating chrome: the spaces pill
   above, and the Navigator bar (or its collapsed pill) below. */
const ZEN_WALL_INSET_TOP = 56;
const ZEN_WALL_INSET_BOTTOM = 88;
const ZEN_WALL_INSET_BOTTOM_COLLAPSED = 64;

const SYSTEM_GROUND = "var(--oct-bg)";

/**
 * A space stored with the old flat default never had a ground chosen for it,
 * so it stands on today's default picture, and the Appearance panel shows that
 * picture as the current choice rather than a colour nobody picked.
 */
function withCurrentDefaultGround(appearance: ZenAppearance): ZenAppearance {
  return appearance.background.kind === "solid" &&
    appearance.background.color.toLowerCase() === LEGACY_DEFAULT_ZEN_GROUND_COLOR
    ? { ...appearance, background: DEFAULT_ZEN_BACKGROUND }
    : appearance;
}

function resolveZenBackgroundStyle(
  background: ZenAppearance["background"],
  uploadedImageUrl?: string,
): ResolvedZenBackground {
  if (background.kind === "theme") {
    // The colour under the cloud is the theme's own workspace ground, the
    // same one the shell draws the cloud over, so a space configured this way
    // reads as the application rather than as a Zen colour that happens to
    // match it. What the cloud shows is the app's Background setting; nothing
    // about it is decided here.
    return { style: { backgroundColor: SYSTEM_GROUND }, systemGround: false, appGround: true };
  }
  if (background.kind === "solid") {
    return { style: { backgroundColor: background.color }, systemGround: false, appGround: false };
  }
  if (background.kind === "gradient") {
    const style = background.style ?? "linear";
    if (style === "radial") {
      return {
        style: {
          backgroundColor: background.to,
          backgroundImage: `radial-gradient(circle at 50% 40%, ${background.from}, ${background.to})`,
        },
        systemGround: false,
        appGround: false,
      };
    }
    if (style === "conic") {
      return {
        style: {
          backgroundColor: background.to,
          backgroundImage: `conic-gradient(from ${background.angle}deg, ${background.from}, ${background.to}, ${background.from})`,
        },
        systemGround: false,
        appGround: false,
      };
    }
    return {
      style: {
        backgroundColor: background.to,
        backgroundImage: `linear-gradient(${background.angle}deg, ${background.from}, ${background.to})`,
      },
      systemGround: false,
      appGround: false,
    };
  }
  if (background.kind === "builtin") {
    const preset = getZenBuiltinBackground(background.presetId);
    return {
      style: mediaBackgroundStyle(preset.src, background.fill ?? "cover"),
      systemGround: false,
      appGround: false,
    };
  }
  if (uploadedImageUrl === undefined) {
    // The chosen image is not readable here, so the surface stands on the
    // system ground until it is — the status line says which case this is.
    return { style: { backgroundColor: SYSTEM_GROUND }, systemGround: true, appGround: false };
  }
  return {
    style: mediaBackgroundStyle(uploadedImageUrl, background.fill ?? "cover"),
    systemGround: false,
    appGround: false,
  };
}

function sameGeometry(left: ZenGeometry, right: ZenGeometry): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

/**
 * The picture a space's pixel or dither effect prints, or null when the
 * effect is off or the ground is not a picture. An animated picture is
 * printed from its still frame: a canvas holds one frame, and a dithered
 * picture that moved would re-quantize every frame for nothing.
 */
function resolveGroundEffect(
  appearance: ZenAppearance,
  uploadedImageUrl: string | undefined,
): {
  readonly src: string;
  readonly fill: "cover" | "contain" | "tile";
  readonly effect: ZenGroundEffect;
} | null {
  const effect = appearance.groundEffect;
  if (effect === undefined || effect.kind === "none") return null;
  const background = appearance.background;
  if (background.kind === "builtin") {
    const preset = getZenBuiltinBackground(background.presetId);
    const src = "stillSrc" in preset ? preset.stillSrc : preset.src;
    return { src, fill: background.fill ?? "cover", effect };
  }
  if (background.kind === "image" && uploadedImageUrl !== undefined) {
    return { src: uploadedImageUrl, fill: background.fill ?? "cover", effect };
  }
  return null;
}

function mediaBackgroundStyle(src: string, fill: "cover" | "contain" | "tile"): CSSProperties {
  if (fill === "tile") {
    return {
      backgroundColor: SYSTEM_GROUND,
      backgroundImage: `url("${src}")`,
      backgroundPosition: "center",
      backgroundRepeat: "repeat",
      backgroundSize: "480px auto",
    };
  }
  return {
    backgroundColor: SYSTEM_GROUND,
    backgroundImage: `url("${src}")`,
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    backgroundSize: fill,
  };
}

/** Keeps a title bar's grab margin inside the desk on every side. */
const REACH_MARGIN_PX = 48;

/** True when a window's title bar cannot be reached on a desk this size. */
function outOfReach(
  geometry: ZenGeometry,
  surface: { readonly width: number; readonly height: number },
): boolean {
  return (
    geometry.x + geometry.width < REACH_MARGIN_PX ||
    geometry.x > surface.width - REACH_MARGIN_PX ||
    geometry.y < 0 ||
    geometry.y > surface.height - REACH_MARGIN_PX
  );
}

/** One thing the Add sheet can put on the desk: its mark over its name. */
function AddTile(props: {
  readonly icon: typeof MessageCircle;
  readonly label: string;
  readonly text: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly expanded?: boolean;
}) {
  const Icon = props.icon;
  return (
    <OctantButton
      {...(props.expanded === undefined ? {} : { "aria-expanded": props.expanded })}
      aria-label={props.label}
      className="zen-add__tile"
      disabled={props.disabled === true}
      onClick={props.onClick}
      type="button"
      variant="outline"
    >
      <Icon aria-hidden="true" size={20} />
      <span>{props.text}</span>
    </OctantButton>
  );
}

/** The kind of window, as the small mark before its title. */
function ZenElementIcon(props: { readonly kind: ZenElementPayload["kind"] }) {
  const Icon =
    props.kind === "thread"
      ? MessageCircle
      : props.kind === "terminal"
        ? SquareTerminal
        : props.kind === "notes"
          ? NotebookPen
          : props.kind === "checklist"
            ? ListChecks
            : props.kind === "timer"
              ? Timer
              : props.kind === "reference"
                ? Link2
                : props.kind === "canvas"
                  ? FileText
                  : Sparkles;
  return <Icon aria-hidden="true" className="zen-el-icon" size={14} strokeWidth={1.75} />;
}
