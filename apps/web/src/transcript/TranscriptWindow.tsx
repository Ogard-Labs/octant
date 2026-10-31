import type { ContextSubjectRef } from "@octant/contracts/context";
import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
  type VirtualItem,
} from "@tanstack/react-virtual";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import {
  CompactionDivider,
  placeCompactions,
  useCompactionReceipts,
} from "../context/CompactionDivider";
import { TranscriptOutputLimitNote } from "./outputLimitNote";
import { TranscriptFindBar } from "./TranscriptFindBar";
import {
  clearTranscriptMatches,
  findTranscriptMatches,
  paintTranscriptMatches,
  revealTranscriptMatch,
  type TextMatch,
} from "./transcriptFind";

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
  /**
   * What the thread places after a row inside the same measured row, such as
   * a Canvas the turn ending there wrote. Kept apart from `renderItem` so each
   * transcript's own row rendering stays as it is.
   */
  readonly afterItem?: (item: T, index: number) => ReactNode;
  /**
   * When a row happened. A transcript that passes it shows a divider where the
   * thread's session was compacted, from the host's journaled receipts.
   */
  readonly itemAt?: (item: T) => string | undefined;
  /** The thread whose compactions the dividers show; with `itemAt`, it turns them on. */
  readonly compactionSubject?: ContextSubjectRef;
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
   * Called once the `revealKey` row has been brought into view, so the owner
   * can drop a one-time jump target instead of passing it on to a list that
   * mounts again later and would jump back to it.
   */
  readonly onRevealed?: (key: string) => void;
  /**
   * Keys that must stay mounted even when they leave the window. Chat uses this
   * for the turn being edited so the draft is not discarded by recycling.
   */
  readonly pinnedKeys?: ReadonlyArray<string>;
  /**
   * Chat, Work, and Code open at the end and follow new output there. `start`
   * opens a nonempty list at the top and stays there until the reader scrolls.
   */
  readonly align?: "start" | "end";
  /**
   * Whether an end-aligned list follows new output at the bottom. A run of
   * earlier rows the reader jumped to does not end at the newest output, so a
   * page arriving below it must not carry the reader to its end.
   */
  readonly followOutput?: boolean;
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
  /**
   * The key of the first row when the offset was taken. An offset only means
   * something over the rows it was measured against: a thread that reopens on
   * its newest page no longer starts with the rows loaded earlier.
   */
  readonly firstKey: string | undefined;
}

const scrollMemory = new Map<string, TranscriptScrollMemory>();

/** Frames a restored offset is applied for while the rows lay out before it can hold. */
const RESTORE_ATTEMPT_FRAMES = 30;

/** How close to the end still counts as following new output. Matches Chat's previous threshold. */
const FOLLOW_THRESHOLD_PX = 72;

const DEFAULT_ESTIMATE_SIZE = 96;
const DEFAULT_OVERSCAN = 8;
/** Visiting many threads must not retain every snapshot for the session. */
const MAX_SCROLL_MEMORY = 16;

const ROW_FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])";

