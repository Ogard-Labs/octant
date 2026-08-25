import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { resolveAccessibilityFallbacks, resolveZenLiveCardActivity } from "@octant/domain";
import type { ZenLiveCardActivity } from "@octant/domain";
import type {
  ZenAssistantSnapshot,
  ZenAppearance,
  ZenChecklistItemId,
  ZenElementPayload,
  ZenFocusZone,
  ZenGeometry,
  ZenSourceContext,
  ZenSpace,
  ZenSpaceId,
  ZenTimerAction,
  ZenThreadCatalogEntry,
  ZenThreadCatalogRef,
  ZenViewport,
} from "@octant/contracts/zen";
import {
  DEFAULT_ZEN_BACKGROUND,
  DEFAULT_ZEN_TIMER_DURATION_MS,
  getZenBuiltinBackground,
} from "@octant/contracts/zen";
import type { SettingsDeepLink } from "@octant/contracts";
import {
  UNSUPPORTED_NAVIGATOR_ASSISTANT,
  type NavigatorAssistantController,
} from "../navigator/useNavigatorAssistant";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCard } from "../ui/base/OctantCard";
import { OctantInput } from "../ui/base/OctantInput";
import { ZenAppearancePanel } from "./ZenAppearancePanel";
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
  computeZoomToFit,
  nudgeGeometry,
  resizeGeometry,
  translateGeometry,
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
  /** Adds a terminal owned by the focused Code thread to this space. */
  readonly onAddTerminal?: (sourceContext: ZenSourceContext) => void;
  /** Whether the focused Code thread is present in the current Code snapshot. */
  readonly canAddTerminal?: (sourceContext: ZenSourceContext) => boolean;
  /** Docks a research browser for the focused Work or Code thread. */
  readonly onAddBrowser?: (sourceContext: ZenSourceContext) => void;
  readonly onExpandBar: () => void;
  readonly onHideBar: () => void;
  readonly onCreateWidget?: (kind: "notes" | "checklist") => void;
  readonly onCreateReference?: (url: string, label?: string) => void;
  readonly onUploadBackground?: (file: File) => void;
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
  readonly onUpdateElement: (element: ZenElementPayload) => void;
  readonly onUpdateViewport: (viewport: ZenViewport) => void;
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
  readonly element: ZenElementPayload;
  readonly startX: number;
  readonly startY: number;
};

