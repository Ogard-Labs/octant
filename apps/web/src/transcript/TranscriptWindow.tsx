import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
  type VirtualItem,
} from "@tanstack/react-virtual";
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
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
  readonly listRole?: "list";
  readonly listTag?: "div" | "ol";
  readonly itemTag?: "div" | "li";
  readonly revealKey?: string;
  /**
   * Keys that must stay mounted even when they leave the window. Chat uses this
   * for the turn being edited so the draft is not discarded by recycling.
   */
  readonly pinnedKeys?: ReadonlyArray<string>;
  /**
   * Chat follows new output at the bottom. Code opens a nonempty transcript at
   * the top and stays there until the reader scrolls.
   */
  readonly align?: "start" | "end";
  readonly role?: "log" | "region";
  readonly ariaLabel?: string;
  readonly lead?: ReactNode;
  readonly trail?: ReactNode;
  readonly style?: CSSProperties;
  /** Accessible name for a newly appended row, announced only on append. */
  readonly announceItem?: (item: T, index: number) => string;
}

interface TranscriptScrollMemory {
  readonly offset: number;
  readonly measurements: ReadonlyArray<VirtualItem>;
  readonly following: boolean;
}

const scrollMemory = new Map<string, TranscriptScrollMemory>();

/** How close to the end still counts as following new output. Matches Chat's previous threshold. */
const FOLLOW_THRESHOLD_PX = 72;

const DEFAULT_ESTIMATE_SIZE = 96;
const DEFAULT_OVERSCAN = 8;
/** Visiting many threads must not retain every snapshot for the session. */
const MAX_SCROLL_MEMORY = 16;

const ROW_FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])";

/** Chromium's find UI close button never sends Escape; tests and hosts dispatch this. */
export const TRANSCRIPT_FIND_CLOSED_EVENT = "transcriptfindclose";