export function TranscriptWindow<T>(props: TranscriptWindowProps<T>) {
  const estimateSize = props.estimateSize ?? DEFAULT_ESTIMATE_SIZE;
  const overscan = props.overscan ?? DEFAULT_OVERSCAN;
  const gap = props.gap ?? 0;
  const align = props.align ?? "end";
  const follows = align === "end" && props.followOutput !== false;
  const ListTag = props.listTag ?? "div";
  const ItemTag = props.itemTag ?? "div";
  const { itemAt } = props;
  // A turn already listed keeps its place while it moves on (a later attempt, a
  // status change), so the count alone would miss a compaction journaled in it.
  const rowsRevision = useMemo(() => {
    let latest = "";
    if (itemAt !== undefined) {
      for (const item of props.items) {
        const at = itemAt(item);
        if (at !== undefined && at > latest) latest = at;
      }
    }
    return `${props.items.length}:${latest}`;
  }, [itemAt, props.items]);
  const compactionReceipts = useCompactionReceipts(props.compactionSubject, rowsRevision);
  const compactionPlacement = useMemo(
    () =>
      itemAt === undefined || compactionReceipts.length === 0
        ? undefined
        : placeCompactions(props.items, compactionReceipts, itemAt),
    [compactionReceipts, itemAt, props.items],
  );
  const scrollElementRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLElement | null>(null);
  const leadRef = useRef<HTMLDivElement>(null);
  const trailRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [trailSize, setTrailSize] = useState(0);
  const [findActive, setFindActive] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const [findCount, setFindCount] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  const matchesRef = useRef<ReadonlyArray<TextMatch>>([]);
  const revealAfterQueryRef = useRef(false);
  const [stickyIndexes, setStickyIndexes] = useState<ReadonlySet<number>>(() => new Set());
  const [liveMessage, setLiveMessage] = useState("");
  const items = props.items;
  const itemKey = props.itemKey;
  const restoreKey = props.restoreKey;
  const revealKey = props.revealKey;
  const firstKey = items[0] === undefined ? undefined : itemKey(items[0], 0);
  const remembered = scrollMemory.get(restoreKey);
  const restored = remembered?.firstKey === firstKey ? remembered : undefined;
  const followingRef = useRef(follows && (restored?.following === true || restored === undefined));
  const appliedRevealKeyRef = useRef<string | undefined>(undefined);
  const pendingFocusRef = useRef<
    { readonly index: number; readonly edge: "start" | "end" } | undefined
  >(undefined);
  const firstKeyRef = useRef(firstKey);
  const lastKeyRef = useRef(lastKeyOf(items, itemKey));
  const countRef = useRef(items.length);
  // One index map per item list: the reveal target and every pinned key resolve
  // from it instead of an O(items) findIndex each. Streaming transcripts change
  // `items` per delta, so the scans this replaces were the hot path.
  const keyIndex = useMemo(() => {
    const index = new Map<string, number>();
    items.forEach((item, itemIndex) => {
      index.set(itemKey(item, itemIndex), itemIndex);
    });
    return index;
  }, [items, itemKey]);
  const revealIndex = revealKey === undefined ? -1 : (keyIndex.get(revealKey) ?? -1);

  const pinnedFromKeys = new Set<number>();
  if (props.pinnedKeys !== undefined) {
    for (const key of props.pinnedKeys) {
      const index = keyIndex.get(key);
      if (index !== undefined) pinnedFromKeys.add(index);
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
    // Follow appended rows only while this list is following. The virtualizer
    // on its own follows whenever the view sits at the end, which carried a
    // reader at the bottom of a jumped-to run to the newest message when the
    // run joined the newest turns, past the page they had just loaded.
    ...(align === "end"
      ? { anchorTo: "end" as const, followOnAppend: follows && followingRef.current }
      : {}),
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
      // The frame itself can shrink under a following list, as when the
      // composer below it grows; the list stays at its end.
      if (followingRef.current && align === "end") scrollToContentEnd(scroll);
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(list);
    observer.observe(scroll);
    if (leadRef.current !== null) observer.observe(leadRef.current);
    if (trailRef.current !== null) observer.observe(trailRef.current);
    return () => observer.disconnect();
  }, [align, items.length, props.lead, props.trail]);

  useLayoutEffect(() => {
    return () => {
      const offset = virtualizer.scrollOffset;
      if (offset === null) return;
      rememberScroll(restoreKey, {
        offset,
        measurements: virtualizer.takeSnapshot(),
        following: followingRef.current,
        firstKey: firstKeyRef.current,
      });
    };
  }, [restoreKey, virtualizer]);

  // Updated after the cleanup above has read it, so leaving a thread records
  // the first row it was showing rather than the next thread's.
  useLayoutEffect(() => {
    firstKeyRef.current = firstKey;
  }, [firstKey]);

  // The virtualizer starts from a remembered offset, but the frame itself
  // mounts at the top, and its rows lay out a frame or two later, so until
  // then it cannot scroll that far. Left there, the restored rows were drawn
  // where the reader had been while the frame showed the empty space above
  // them, and a thread came back blank until it was scrolled. The offset is
  // applied again each frame until it holds, and never after the reader moves.
  // A jump to a row decides where the list opens instead, so a pending reveal
  // skips the restore or ends it, rather than the two pulling the frame back
  // and forth.
  const revealPendingRef = useRef(revealKey !== undefined);
  revealPendingRef.current = revealKey !== undefined;
  useLayoutEffect(() => {
    const scroll = scrollElementRef.current;
    if (scroll === null || restored === undefined || restored.following) return;
    if (revealPendingRef.current) return;
    const offset = restored.offset;
    const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    let handle: number | undefined;
    let attempts = 0;
    const stop = () => {
      if (handle !== undefined) cancelAnimationFrame(handle);
      handle = undefined;
      for (const type of inputs) scroll.removeEventListener(type, stop);
    };
    const apply = () => {
      handle = undefined;
      if (revealPendingRef.current) {
        stop();
        return;
      }
      scroll.scrollTop = offset;
      if (Math.abs(scroll.scrollTop - offset) <= 1 || (attempts += 1) >= RESTORE_ATTEMPT_FRAMES) {
        stop();
        return;
      }
      handle = requestAnimationFrame(apply);
    };
    if (typeof requestAnimationFrame !== "function") {
      scroll.scrollTop = offset;
      return;
    }
    for (const type of inputs) scroll.addEventListener(type, stop, { passive: true });
    apply();
    return stop;
  }, [restoreKey]);

  useLayoutEffect(() => {
    followingRef.current = follows && (restored?.following === true || restored === undefined);
    appliedRevealKeyRef.current = undefined;
    setStickyIndexes(new Set());
    setLiveMessage("");
    lastKeyRef.current = lastKeyOf(items, itemKey);
    countRef.current = items.length;
  }, [restoreKey]);

  // Rows measure taller than their estimate once they mount, which moves the
  // end of the list after it was scrolled there. Following the total size
  // keeps a following list at its end within the same commit; reacting later
  // let the scroll event from the first placement see the list short of its
  // end and stop following, and a long Chat thread opened about two thousand
  // pixels above its newest message.
  const totalSize = virtualizer.getTotalSize();
  useLayoutEffect(() => {
    const scroll = scrollElementRef.current;
    if (scroll === null || align !== "end" || !followingRef.current) return;
    scrollToContentEnd(scroll);
  }, [align, items.length, restoreKey, trailSize, scrollMargin, totalSize, virtualizer]);

  // The key-to-index map of the latest render, for the reveal settling below,
  // which outlives the render that started it.
  const keyIndexRef = useRef(keyIndex);
  keyIndexRef.current = keyIndex;
  const onRevealedRef = useRef(props.onRevealed);
  onRevealedRef.current = props.onRevealed;
  const settleRevealRef = useRef<RevealSettling | undefined>(undefined);
  // A list that goes away while a reveal settles (the reader left the thread,
  // or the run holding the row was let go) has done what it could with the
  // target: it is spent, so a later list does not jump back to it. The spend
  // waits a tick and a remount cancels it, because development mode unmounts
  // and remounts every list once on mount; spending then stopped the reveal
  // before it had moved anything.
  const unmountSpendRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLayoutEffect(() => {
    if (unmountSpendRef.current !== undefined) {
      clearTimeout(unmountSpendRef.current);
      unmountSpendRef.current = undefined;
    }
    return () => {
      const settling = settleRevealRef.current;
      if (settling === undefined) return;
      unmountSpendRef.current = setTimeout(() => settling.stop("spend"), 0);
    };
  }, []);

  useLayoutEffect(() => {
    if (revealKey === undefined) {
      // The owner dropped the target, so the same row asked for again later
      // is a new request rather than one this list already applied.
      appliedRevealKeyRef.current = undefined;
      settleRevealRef.current?.stop("keep");
      settleRevealRef.current = undefined;
      return;
    }
    if (revealKey === appliedRevealKeyRef.current) return;
    const index = items.findIndex((item, itemIndex) => itemKey(item, itemIndex) === revealKey);
    if (index < 0) return;
    virtualizer.scrollToIndex(index, { align: "center" });
    appliedRevealKeyRef.current = revealKey;
    const key = revealKey;
    const scroll = scrollElementRef.current;
    settleRevealRef.current?.stop("keep");
    settleRevealRef.current =
      scroll === null
        ? undefined
        : settleReveal(
            scroll,
            () => keyIndexRef.current.get(key),
            // Through the virtualizer, so its own correction for the jump
            // aims where this one does instead of pulling the row back.
            (offset) => virtualizer.scrollToOffset(offset, { align: "start" }),
            () => {
              settleRevealRef.current = undefined;
              onRevealedRef.current?.(key);
            },
          );
    if (settleRevealRef.current === undefined) onRevealedRef.current?.(key);
  }, [itemKey, items, revealKey, virtualizer]);

  // Only a row added at the end is news. Earlier rows loaded above, a row that
  // grows while it streams, and an older row exposed when the last one is
  // removed change the list without saying anything new.
  useLayoutEffect(() => {
    const previous = lastKeyRef.current;
    const previousCount = countRef.current;
    const next = lastKeyOf(items, itemKey);
    lastKeyRef.current = next;
    countRef.current = items.length;
    if (next === undefined || previous === undefined || next === previous) return;
    if (items.length <= previousCount) return;
    const appended = items[items.length - 1];
    if (appended === undefined) return;
    setLiveMessage(
      props.announceItem === undefined
        ? "New message"
        : props.announceItem(appended, items.length - 1),
    );
  }, [itemKey, items, props.announceItem]);

  useLayoutEffect(() => {
    function onFindShortcut(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return;
      if (event.altKey || event.shiftKey) return;
      const root = scrollElementRef.current;
      if (root === null || root.closest("[hidden], [inert]") !== null) return;
      const target = event.target;
      if (target instanceof Element) {
        // The code editor and terminal have their own find.
        if (target.closest(".monaco-editor, .xterm") !== null) return;
        // Only the thread the person is in: its transcript and composer share a parent.
        const owner = root.parentElement;
        if (target !== document.body && owner !== null && !owner.contains(target)) return;
      }
      event.preventDefault();
      // Mount every row before matching so off-window rows can be found.
      flushSync(() => setFindActive(true));
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }
    window.addEventListener("keydown", onFindShortcut, true);
    return () => window.removeEventListener("keydown", onFindShortcut, true);
  }, []);

  useLayoutEffect(() => {
    if (!findActive) {
      clearTranscriptMatches();
      matchesRef.current = [];
      setFindCount(0);
      return;
    }
    const root = scrollElementRef.current;
    if (root === null) return;
    const ranges = findTranscriptMatches(root, findQuery);
    matchesRef.current = ranges;
    setFindCount(ranges.length);
    const index = Math.min(findIndex, Math.max(0, ranges.length - 1));
    if (index !== findIndex) setFindIndex(index);
    paintTranscriptMatches(ranges, index);
    if (revealAfterQueryRef.current) {
      revealAfterQueryRef.current = false;
      revealTranscriptMatch(ranges[index]);
    }
    return clearTranscriptMatches;
  }, [findActive, findQuery, findIndex, items, virtualizer.getVirtualItems().length]);

  function stepFind(direction: 1 | -1): void {
    const count = matchesRef.current.length;
    if (count === 0) return;
    const next = (findIndex + direction + count) % count;
    setFindIndex(next);
    revealTranscriptMatch(matchesRef.current[next]);
  }

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
    followingRef.current = follows && isAtContentEnd(scroll);
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
            {(compactionPlacement?.before.get(virtualItem.index) ?? []).map((receipt) => (
              <CompactionDivider key={String(receipt.compactionId)} receipt={receipt} />
            ))}
            {props.renderItem(item, virtualItem.index)}
            {props.afterItem?.(item, virtualItem.index)}
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
      {findActive ? (
        <div className="transcript-find-anchor">
          <TranscriptFindBar
            count={findCount}
            current={findIndex}
            onClose={() => setFindActive(false)}
            onQueryChange={(query) => {
              revealAfterQueryRef.current = true;
              setFindQuery(query);
              setFindIndex(0);
            }}
            onStep={stepFind}
            ref={findInputRef}
            query={findQuery}
          />
        </div>
      ) : null}
      <div data-transcript-lead="" ref={leadRef}>
        {props.lead}
      </div>
      {list}
      <div data-transcript-trail="" ref={trailRef}>
        {compactionPlacement === undefined || compactionPlacement.trailing.length === 0 ? null : (
          <div className={props.listClassName}>
            {compactionPlacement.trailing.map((receipt) => (
              <CompactionDivider key={String(receipt.compactionId)} receipt={receipt} />
            ))}
          </div>
        )}
        {props.trail}
        <TranscriptOutputLimitNote restoreKey={props.restoreKey} />
      </div>
      <div aria-live="polite" className="sr-only" data-transcript-live="">
        {liveMessage}
      </div>
    </div>
  );
}

