import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import { ChevronsDownUp, ChevronsUpDown, FileStack, PanelRightOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTooltip } from "../ui/base/OctantTooltip";
import { CanvasThreadReferenceCard as CanvasReferenceRow } from "./CanvasThreadReferenceCard";
import { CanvasView } from "./CanvasView";
import { canvasDigest } from "./canvasDigest";
import { useCanvasDefinition } from "./useCanvasDefinition";

const SHOWN_AS_CARD_KEY = "octant.canvas.shown-as-card.v1";
/** Oldest entries fall off first; the list never grows without bound. */
const MAX_SHOWN_AS_CARD = 500;

/**
 * Which inline Canvases the person folded to a card, kept in this window's
 * local storage. A view preference, not part of the Canvas: losing it only
 * unfolds a Canvas again, so no failure here may block the transcript.
 */
export function readCanvasesShownAsCard(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): ReadonlySet<string> {
  if (storage === undefined) return new Set();
  try {
    const raw = storage.getItem(SHOWN_AS_CARD_KEY);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    return new Set();
  }
}

export function rememberCanvasShownAsCard(
  canvasId: string,
  shownAsCard: boolean,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  if (storage === undefined) return;
  try {
    const others = [...readCanvasesShownAsCard(storage)].filter((entry) => entry !== canvasId);
    const next = shownAsCard ? [...others, canvasId].slice(-MAX_SHOWN_AS_CARD) : others;
    storage.setItem(SHOWN_AS_CARD_KEY, JSON.stringify(next));
  } catch {
    // The fold already happened on screen; remembering it is a convenience.
  }
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
 * A small Canvas drawn in the conversation that wrote it. It is a view of the
 * thread's Canvas, never a copy: it reads the current version from the host,
 * opens the same document in the sidebar, and leaves editing, comments and
 * sharing there. The body is read-only, so nothing here can journal a version.
 */
export function InlineThreadCanvas(props: InlineThreadCanvasProps) {
  const { card, client } = props;
  const canvasId = String(card.canvasId);
  const [shownAsCard, setShownAsCard] = useState(() => readCanvasesShownAsCard().has(canvasId));
  const loaded = useCanvasDefinition(client, card, !shownAsCard);
  const digest = loaded.kind === "ready" ? canvasDigest(loaded.definition) : undefined;
  const [clipped, setClipped] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // The body is capped rather than scrolled: a nested scroller would take the
  // wheel from the thread. Content past the cap fades into an offer to read
  // the whole Canvas in the sidebar.
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
  }, [loaded]);

  const fold = (next: boolean) => {
    rememberCanvasShownAsCard(canvasId, next);
    setShownAsCard(next);
  };
  const openLabel = props.openLabel ?? "Open in sidebar";
  const foldLabel = shownAsCard ? "Show in thread" : "Show as card";

  return (
    <section
      aria-label={`Canvas: ${card.title}`}
      className="thread-canvas"
      data-kind={digest?.kind}
      data-shown-as={shownAsCard ? "card" : "inline"}
      data-testid="thread-canvas"
    >
      <header className="thread-canvas__header">
        <FileStack aria-hidden="true" className="thread-canvas__icon" size={14} strokeWidth={1.8} />
        <h3 className="thread-canvas__title">{card.title}</h3>
        <div className="thread-canvas__actions">
          <OctantTooltip label={foldLabel} side="top">
            <OctantButton
              aria-expanded={!shownAsCard}
              aria-label={foldLabel}
              className="thread-canvas__action"
              onClick={() => fold(!shownAsCard)}
              size="icon"
              type="button"
              variant="ghost"
            >
              {shownAsCard ? (
                <ChevronsUpDown aria-hidden="true" size={14} strokeWidth={1.8} />
              ) : (
                <ChevronsDownUp aria-hidden="true" size={14} strokeWidth={1.8} />
              )}
            </OctantButton>
          </OctantTooltip>
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
      {shownAsCard ? null : loaded.kind === "loading" ? (
        <p className="thread-canvas__status" role="status">
          <span aria-hidden="true" className="spinner spinner-sm" />
          Loading Canvas
        </p>
      ) : loaded.kind === "unavailable" ? (
        <p className="thread-canvas__status" role="status">
          This Canvas can't be shown here. Open it to see why.
        </p>
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
          {clipped && props.onOpen !== undefined ? (
            <div className="thread-canvas__more">
              <OctantButton
                onClick={() => props.onOpen?.(card)}
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
 * The Canvases a turn wrote, after the row that turn ends on: an inline one
 * drawn in place, any other as the row that opens it.
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
      {props.cards.map((card) =>
        card.presentation === "inline" ? (
          <InlineThreadCanvas
            card={card}
            client={props.client}
            key={String(card.canvasId)}
            {...(props.onOpen === undefined ? {} : { onOpen: props.onOpen })}
            {...(props.openLabel === undefined ? {} : { openLabel: props.openLabel })}
          />
        ) : (
          <CanvasReferenceRow
            card={card}
            client={props.client}
            key={String(card.canvasId)}
            {...(props.onOpen === undefined ? {} : { onOpen: props.onOpen })}
          />
        ),
      )}
    </div>
  );
}