export function TranscriptWindow<T>(props: TranscriptWindowProps<T>) {
  const estimateSize = props.estimateSize ?? DEFAULT_ESTIMATE_SIZE;
  const overscan = props.overscan ?? DEFAULT_OVERSCAN;
  const gap = props.gap ?? 0;
  const align = props.align ?? "end";
  const ListTag = props.listTag ?? "div";
  const ItemTag = props.itemTag ?? "div";
  const scrollElementRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLElement | null>(null);
  const leadRef = useRef<HTMLDivElement>(null);
  const trailRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [trailSize, setTrailSize] = useState(0);
  const [findActive, setFindActive] = useState(false);
  const [stickyIndexes, setStickyIndexes] = useState<ReadonlySet<number>>(() => new Set());
  const [liveMessage, setLiveMessage] = useState("");
  const items = props.items;
  const itemKey = props.itemKey;
  const restoreKey = props.restoreKey;
  const revealKey = props.revealKey;
  const restored = scrollMemory.get(restoreKey);
  const followingRef = useRef(
    restored?.following === true || (restored === undefined && align === "end"),
  );
  const appliedRevealKeyRef = useRef<string | undefined>(undefined);
  const sawFindMatchRef = useRef(false);
  const pendingFocusRef = useRef<
    { readonly index: number; readonly edge: "start" | "end" } | undefined
  >(undefined);
  const prevCountRef = useRef(items.length);
  const revealIndex =
    revealKey === undefined
      ? -1
      : items.findIndex((item, index) => itemKey(item, index) === revealKey);

  const pinnedFromKeys = new Set<number>();
  if (props.pinnedKeys !== undefined) {
    for (const key of props.pinnedKeys) {
      const index = items.findIndex((item, itemIndex) => itemKey(item, itemIndex) === key);
      if (index >= 0) pinnedFromKeys.add(index);
    }
  }

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => estimateSize,
    overscan: findActive ? Math.max(overscan, items.length) : overscan,
    gap,
    scrollMargin,
    scrollEndThreshold: FOLLOW_THRESHOLD_PX,
    ...(align === "end" ? { anchorTo: "end" as const, followOnAppend: true } : {}),
    useFlushSync: false,
    getItemKey: (index) => {
      const item = items[index];
      return item === undefined ? String(index) : itemKey(item, index);
    },
    rangeExtractor: (range) => {
      const extracted = findActive ? allIndexes(range) : defaultRangeExtractor(range);
      const extra = new Set<number>();
      if (revealIndex >= 0) extra.add(revealIndex);
      const pending = pendingFocusRef.current?.index;
      if (pending !== undefined) extra.add(pending);
      for (const index of stickyIndexes) extra.add(index);
      for (const index of pinnedFromKeys) extra.add(index);
      if (extra.size === 0) return extracted;
      const merged = new Set(extracted);
      for (const index of extra) {
        if (index >= 0 && index < range.count) merged.add(index);
      }
      return [...merged].sort((left, right) => left - right);
    },
    initialOffset: restored === undefined || restored.following ? 0 : restored.offset,
    initialMeasurementsCache: restored === undefined ? [] : [...restored.measurements],
    scrollToFn: scrollTranscriptTo,
  });

  useLayoutEffect(() => {
    const list = listRef.current;
    const scroll = scrollElementRef.current;
    if (list === null || scroll === null) return;
    const update = () => {
      setScrollMargin(computeScrollMargin(scroll, leadRef.current));
      const trail = trailRef.current;
      setTrailSize(trail === null ? 0 : trail.offsetHeight);
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(list);
    observer.observe(scroll);
    if (leadRef.current !== null) observer.observe(leadRef.current);
    if (trailRef.current !== null) observer.observe(trailRef.current);
    return () => observer.disconnect();
  }, [items.length, props.lead, props.trail]);

  useLayoutEffect(() => {
    return () => {
      const offset = virtualizer.scrollOffset;
      if (offset === null) return;
      rememberScroll(restoreKey, {
        offset,
        measurements: virtualizer.takeSnapshot(),
        following: followingRef.current,
      });
    };
  }, [restoreKey, virtualizer]);

  useLayoutEffect(() => {
    followingRef.current =
      restored?.following === true || (restored === undefined && align === "end");
    appliedRevealKeyRef.current = undefined;
    setStickyIndexes(new Set());
    setLiveMessage("");
    prevCountRef.current = items.length;
  }, [restoreKey]);

  useLayoutEffect(() => {
    const scroll = scrollElementRef.current;
    if (scroll === null || align !== "end" || !followingRef.current) return;
    scrollToContentEnd(scroll);
  }, [align, items.length, restoreKey, trailSize, scrollMargin, virtualizer]);

  useLayoutEffect(() => {
    if (revealKey === undefined || revealKey === appliedRevealKeyRef.current) return;
    const index = items.findIndex((item, itemIndex) => itemKey(item, itemIndex) === revealKey);
    if (index < 0) return;
    virtualizer.scrollToIndex(index, { align: "center" });
    appliedRevealKeyRef.current = revealKey;
  }, [itemKey, items, revealKey, virtualizer]);

  useLayoutEffect(() => {
    const previous = prevCountRef.current;
    prevCountRef.current = items.length;
    if (items.length <= previous) return;
    const appended = items[items.length - 1];
    if (appended === undefined) return;
    setLiveMessage(
      props.announceItem === undefined
        ? "New message"
        : props.announceItem(appended, items.length - 1),
    );
  }, [items, props.announceItem]);

  useLayoutEffect(() => {
    function onFindShortcut(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return;
      // Expand before Chromium's in-page find runs so off-window rows are in the DOM.
      sawFindMatchRef.current = false;
      flushSync(() => setFindActive(true));
    }
    function onLeaveFind(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setFindActive(false);
    }
    function onFindClosed() {
      setFindActive(false);
    }
    function onSelectionChange() {
      // Chromium's find-in-page close button does not send Escape. A match
      // selects text; dismissing find then collapses the selection.
      if (!findActive) return;
      const selection = document.getSelection();
      if (selection !== null && !selection.isCollapsed) {
        sawFindMatchRef.current = true;
        return;
      }
      if (!sawFindMatchRef.current) return;
      setFindActive(false);
    }
    window.addEventListener("keydown", onFindShortcut, true);
    window.addEventListener("keydown", onLeaveFind);
    window.addEventListener(TRANSCRIPT_FIND_CLOSED_EVENT, onFindClosed);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      window.removeEventListener("keydown", onFindShortcut, true);
      window.removeEventListener("keydown", onLeaveFind);
      window.removeEventListener(TRANSCRIPT_FIND_CLOSED_EVENT, onFindClosed);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [findActive]);

  useLayoutEffect(() => {
    setFindActive(false);
  }, [restoreKey]);

  useLayoutEffect(() => {
    const scroll = scrollElementRef.current;
    if (scroll === null) return;
    function onToggle(event: Event): void {
      if (!(event.target instanceof HTMLDetailsElement)) return;
      const index = rowIndexFromTarget(event.target);
      if (index === undefined) return;
      if (event.target.open) {
        pinIndex(index);
        return;
      }
      const row = event.target.closest("[data-transcript-row]");
      if (row instanceof HTMLElement && row.querySelector("details[open]") !== null) return;
      if (row instanceof HTMLElement && row.contains(document.activeElement)) return;
      unpinIndex(index);
    }
    scroll.addEventListener("toggle", onToggle, true);
    return () => scroll.removeEventListener("toggle", onToggle, true);
  }, []);

  useLayoutEffect(() => {
    const pending = pendingFocusRef.current;
    if (pending === undefined) return;
    const scroll = scrollElementRef.current;
    if (scroll === null) return;
    const row = scroll.querySelector(
      `[data-transcript-row][data-index="${String(pending.index)}"]`,
    );
    if (!(row instanceof HTMLElement)) return;
    const focusable = row.querySelectorAll<HTMLElement>(ROW_FOCUSABLE);
    const target = pending.edge === "start" ? focusable[0] : focusable[focusable.length - 1];
    pendingFocusRef.current = undefined;
    target?.focus();
  }, [virtualizer.getVirtualItems()]);

  function pinIndex(index: number): void {
    setStickyIndexes((current) => {
      if (current.has(index)) return current;
      const next = new Set(current);
      next.add(index);
      return next;
    });
  }

  function unpinIndex(index: number): void {
    setStickyIndexes((current) => {
      if (!current.has(index)) return current;
      const next = new Set(current);
      next.delete(index);
      return next;
    });
  }

  function rowIndexFromTarget(target: EventTarget | null): number | undefined {
    if (!(target instanceof Element)) return undefined;
    const row = target.closest("[data-transcript-row]");
    if (!(row instanceof HTMLElement)) return undefined;
    const index = Number(row.dataset.index);
    return Number.isInteger(index) ? index : undefined;
  }

  function onFocusIn(event: { readonly target: EventTarget | null }): void {
    const index = rowIndexFromTarget(event.target);
    if (index === undefined) return;
    pinIndex(index);
  }

  function onFocusOut(event: {
    readonly target: EventTarget | null;
    readonly relatedTarget: EventTarget | null;
  }): void {
    const index = rowIndexFromTarget(event.target);
    if (index === undefined) return;
    const next = event.relatedTarget;
    if (next instanceof Element && rowIndexFromTarget(next) === index) return;
    const scroll = scrollElementRef.current;
    const row =
      scroll === null
        ? null
        : scroll.querySelector(`[data-transcript-row][data-index="${String(index)}"]`);
    if (row instanceof HTMLElement && row.querySelector("details[open]") !== null) return;
    unpinIndex(index);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Tab" || event.defaultPrevented) return;
    const scroll = scrollElementRef.current;
    if (scroll === null) return;
    const index = rowIndexFromTarget(event.target);
    if (index === undefined) return;
    const row = scroll.querySelector(`[data-transcript-row][data-index="${String(index)}"]`);
    if (!(row instanceof HTMLElement)) return;
    const focusable = [...row.querySelectorAll<HTMLElement>(ROW_FOCUSABLE)];
    const active = event.target;
    if (!(active instanceof HTMLElement)) return;
    const mounted = virtualizer.getVirtualItems();
    if (mounted.length === 0) return;
    if (!event.shiftKey) {
      if (focusable[focusable.length - 1] !== active) return;
      const lastMounted = mounted[mounted.length - 1]?.index;
      if (lastMounted === undefined || index !== lastMounted || index >= items.length - 1) return;
      event.preventDefault();
      pendingFocusRef.current = { index: index + 1, edge: "start" };
      pinIndex(index + 1);
      virtualizer.scrollToIndex(index + 1);
      return;
    }
    if (focusable[0] !== active) return;
    const firstMounted = mounted[0]?.index;
    if (firstMounted === undefined || index !== firstMounted || index <= 0) return;
    event.preventDefault();
    pendingFocusRef.current = { index: index - 1, edge: "end" };
    pinIndex(index - 1);
    virtualizer.scrollToIndex(index - 1);
  }

  function onScroll(): void {
    const scroll = scrollElementRef.current;
    if (scroll === null) return;
    followingRef.current = align === "end" && isAtContentEnd(scroll);
  }

  const list = (
    <ListTag
      {...(props.listLabel === undefined ? {} : { "aria-label": props.listLabel })}
      className={props.listClassName}
      ref={(node: HTMLElement | null) => {
        listRef.current = node;
      }}
      data-transcript-list=""
      {...(props.listRole === undefined ? {} : { role: props.listRole })}
      style={{
        height: virtualizer.getTotalSize(),
        position: "relative",
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
      data-transcript-scroll-margin={String(scrollMargin)}
      data-transcript-window=""
      onBlur={onFocusOut}
      onFocus={onFocusIn}
      onKeyDown={onKeyDown}
      onScroll={onScroll}
      ref={scrollElementRef}
      {...(props.ariaLabel === undefined ? {} : { "aria-label": props.ariaLabel })}
      {...(props.role === undefined ? {} : { role: props.role })}
      style={props.style}
    >
      <div data-transcript-lead="" ref={leadRef}>
        {props.lead}
      </div>
      {list}
      {props.trail === undefined ? null : (
        <div data-transcript-trail="" ref={trailRef}>
          {props.trail}
        </div>
      )}
      <div aria-live="polite" className="sr-only" data-transcript-live="">
        {liveMessage}
      </div>
    </div>
  );
}

function rememberScroll(key: string, memory: TranscriptScrollMemory): void {
  scrollMemory.delete(key);
  scrollMemory.set(key, memory);
  while (scrollMemory.size > MAX_SCROLL_MEMORY) {
    const oldest = scrollMemory.keys().next().value;
    if (oldest === undefined) break;
    scrollMemory.delete(oldest);
  }
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

function scrollToContentEnd(element: HTMLElement): void {
  element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
}

function isAtContentEnd(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_THRESHOLD_PX;
}

function allIndexes(range: Range): number[] {
  return Array.from({ length: range.count }, (_, index) => index);
}

function computeScrollMargin(scrollParent: HTMLElement, lead: HTMLElement | null): number {
  const paddingTop = Number.parseFloat(getComputedStyle(scrollParent).paddingTop);
  const leadHeight = lead === null ? 0 : lead.offsetHeight;
  return (Number.isFinite(paddingTop) ? paddingTop : 0) + leadHeight;
}

/** Test seam: forget saved offsets so restoration cases start from an empty map. */
export function resetTranscriptScrollMemory(): void {
  scrollMemory.clear();
}
