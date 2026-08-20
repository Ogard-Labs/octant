import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
  type VirtualItem,
} from "@tanstack/react-virtual";
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";

/**
 * Windowed transcript rows.
 *
 * `content-visibility` still mounts every React row, so a long thread's memory
 * grows with scrollback. A hand-rolled variable-height virtualizer is a known
 * source of jump and overlap bugs. TanStack Virtual is MIT-licensed, measures
 * each row, and now owns the chat scroll contract (`anchorTo: "end"` plus
 * `followOnAppend`) so streaming sticks to the bottom until the reader scrolls
 * up.
 */
export interface TranscriptWindowProps<T> {
  readonly items: ReadonlyArray<T>;
  readonly itemKey: (item: T, index: number) => string;
  readonly renderItem: (item: T, index: number) => ReactNode;
  /** Identifies the thread so leaving and returning restores this scroll offset. */
  readonly restoreKey: string;
  readonly estimateSize?: number;
  readonly overscan?: number;
  readonly gap?: number;
  readonly className?: string;
  readonly listClassName?: string;
  readonly listLabel?: string;
  readonly listRole?: "log" | "list";
  readonly listTag?: "div" | "ol";
  readonly itemTag?: "div" | "li";
  readonly revealKey?: string;
  readonly role?: "log" | "region";
  readonly ariaLive?: "polite";
  readonly ariaLabel?: string;
  readonly lead?: ReactNode;
  readonly trail?: ReactNode;
  readonly style?: CSSProperties;
}

interface TranscriptScrollMemory {
  readonly offset: number;
  readonly measurements: ReadonlyArray<VirtualItem>;
}

const scrollMemory = new Map<string, TranscriptScrollMemory>();

/** How close to the end still counts as following new output. Matches Chat's previous threshold. */
const FOLLOW_THRESHOLD_PX = 72;

const DEFAULT_ESTIMATE_SIZE = 96;
const DEFAULT_OVERSCAN = 8;