interface RevealSettling {
  /** Ends the settling; `spend` reports the reveal done, `keep` does not. */
  readonly stop: (outcome: "spend" | "keep") => void;
}

/** How long a reveal keeps correcting against the rendered rows. */
const REVEAL_SETTLE_MS = 1_500;
/**
 * Frames the revealed row and the list's height must hold still, and the time
 * that must pass, before the reveal counts as done. Rows measure a few frames
 * after they mount; counting still frames from before that let the reveal end
 * while rows above the target were still growing and pushing it down.
 */
const REVEAL_STABLE_FRAMES = 6;
const REVEAL_MIN_SETTLE_MS = 250;

/**
 * Centres a revealed row against the rendered rows, frame by frame, until it
 * stays put. The virtualizer scrolls to the row from estimated heights; rows
 * then measure taller as they mount, and its own correction can stop short,
 * which left a search hit far back in a jumped-to run a thousand pixels below
 * the view. It reports the reveal done once the row holds still, once the row
 * is no longer in the list, or as soon as the reader scrolls by hand. A frame
 * with no size yet (not laid out) is not a reveal: if the frame never gets one
 * within the time allowed, the reveal is left unspent. Answers undefined where
 * frames are unavailable.
 */
function settleReveal(
  scroll: HTMLElement,
  indexOfTarget: () => number | undefined,
  scrollTo: (offset: number) => void,
  done: () => void,
): RevealSettling | undefined {
  if (typeof requestAnimationFrame !== "function") return undefined;
  const startedAt = performance.now();
  const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
  let stable = 0;
  let lastHeight = -1;
  let handle: number | undefined;
  let finished = false;
  const stop = (outcome: "spend" | "keep") => {
    if (finished) return;
    finished = true;
    if (handle !== undefined) cancelAnimationFrame(handle);
    for (const type of inputs) scroll.removeEventListener(type, onInput);
    if (outcome === "spend") done();
  };
  const onInput = () => stop("spend");
  for (const type of inputs) scroll.addEventListener(type, onInput, { passive: true });
  const step = () => {
    handle = undefined;
    const outOfTime = performance.now() - startedAt >= REVEAL_SETTLE_MS;
    const index = indexOfTarget();
    if (index === undefined) {
      stop("spend");
      return;
    }
    if (scroll.clientHeight === 0) {
      if (outOfTime) stop("keep");
      else handle = requestAnimationFrame(step);
      return;
    }
    const row = scroll.querySelector(`[data-transcript-row][data-index="${String(index)}"]`);
    if (row instanceof HTMLElement) {
      const frameRect = scroll.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const offset = rowRect.top + rowRect.height / 2 - (frameRect.top + frameRect.height / 2);
      const height = scroll.scrollHeight;
      const max = height - scroll.clientHeight;
      const target = Math.max(0, Math.min(max, scroll.scrollTop + offset));
      if (Math.abs(target - scroll.scrollTop) > 1) {
        scrollTo(target);
        stable = 0;
      } else if (height !== lastHeight) {
        stable = 0;
      } else {
        stable += 1;
      }
      lastHeight = height;
    }
    const settled =
      stable >= REVEAL_STABLE_FRAMES && performance.now() - startedAt >= REVEAL_MIN_SETTLE_MS;
    if (settled || outOfTime) stop("spend");
    else handle = requestAnimationFrame(step);
  };
  handle = requestAnimationFrame(step);
  return { stop };
}

function lastKeyOf<T>(
  items: ReadonlyArray<T>,
  itemKey: (item: T, index: number) => string,
): string | undefined {
  const last = items[items.length - 1];
  return last === undefined ? undefined : itemKey(last, items.length - 1);
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