type PanInteraction = {
  readonly kind: "pan";
  readonly startX: number;
  readonly startY: number;
  readonly viewport: ZenViewport;
};

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
  const [interaction, setInteraction] = useState<ElementInteraction | PanInteraction | null>(null);
  const [previewGeometry, setPreviewGeometry] = useState<
    { readonly elementId: string; readonly geometry: ZenGeometry } | undefined
  >(undefined);
  const [previewViewport, setPreviewViewport] = useState<ZenViewport | undefined>(undefined);
  const [manualPanel, setManualPanel] = useState<"widgets" | "add" | "appearance" | null>(null);
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
  const appearance = useZenEffectiveAppearance(props.space.appearance);
  const sorted = useMemo(
    () => [...props.space.elements].sort((a, b) => a.zIndex - b.zIndex),
    [props.space.elements],
  );
  const { panX, panY, scale } = props.space.viewport;
  const background = appearance.background;
  const forceOpaque = appearance.reducedTransparency || appearance.increasedContrast;
  const focusedElement = props.space.elements.find(
    (element) => String(element.elementId) === focusedId,
  );
  const focusedThreadContext =
    focusedElement?.kind === "thread" ? focusedElement.sourceContext : undefined;
  const threadCardActivity = useMemo(() => {
    const focusedElementId = focusedElement?.elementId;
    const resolved = resolveZenLiveCardActivity({
      elements: props.space.elements,
      visibleRegion: computeVisibleRegion(props.space.viewport, surfaceSize),
      ...(focusedElementId === undefined ? {} : { focusedElementId }),
    });
    return new Map(resolved.map((card) => [String(card.elementId), card]));
  }, [focusedElement?.elementId, props.space.elements, props.space.viewport, surfaceSize]);

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

  const resolvedBackground = resolveZenBackgroundStyle(background, props.backgroundImageUrl);
  const overlay = Math.max(
    appearance.dimming,
    background.kind === "image" || background.kind === "builtin" ? background.overlay : 0,
  );

  function focusElement(element: ZenElementPayload): void {
    setFocusedId(element.elementId);
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
  ): void {
    if (element.locked) return;
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
      element: raised ?? element,
      startX: event.clientX,
      startY: event.clientY,
    });
  }

  function beginPan(event: PointerEvent<HTMLElement>): void {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    setInteraction({
      kind: "pan",
      startX: event.clientX,
      startY: event.clientY,
      viewport: props.space.viewport,
    });
  }

  function handlePointerMove(event: PointerEvent<HTMLElement>): void {
    if (interaction === null) return;
    const dx = event.clientX - interaction.startX;
    const dy = event.clientY - interaction.startY;
    if (interaction.kind === "pan") {
      setPreviewViewport({
        ...interaction.viewport,
        panX: interaction.viewport.panX + dx,
        panY: interaction.viewport.panY + dy,
      });
      return;
    }
    const contentDx = dx / scale;
    const contentDy = dy / scale;
    const nextGeometry =
      interaction.kind === "move"
        ? translateGeometry(interaction.element.geometry, contentDx, contentDy)
        : resizeGeometry(interaction.element.geometry, "se", contentDx, contentDy);
    setPreviewGeometry({
      elementId: interaction.element.elementId,
      geometry: clampGeometryToBounds(nextGeometry),
    });
  }

  function finishPointerInteraction(): void {
    if (interaction === null) return;
    if (interaction.kind === "pan") {
      if (previewViewport !== undefined) props.onUpdateViewport(previewViewport);
      setPreviewViewport(undefined);
      setInteraction(null);
      return;
    }
    const geometry =
      previewGeometry?.elementId === interaction.element.elementId
        ? previewGeometry.geometry
        : interaction.element.geometry;
    props.onUpdateElement({ ...interaction.element, geometry });
    setPreviewGeometry(undefined);
    setInteraction(null);
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

  return (
    <div
      aria-label="Zen workspace"
      className="zen-surface"
      onKeyDown={handleSurfaceKeyDown}
      onPointerDown={beginPan}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerInteraction}
      onPointerCancel={finishPointerInteraction}
      ref={surfaceRef}
      role="application"
      style={resolvedBackground.style}
      tabIndex={0}
    >
      {resolvedBackground.systemGround ? <div aria-hidden="true" className="zen-ground" /> : null}
      <div className="zen-surface__traffic-light-safe window-drag-region" aria-hidden="true" />
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
      <div
        className="zen-surface__canvas"
        onPointerDown={beginPan}
        style={{
          transform: `translate(${previewViewport?.panX ?? panX}px, ${previewViewport?.panY ?? panY}px) scale(${previewViewport?.scale ?? scale})`,
          transformOrigin: "0 0",
        }}
      >
        {sorted.map((element) => {
          const threadCard = element.kind === "thread" ? resolveThreadCard(element) : undefined;
          const title =
            element.kind === "terminal"
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
                <span>{title}</span>
                <span className="zen-el-gap" />
                <span
                  className="zen-el-actions window-no-drag"
                  onPointerDown={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <OctantButton
                    aria-label={`${element.minimized ? "Restore" : "Minimize"} ${title}`}
                    disabled={element.locked}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onUpdateElement({ ...element, minimized: !element.minimized });
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {element.minimized ? "Restore" : "Minimize"}
                  </OctantButton>
                  <OctantButton
                    aria-label={`Remove ${title}`}
                    disabled={element.locked}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onRemoveElement?.(element.elementId);
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Remove
                  </OctantButton>
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
                    ) : element.kind === "canvas" ? (
                      (props.renderCanvas?.({ element }) ?? (
                        <p role="status">This window cannot read a canvas.</p>
                      ))
                    ) : (
                      "Unsupported Zen element"
                    )}
                  </div>
                  <OctantButton
                    aria-label={`Resize ${title}`}
                    className="zen-el-grip window-no-drag"
                    disabled={element.locked}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => beginElementInteraction(event, element, "resize")}
                    size="icon"
                    style={{ zIndex: 3 }}
                    type="button"
                    variant="ghost"
                  />
                </>
              )}
            </div>
          );
        })}
      </div>

      {props.space.research === null || props.space.research === undefined
        ? null
        : props.renderResearchDock?.({ dock: props.space.research })}

      <div className="zen-bar zen-surface__controls window-no-drag">
        <OctantButton
          aria-label="Zoom out"
          onClick={() =>
            props.onUpdateViewport({
              ...props.space.viewport,
              scale: Math.max(0.1, props.space.viewport.scale / 1.2),
            })
          }
          size="sm"
          type="button"
          variant="ghost"
        >
          −
        </OctantButton>
        <OctantButton
          aria-label="Zoom in"
          onClick={() =>
            props.onUpdateViewport({
              ...props.space.viewport,
              scale: Math.min(5, props.space.viewport.scale * 1.2),
            })
          }
          size="sm"
          type="button"
          variant="ghost"
        >
          +
        </OctantButton>
        <OctantButton
          onClick={() =>
            props.onUpdateViewport(
              computeZoomToFit(props.space.elements, { width: 1200, height: 800 }, 48),
            )
          }
          size="sm"
          type="button"
          variant="ghost"
        >
          Zoom to Fit
        </OctantButton>
        <OctantButton
          onClick={() => props.onUpdateViewport({ panX: 0, panY: 0, scale: 1 })}
          size="sm"
          type="button"
          variant="ghost"
        >
          Reset view
        </OctantButton>
      </div>

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
          aria-label={manualPanel === "appearance" ? "Zen appearance" : "Zen additions"}
          className="zen-panel zen-surface__manual-panel window-no-drag px-6"
          role="dialog"
        >
          <header className="card-head">
            <h2>
              {manualPanel === "appearance"
                ? "Appearance"
                : manualPanel === "widgets"
                  ? "Widgets"
                  : "Add"}
            </h2>
            <OctantButton onClick={() => setManualPanel(null)} type="button" variant="ghost">
              Close
            </OctantButton>
          </header>
          {manualPanel === "appearance" ? (
            <ZenAppearancePanel
              appearance={props.space.appearance}
              {...(props.onUpdateAppearance === undefined
                ? {}
                : { onUpdateAppearance: props.onUpdateAppearance })}
              {...(props.onUploadBackground === undefined
                ? {}
                : { onUploadBackground: props.onUploadBackground })}
            />
          ) : (
            <>
              {manualPanel === "add" ? (
                <div className="zen-add-picker">
                  <OctantButton
                    onClick={() => props.onOpenThreads?.()}
                    type="button"
                    variant="secondary"
                  >
                    Pin a thread
                  </OctantButton>
                  <OctantButton
                    aria-label="Add terminal"
                    disabled={
                      props.onAddTerminal === undefined ||
                      focusedThreadContext?.threadKind !== "code" ||
                      props.canAddTerminal?.(focusedThreadContext) === false
                    }
                    onClick={() => {
                      if (focusedThreadContext?.threadKind !== "code") return;
                      props.onAddTerminal?.(focusedThreadContext);
                      setManualPanel(null);
                    }}
                    type="button"
                    variant="secondary"
                  >
                    Add terminal
                  </OctantButton>
                  <OctantButton
                    aria-label="Add browser"
                    disabled={
                      props.onAddBrowser === undefined ||
                      (focusedThreadContext?.threadKind !== "code" &&
                        focusedThreadContext?.threadKind !== "work")
                    }
                    onClick={() => {
                      if (
                        focusedThreadContext?.threadKind !== "code" &&
                        focusedThreadContext?.threadKind !== "work"
                      ) {
                        return;
                      }
                      props.onAddBrowser?.(focusedThreadContext);
                      setManualPanel(null);
                    }}
                    type="button"
                    variant="secondary"
                  >
                    Add browser
                  </OctantButton>
                  {focusedThreadContext === undefined ? (
                    <p className="zen-add-picker__hint" role="status">
                      Focus a thread card to add its terminal or browser.
                    </p>
                  ) : focusedThreadContext.threadKind === "code" &&
                    props.canAddTerminal?.(focusedThreadContext) === false ? (
                    <p className="zen-add-picker__hint" role="status">
                      This Code thread cannot add a terminal right now.
                    </p>
                  ) : focusedThreadContext.threadKind === "code" ? (
                    <p className="zen-add-picker__hint" role="status">
                      Add terminal pins the existing Code terminal. Start one from Code first.
                    </p>
                  ) : null}
                </div>
              ) : null}
              {manualPanel === "widgets" ? (
                <>
                  <div className="zen-widget-picker">
                    <OctantButton
                      aria-label="Add Notes"
                      disabled={props.onCreateWidget === undefined}
                      onClick={() => {
                        props.onCreateWidget?.("notes");
                        setManualPanel(null);
                      }}
                      type="button"
                      variant="secondary"
                    >
                      Notes
                    </OctantButton>
                    <OctantButton
                      aria-label="Add Checklist"
                      disabled={props.onCreateWidget === undefined}
                      onClick={() => {
                        props.onCreateWidget?.("checklist");
                        setManualPanel(null);
                      }}
                      type="button"
                      variant="secondary"
                    >
                      Checklist
                    </OctantButton>
                    <label>
                      Reference URL
                      <OctantInput
                        aria-label="Reference URL"
                        onChange={(event) => setReferenceUrl(event.currentTarget.value)}
                        type="url"
                        value={referenceUrl}
                      />
                    </label>
                    <label>
                      Reference label
                      <OctantInput
                        aria-label="Reference label"
                        onChange={(event) => setReferenceLabel(event.currentTarget.value)}
                        type="text"
                        value={referenceLabel}
                      />
                    </label>
                    <OctantButton
                      aria-label="Add Reference"
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
                      type="button"
                      variant="secondary"
                    >
                      Reference
                    </OctantButton>
                  </div>
                  <div className="zen-panel__timer-create">
                    <label>
                      Timer duration in minutes
                      <OctantInput
                        aria-label="Timer duration in minutes"
                        max="480"
                        min="1"
                        onChange={(event) => setTimerMinutes(Number(event.currentTarget.value))}
                        type="number"
                        value={timerMinutes}
                      />
                    </label>
                    <OctantButton
                      aria-label="Add timer"
                      disabled={
                        !Number.isInteger(timerMinutes) || timerMinutes < 1 || timerMinutes > 480
                      }
                      onClick={() => {
                        props.onAddTimer?.(timerMinutes * 60 * 1000);
                        setManualPanel(null);
                      }}
                      type="button"
                      variant="secondary"
                    >
                      Add timer
                    </OctantButton>
                  </div>
                  <p>Notes, Checklists, and Timers stay local to this Zen space.</p>
                </>
              ) : null}
            </>
          )}
        </OctantCard>
      )}

      <div className="zen-surface__bar-anchor window-no-drag">
        <ZenBar
          collapsed={props.barCollapsed}
          onAskNavigatorAssistant={(prompt) => {
            void (async () => {
              // Opening binds this window's assistant surface to the
              // conversation, so the turn waits for it rather than racing it.
              await props.onOpenAssistant?.();
              await navigatorAssistant.send(prompt);
            })();
          }}
          onExit={props.onExit}
          onExpand={props.onExpandBar}
          onHide={props.onHideBar}
          {...(props.onOpenAssistant === undefined
            ? {}
            : { onOpenActivity: props.onOpenAssistant })}
          onOpenAdd={() => setManualPanel("add")}
          onOpenAppearance={() => setManualPanel("appearance")}
          onOpenThreads={() => props.onOpenThreads?.()}
          onOpenWidgets={() => setManualPanel("widgets")}
          providerLabel={
            props.assistant?.provider === null || props.assistant?.provider === undefined
              ? "Navigator"
              : `${props.assistant.provider.providerLabel} · ${props.assistant.provider.modelLabel}`
          }
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
};

