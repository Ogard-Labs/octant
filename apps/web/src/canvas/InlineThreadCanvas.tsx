import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  FileStack,
  Maximize2,
  Minimize2,
  PanelRightOpen,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTooltip } from "../ui/base/OctantTooltip";
import { CanvasThreadReferenceCard as CanvasReferenceRow } from "./CanvasThreadReferenceCard";
import { CanvasView } from "./CanvasView";
import { canvasDigest } from "./canvasDigest";
import { useCanvasDefinition } from "./useCanvasDefinition";

const SHOWN_AS_CARD_KEY = "octant.canvas.shown-as-card.v1";
const EXPANDED_KEY = "octant.canvas.expanded.v1";
/** Oldest entries fall off first; a list never grows without bound. */
const MAX_REMEMBERED = 500;

/**
 * Which Canvases the person folded to a card or expanded, each kept as a list
 * in this window's local storage. A view preference, not part of the Canvas:
 * losing it only returns a Canvas to how the thread first showed it, so no
 * failure here may block the transcript.
 */
function readRememberedCanvases(
  key: string,
  storage: Pick<Storage, "getItem"> | undefined,
): ReadonlySet<string> {
  if (storage === undefined) return new Set();
  try {
    const raw = storage.getItem(key);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    return new Set();
  }
}

function rememberCanvas(
  key: string,
  canvasId: string,
  remembered: boolean,
  storage: Storage | undefined,
): void {
  if (storage === undefined) return;
  try {
    const others = [...readRememberedCanvases(key, storage)].filter((entry) => entry !== canvasId);
    const next = remembered ? [...others, canvasId].slice(-MAX_REMEMBERED) : others;
    storage.setItem(key, JSON.stringify(next));
  } catch {
    // The change already happened on screen; remembering it is a convenience.
  }
}

export function readCanvasesShownAsCard(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): ReadonlySet<string> {
  return readRememberedCanvases(SHOWN_AS_CARD_KEY, storage);
}

export function rememberCanvasShownAsCard(
  canvasId: string,
  shownAsCard: boolean,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  rememberCanvas(SHOWN_AS_CARD_KEY, canvasId, shownAsCard, storage);
}

export function readCanvasesExpanded(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): ReadonlySet<string> {
  return readRememberedCanvases(EXPANDED_KEY, storage);
}

export function rememberCanvasExpanded(
  canvasId: string,
  expanded: boolean,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  rememberCanvas(EXPANDED_KEY, canvasId, expanded, storage);
}

/**
 * How the thread shows one Canvas. `rest` is how the thread first shows it:
 * a capped, faded teaser when the agent asked for inline, otherwise a row.
 * `card` folds an inline Canvas to its header. `expanded` draws the whole
 * Canvas in place, for any Canvas, at the person's request.
 */
type ThreadCanvasView = "rest" | "card" | "expanded";

function initialView(canvasId: string, inline: boolean): ThreadCanvasView {
  if (readCanvasesExpanded().has(canvasId)) return "expanded";
  return inline && readCanvasesShownAsCard().has(canvasId) ? "card" : "rest";
}

export interface InlineThreadCanvasProps {
  readonly client: CanvasClient;
  readonly card: CanvasThreadReferenceCard;
  readonly onOpen?: (card: CanvasThreadReferenceCard) => void;
  /**
   * What opening does, in the person's words. Work and Code open the dock's
   * Canvas tool beside the thread; Chat has no dock and opens a Canvas tab.
   */
  readonly openLabel?: string;
}

/**
 * A Canvas drawn in the conversation that wrote it. It is a view of the
 * thread's Canvas, never a copy: it reads the current version from the host,
 * opens the same document in the sidebar, and leaves editing, comments and
 * sharing there. No layout, plan, comment, or action runtime reaches it, so
 * nothing drawn here can journal a version.
 *
 * Any Canvas can be expanded in place, including one the thread shows as a
 * row; the agent's choice of presentation only decides how it first appears.
 */