export function TranscriptWindow<T>(props: TranscriptWindowProps<T>) {
  const estimateSize = props.estimateSize ?? DEFAULT_ESTIMATE_SIZE;
  const overscan = props.overscan ?? DEFAULT_OVERSCAN;
  const gap = props.gap ?? 0;
  const ListTag = props.listTag ?? "div";
  const ItemTag = props.itemTag ?? "div";
  const scrollElementRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [findActive, setFindActive] = useState(false);
  const items = props.items;
  const itemKey = props.itemKey;
  const restoreKey = props.restoreKey;
  const revealKey = props.revealKey;
  const restored = scrollMemory.get(restoreKey);
  const revealIndex =
    revealKey === undefined
      ? -1
      : items.findIndex((item, index) => itemKey(item, index) === revealKey);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => estimateSize,
    overscan: findActive ? Math.max(overscan, items.length) : overscan,
    gap,
    scrollMargin,
    scrollEndThreshold: FOLLOW_THRESHOLD_PX,
    anchorTo: "end",
    followOnAppend: true,
    useFlushSync: false,
    getItemKey: (index) => {
      const item = items[index];
      return item === undefined ? String(index) : itemKey(item, index);
    },
    rangeExtractor: (range) => {
      const extracted = findActive ? allIndexes(range) : defaultRangeExtractor(range);
      if (revealIndex < 0 || extracted.includes(revealIndex)) return extracted;
      return [...extracted, revealIndex].sort((left, right) => left - right);
    },
    initialOffset: restored?.offset ?? 0,
    initialMeasurementsCache: restored === undefined ? [] : [...restored.measurements],
    scrollToFn: scrollTranscriptTo,
  });

  useLayoutEffect(() => {
    const list = listRef.current;
    const scroll = scrollElementRef.current;
    if (list === null || scroll === null) return;
    const update = () => {
      setScrollMargin(offsetWithinScrollParent(list, scroll));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(list);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [scrollElementRef, items.length]);

  useLayoutEffect(() => {
    return () => {
      const offset = virtualizer.scrollOffset;
      if (offset === null) return;
      scrollMemory.set(restoreKey, {
        offset,
        measurements: virtualizer.takeSnapshot(),
      });
    };
  }, [restoreKey, virtualizer]);

  const didFollowStartRef = useRef(false);
  useLayoutEffect(() => {
    didFollowStartRef.current = false;
  }, [restoreKey]);
  useLayoutEffect(() => {
    if (restored !== undefined || items.length === 0 || didFollowStartRef.current) return;
    virtualizer.scrollToEnd();
    didFollowStartRef.current = true;
  }, [items.length, restoreKey, restored, virtualizer]);

  useLayoutEffect(() => {
    if (revealKey === undefined) return;
    const index = items.findIndex((item, itemIndex) => itemKey(item, itemIndex) === revealKey);
    if (index < 0) return;
    virtualizer.scrollToIndex(index, { align: "center" });
  }, [itemKey, items, revealKey, virtualizer]);

  useLayoutEffect(() => {
    function onFindShortcut(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return;
      // Expand before Chromium's in-page find runs so off-window rows are in the DOM.
      flushSync(() => setFindActive(true));
    }
    function onLeaveFind(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setFindActive(false);
    }
    window.addEventListener("keydown", onFindShortcut, true);
    window.addEventListener("keydown", onLeaveFind);
    return () => {
      window.removeEventListener("keydown", onFindShortcut, true);
      window.removeEventListener("keydown", onLeaveFind);
    };
  }, []);

  useLayoutEffect(() => {
    setFindActive(false);
  }, [restoreKey]);

  const list = (
    <ListTag
      {...(props.listLabel === undefined ? {} : { "aria-label": props.listLabel })}
      className={props.listClassName}
      ref={(node: HTMLElement | null) => {
        listRef.current = node;
      }}
      {...(props.listRole === undefined ? {} : { role: props.listRole })}
      style={{
        height: virtualizer.getTotalSize(),
        position: "relative",
        width: "100%",
      }}
    >
      {virtualizer.getVirtualItems().map((virtualItem) => {
        const item = items[virtualItem.index];
        if (item === undefined) return null;
        return (
          <ItemTag
            data-index={virtualItem.index}
            data-transcript-row=""
            key={virtualItem.key}
            ref={virtualizer.measureElement}
            style={{
              left: 0,
              position: "absolute",
              top: 0,
              transform: `translateY(${String(virtualItem.start - scrollMargin)}px)`,
              width: "100%",
            }}
          >
            {props.renderItem(item, virtualItem.index)}
          </ItemTag>
        );
      })}
    </ListTag>
  );

  return (
    <div
      className={props.className}
      data-transcript-window=""
      ref={scrollElementRef}
      {...(props.ariaLabel === undefined ? {} : { "aria-label": props.ariaLabel })}
      {...(props.role === undefined ? {} : { role: props.role })}
      {...(props.ariaLive === undefined ? {} : { "aria-live": props.ariaLive })}
      style={props.style}
    >
      {props.lead}
      {list}
      {props.trail}
    </div>
  );
}

function scrollTranscriptTo(
  offset: number,
  options: { readonly adjustments?: number },
  instance: { readonly scrollElement: Element | Window | null },
): void {
  const element = instance.scrollElement;
  if (!(element instanceof HTMLElement)) return;
  element.scrollTop = Math.max(0, offset + (options.adjustments ?? 0));
}

function allIndexes(range: Range): number[] {
  return Array.from({ length: range.count }, (_, index) => index);
}

function offsetWithinScrollParent(element: HTMLElement, scrollParent: HTMLElement): number {
  const parentRect = scrollParent.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  return elementRect.top - parentRect.top + scrollParent.scrollTop;
}

/** Test seam: forget saved offsets so restoration cases start from an empty map. */
export function resetTranscriptScrollMemory(): void {
  scrollMemory.clear();
}