/* The theme's workspace ground. Used whenever no user choice paints the
   surface, so the safe fallback is the same ground every other surface
   stands on rather than a colour of Zen's own. */
const SYSTEM_GROUND = "var(--oct-bg)";

/* The contract's default is a stored solid colour, not a "no choice"
   marker, so that colour is what identifies an unconfigured ground. */
const DEFAULT_GROUND_COLOR =
  DEFAULT_ZEN_BACKGROUND.kind === "solid" ? DEFAULT_ZEN_BACKGROUND.color : null;

function resolveZenBackgroundStyle(
  background: ZenAppearance["background"],
  uploadedImageUrl?: string,
): ResolvedZenBackground {
  if (background.kind === "solid") {
    if (background.color === DEFAULT_GROUND_COLOR) {
      return { style: { backgroundColor: SYSTEM_GROUND }, systemGround: true };
    }
    return { style: { backgroundColor: background.color }, systemGround: false };
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
      };
    }
    if (style === "conic") {
      return {
        style: {
          backgroundColor: background.to,
          backgroundImage: `conic-gradient(from ${background.angle}deg, ${background.from}, ${background.to}, ${background.from})`,
        },
        systemGround: false,
      };
    }
    return {
      style: {
        backgroundColor: background.to,
        backgroundImage: `linear-gradient(${background.angle}deg, ${background.from}, ${background.to})`,
      },
      systemGround: false,
    };
  }
  if (background.kind === "builtin") {
    const preset = getZenBuiltinBackground(background.presetId);
    return {
      style: mediaBackgroundStyle(preset.src, background.fill ?? "cover"),
      systemGround: false,
    };
  }
  if (uploadedImageUrl === undefined) {
    // The chosen image is not readable here, so the surface stands on the
    // system ground until it is — the status line says which case this is.
    return { style: { backgroundColor: SYSTEM_GROUND }, systemGround: true };
  }
  return {
    style: mediaBackgroundStyle(uploadedImageUrl, background.fill ?? "cover"),
    systemGround: false,
  };
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