export function InlineThreadCanvas(props: InlineThreadCanvasProps) {
  const { card, client } = props;
  const canvasId = String(card.canvasId);
  const inline = card.presentation === "inline";
  const [view, setView] = useState<ThreadCanvasView>(() => initialView(canvasId, inline));
  const loaded = useCanvasDefinition(
    client,
    card,
    view !== "card" && (inline || view === "expanded"),
  );
  const digest = loaded.kind === "ready" ? canvasDigest(loaded.definition) : undefined;
  const [clipped, setClipped] = useState(false);
  const [wheelInCanvas, setWheelInCanvas] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const expanded = view === "expanded";

  // The body is capped rather than free to scroll: a nested scroller would
  // take the wheel from the thread. Content past the cap fades; expanded, it
  // scrolls only once the person focuses the region.
  useEffect(() => {
    const body = bodyRef.current;
    if (body === null || loaded.kind !== "ready") return;
    const measure = () => setClipped(body.scrollHeight > body.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    for (const child of body.children) observer.observe(child);
    return () => observer.disconnect();
  }, [loaded, view]);

  const show = (next: ThreadCanvasView) => {
    rememberCanvasExpanded(canvasId, next === "expanded");
    if (inline) rememberCanvasShownAsCard(canvasId, next === "card");
    setWheelInCanvas(false);
    setView(next);
  };

  if (!inline && !expanded) {
    return (
      <CanvasReferenceRow
        card={card}
        client={client}
        onExpand={() => show("expanded")}
        {...(props.onOpen === undefined ? {} : { onOpen: props.onOpen })}
      />
    );
  }

  const openLabel = props.openLabel ?? "Open in sidebar";
  // A row expanded in place folds straight back to its row, which is its card.
  const toggle = !inline
    ? { label: "Show as card", next: "rest" as const, icon: ChevronsDownUp }
    : expanded
      ? { label: "Collapse", next: "rest" as const, icon: Minimize2 }
      : { label: "Expand in thread", next: "expanded" as const, icon: Maximize2 };
  const ToggleIcon = toggle.icon;
  const foldLabel = view === "card" ? "Show in thread" : "Show as card";

  return (
    <section
      aria-label={`Canvas: ${card.title}`}
      className="thread-canvas"
      data-kind={digest?.kind}
      data-shown-as={view === "card" ? "card" : expanded ? "expanded" : "inline"}
      data-testid="thread-canvas"
    >
      <header className="thread-canvas__header">
        <FileStack aria-hidden="true" className="thread-canvas__icon" size={14} strokeWidth={1.8} />
        <h3 className="thread-canvas__title">{card.title}</h3>
        <div className="thread-canvas__actions">
          <OctantTooltip label={toggle.label} side="top">
            <OctantButton
              aria-label={toggle.label}
              className="thread-canvas__action"
              onClick={() => show(toggle.next)}
              ref={toggleRef}
              size="icon"
              type="button"
              variant="ghost"
            >
              <ToggleIcon aria-hidden="true" size={14} strokeWidth={1.8} />
            </OctantButton>
          </OctantTooltip>
          {inline ? (
            <OctantTooltip label={foldLabel} side="top">
              <OctantButton
                aria-expanded={view !== "card"}
                aria-label={foldLabel}
                className="thread-canvas__action"
                onClick={() => show(view === "card" ? "rest" : "card")}
                size="icon"
                type="button"
                variant="ghost"
              >
                {view === "card" ? (
                  <ChevronsUpDown aria-hidden="true" size={14} strokeWidth={1.8} />
                ) : (
                  <ChevronsDownUp aria-hidden="true" size={14} strokeWidth={1.8} />
                )}
              </OctantButton>
            </OctantTooltip>
          ) : null}
          {props.onOpen === undefined ? null : (
            <OctantTooltip label={openLabel} side="top">
              <OctantButton
                aria-label={openLabel}
                className="thread-canvas__action"
                onClick={() => props.onOpen?.(card)}
                size="icon"
                type="button"
                variant="ghost"
              >
                <PanelRightOpen aria-hidden="true" size={14} strokeWidth={1.8} />
              </OctantButton>
            </OctantTooltip>
          )}
        </div>
      </header>
      {view === "card" ? null : loaded.kind === "loading" ? (
        <p className="thread-canvas__status" role="status">
          <span aria-hidden="true" className="spinner spinner-sm" />
          Loading Canvas
        </p>
      ) : loaded.kind === "unavailable" ? (
        <p className="thread-canvas__status" role="status">
          This Canvas can't be shown here. Open it to see why.
        </p>
      ) : expanded ? (
        <div className="thread-canvas__viewport">
          {/* The thread keeps the wheel until the person focuses this region
              (a click or Tab); then it scrolls only the Canvas, and Escape
              hands the wheel back. */}
          <div
            aria-label={`${card.title} content`}
            className="thread-canvas__body"
            data-clipped={clipped ? "true" : "false"}
            data-wheel={wheelInCanvas ? "canvas" : "thread"}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setWheelInCanvas(false);
            }}
            onFocus={() => setWheelInCanvas(true)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              toggleRef.current?.focus({ preventScroll: true });
            }}
            ref={bodyRef}
            role="region"
            tabIndex={0}
          >
            <CanvasView input={loaded.definition} placement="thread" />
          </div>
        </div>
      ) : (
        <div className="thread-canvas__viewport">
          <div
            className="thread-canvas__body"
            data-clipped={clipped ? "true" : "false"}
            ref={bodyRef}
          >
            <CanvasView input={loaded.definition} placement="thread" />
          </div>
          {/* Outside the faded body, so the offer itself is never faded. */}
          {clipped ? (
            <div className="thread-canvas__more">
              <OctantButton
                onClick={() => show("expanded")}
                size="sm"
                type="button"
                variant="secondary"
              >
                Show the whole Canvas
              </OctantButton>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

/**
 * The Canvases a turn wrote, after the row that turn ends on: one the agent
 * asked to show inline drawn in place, any other as the row that opens it.
 * Either can be expanded in the thread.
 */
export function ThreadCanvases(props: {
  readonly cards: ReadonlyArray<CanvasThreadReferenceCard> | undefined;
  readonly client: CanvasClient;
  readonly onOpen?: (card: CanvasThreadReferenceCard) => void;
  readonly openLabel?: string;
}) {
  if (props.cards === undefined || props.cards.length === 0) return null;
  return (
    <div className="thread-canvas-list">
      {props.cards.map((card) => (
        <InlineThreadCanvas
          card={card}
          client={props.client}
          key={String(card.canvasId)}
          {...(props.onOpen === undefined ? {} : { onOpen: props.onOpen })}
          {...(props.openLabel === undefined ? {} : { openLabel: props.openLabel })}
        />
      ))}
    </div>
  );
}
