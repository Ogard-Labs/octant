import type { BrowserAutomationSnapshot } from "@octant/contracts/browser-automation-rpc";
import { X } from "lucide-react";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { IconButton } from "../shell/IconButton";
import { OctantButton } from "../ui/base/OctantButton";

export type BrowserPreviewCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

const CORNER_STORAGE_KEY = "octant.browserPreview.corner";
const DEFAULT_CORNER: BrowserPreviewCorner = "top-right";
/** A press that moves less than this is a click, not the start of a drag. */
const DRAG_THRESHOLD_PX = 4;
/** Air kept between the preview and the composer it must never cover. */
const COMPOSER_CLEARANCE_PX = 12;
/** A tall phone page or a wide banner would otherwise stretch the preview. */
const MIN_ASPECT = 1.25;
const MAX_ASPECT = 1.9;
const DEFAULT_ASPECT = 1.6;

export interface BrowserPreviewThumbnailProps {
  readonly onClose: () => void;
  readonly onOpen?: () => void;
  readonly snapshot: BrowserAutomationSnapshot;
}

/**
 * A small live picture of the page an agent has open, shown only while the
 * Browser itself is out of sight. Opening it shows the Browser; it never takes
 * authority over the page. The corner it rests in is remembered, and its
 * bottom corners sit above the composer rather than over it.
 */
export function BrowserPreviewThumbnail(props: BrowserPreviewThumbnailProps) {
  const [corner, setCorner] = useState<BrowserPreviewCorner>(readStoredCorner);
  const [offset, setOffset] = useState<{ readonly x: number; readonly y: number }>();
  const root = useRef<HTMLDivElement>(null);
  const press = useRef<{
    readonly pointerId: number;
    readonly x: number;
    readonly y: number;
    moved: boolean;
  } | null>(null);
  const dragged = useRef(false);

  const observation = props.snapshot.observation;
  const picture = observation?.stale === false ? observation.screenshotDataUrl : undefined;
  const pageTitle = observation?.title;
  const pageHost = hostOf(observation?.url);
  const caption = pageTitle ?? pageHost;
  const pages = props.snapshot.contexts?.length ?? 1;
  const aspect = aspectOf(observation?.viewport);

  useComposerClearance(root);

  const rest = useCallback((next: BrowserPreviewCorner) => {
    setCorner(next);
    storeCorner(next);
    setOffset(undefined);
  }, []);

  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    press.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const current = press.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    const x = event.clientX - current.x;
    const y = event.clientY - current.y;
    if (!current.moved && Math.hypot(x, y) < DRAG_THRESHOLD_PX) return;
    current.moved = true;
    setOffset({ x, y });
  }

  function onPointerEnd(event: PointerEvent<HTMLButtonElement>) {
    const current = press.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    press.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (!current.moved) return;
    // The click that follows a drag's release is not a request to open.
    dragged.current = true;
    const element = root.current;
    const frame = element?.parentElement;
    if (element === null || element === undefined || frame === null || frame === undefined) {
      setOffset(undefined);
      return;
    }
    rest(nearestCorner(element.getBoundingClientRect(), frame.getBoundingClientRect()));
  }

  function onClick() {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    props.onOpen?.();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    // The drag has a keyboard twin: an arrow sends the preview to that side.
    const [vertical, horizontal] = corner.split("-") as ["top" | "bottom", "left" | "right"];
    const next =
      event.key === "ArrowLeft"
        ? `${vertical}-left`
        : event.key === "ArrowRight"
          ? `${vertical}-right`
          : event.key === "ArrowUp"
            ? `top-${horizontal}`
            : event.key === "ArrowDown"
              ? `bottom-${horizontal}`
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    rest(next as BrowserPreviewCorner);
  }

  return (
    <div
      aria-label="Browser preview"
      className="browser-pip window-no-drag"
      data-corner={corner}
      data-dragging={offset === undefined ? undefined : "true"}
      ref={root}
      role="group"
      style={
        {
          "--browser-pip-aspect": String(aspect),
          ...(offset === undefined ? {} : { transform: `translate(${offset.x}px, ${offset.y}px)` }),
        } as React.CSSProperties
      }
    >
      <OctantButton
        aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
        aria-label={caption === undefined ? "Open Browser" : `Open Browser: ${caption}`}
        className="browser-pip__open"
        onClick={onClick}
        onKeyDown={onKeyDown}
        onPointerCancel={onPointerEnd}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        type="button"
        variant="bare"
      >
        <span className="browser-pip__frame">
          {picture === undefined ? (
            <span aria-hidden="true" className="skeleton browser-pip__skeleton" />
          ) : (
            <img alt="" className="browser-pip__picture" draggable={false} src={picture} />
          )}
        </span>
        {caption === undefined ? null : <span className="browser-pip__caption">{caption}</span>}
        {pages > 1 ? <span className="browser-pip__count">{pages}</span> : null}
      </OctantButton>
      <IconButton
        className="browser-pip__close"
        icon={X}
        label="Hide Browser preview"
        onClick={props.onClose}
      />
    </div>
  );
}

/**
 * Keeps `--browser-pip-bottom` at the height the composer takes from the
 * frame's bottom edge, so a bottom corner rests above it. A frame with no
 * composer keeps the plain inset.
 */
function useComposerClearance(root: { readonly current: HTMLDivElement | null }) {
  useLayoutEffect(() => {
    const element = root.current;
    const frame = element?.parentElement;
    if (element === null || frame === null || frame === undefined) return;
    let observed: Element | null = null;
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(look);
    function look() {
      const composer = frame?.querySelector(".thread-composer") ?? null;
      if (frame === undefined || frame === null || element === null) return;
      if (composer !== observed) {
        if (observed !== null) observer?.unobserve(observed);
        if (composer !== null) observer?.observe(composer);
        observed = composer;
      }
      if (composer === null) {
        element.style.removeProperty("--browser-pip-bottom");
        return;
      }
      const clearance =
        frame.getBoundingClientRect().bottom -
        composer.getBoundingClientRect().top +
        COMPOSER_CLEARANCE_PX;
      element.style.setProperty("--browser-pip-bottom", `${Math.max(0, Math.round(clearance))}px`);
    }
    look();
    observer?.observe(frame);
    // The composer can mount a frame after the preview does.
    const settled = window.requestAnimationFrame(look);
    return () => {
      window.cancelAnimationFrame(settled);
      observer?.disconnect();
    };
  }, [root]);
}

function nearestCorner(box: DOMRect, frame: DOMRect): BrowserPreviewCorner {
  const centreX = box.left + box.width / 2;
  const centreY = box.top + box.height / 2;
  const vertical = centreY < frame.top + frame.height / 2 ? "top" : "bottom";
  const horizontal = centreX < frame.left + frame.width / 2 ? "left" : "right";
  return `${vertical}-${horizontal}`;
}

function aspectOf(viewport: { readonly width: number; readonly height: number } | undefined) {
  if (viewport === undefined) return DEFAULT_ASPECT;
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, viewport.width / viewport.height));
}

function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function readStoredCorner(): BrowserPreviewCorner {
  try {
    const stored = window.localStorage.getItem(CORNER_STORAGE_KEY);
    return stored === "top-left" ||
      stored === "top-right" ||
      stored === "bottom-left" ||
      stored === "bottom-right"
      ? stored
      : DEFAULT_CORNER;
  } catch {
    return DEFAULT_CORNER;
  }
}

function storeCorner(corner: BrowserPreviewCorner) {
  try {
    window.localStorage.setItem(CORNER_STORAGE_KEY, corner);
  } catch {
    // The corner is a convenience; a blocked store only forgets it.
  }
}
