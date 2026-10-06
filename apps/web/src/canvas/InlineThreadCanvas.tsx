import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasDefinition } from "@octant/contracts/canvas";
import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import { PanelRightOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { CanvasView } from "./CanvasView";

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

type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly definition: CanvasDefinition }
  | { readonly kind: "unavailable" };

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
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [clipped, setClipped] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (shownAsCard) return;
    let cancelled = false;
    setLoaded({ kind: "loading" });
    void client
      .get(card.canvasId)
      .then((outcome) => {
        if (cancelled) return;
        setLoaded(
          outcome.kind === "ready"
            ? { kind: "ready", definition: outcome.version.definition }
            : { kind: "unavailable" },
        );
      })
      .catch(() => {
        if (!cancelled) setLoaded({ kind: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
    // The version id changes when the Canvas is revised; read it again then.
  }, [card.canvasId, card.versionId, client, shownAsCard]);

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
  const openButton =
    props.onOpen === undefined ? null : (
      <OctantButton onClick={() => props.onOpen?.(card)} size="sm" type="button" variant="ghost">
        <PanelRightOpen aria-hidden="true" size={14} strokeWidth={1.8} />
        {props.openLabel ?? "Open in sidebar"}
      </OctantButton>
    );

  return (
    <section
      aria-label={`Canvas: ${card.title}`}
      className="thread-canvas"
      data-shown-as={shownAsCard ? "card" : "inline"}
      data-testid="thread-canvas"
    >
      <header className="thread-canvas__header">
        <h3 className="thread-canvas__title">{card.title}</h3>
        <div className="thread-canvas__actions">
          <OctantButton onClick={() => fold(!shownAsCard)} size="sm" type="button" variant="ghost">
            {shownAsCard ? "Show in thread" : "Show as card"}
          </OctantButton>
          {openButton}
        </div>
      </header>
      {shownAsCard ? null : loaded.kind === "loading" ? (
        <p className="thread-canvas__status">Loading Canvas…</p>
      ) : loaded.kind === "unavailable" ? (
        <p className="thread-canvas__status">
          This Canvas can't be shown here. Open it in the sidebar to see why.
        </p>
      ) : (
        <>
          <div
            className="thread-canvas__body"
            data-clipped={clipped ? "true" : "false"}
            ref={bodyRef}
          >
            <CanvasView input={loaded.definition} placement="thread" />
          </div>
          {clipped && props.onOpen !== undefined ? (
            <div className="thread-canvas__more">
              <OctantButton
                onClick={() => props.onOpen?.(card)}
                size="sm"
                type="button"
                variant="outline"
              >
                Read the whole Canvas
              </OctantButton>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

/** The inline Canvases a turn wrote, drawn after the row that turn ends on. */
export function InlineThreadCanvases(props: {
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
