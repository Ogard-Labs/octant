import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Below this many cards a group draws every card, exactly as it always has.
 * A dense column or Project past it draws only the rows near the viewport.
 */
export const BOARD_VIRTUALIZATION_THRESHOLD = 60;

const CARD_ROW_ESTIMATE = 132;
const CARD_ROW_OVERSCAN = 4;

interface SlotCard {
  readonly threadId: unknown;
}

/**
 * One group's cards as list items. A large group is virtualized by grid row:
 * the Project grouping flows cards in an auto-fill grid, so the column count
 * is read from the list's resolved `grid-template-columns` and each virtual
 * row holds that many cards. Spacer items stand in for the rows not drawn and
 * span every grid column, so a drawn row keeps the place it would have had.
 *
 * The card under the pointer and the card holding focus stay mounted even
 * when they scroll out of range. While a pointer rests on the board its cards
 * keep their placement (see useHeldBoardPlacement), so the slot under the
 * cursor must not be swapped for a spacer; and a focused card that unmounted
 * would drop keyboard focus to the document.
 */
export function ThreadBoardCardSlots<TCard extends SlotCard>(props: {
  readonly cards: ReadonlyArray<TCard>;
  readonly className: string;
  readonly renderCard: (card: TCard) => ReactNode;
}) {
  if (props.cards.length <= BOARD_VIRTUALIZATION_THRESHOLD) {
    return (
      <ul className={props.className}>
        {props.cards.map((card) => (
          <li key={String(card.threadId)}>{props.renderCard(card)}</li>
        ))}
      </ul>
    );
  }
  return <VirtualCardSlots {...props} />;
}

function VirtualCardSlots<TCard extends SlotCard>(props: {
  readonly cards: ReadonlyArray<TCard>;
  readonly className: string;
  readonly renderCard: (card: TCard) => ReactNode;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const [layout, setLayout] = useState<ListLayout | undefined>(undefined);
  const [pointedId, setPointedId] = useState<string | undefined>(undefined);
  const [focusedId, setFocusedId] = useState<string | undefined>(undefined);
  const columns = layout?.columns ?? 1;
  const rowCount = Math.ceil(props.cards.length / columns);
  const rowOf = (id: string | undefined): number | undefined => {
    if (id === undefined) return undefined;
    const index = props.cards.findIndex((card) => String(card.threadId) === id);
    return index < 0 ? undefined : Math.floor(index / columns);
  };
  const keptRows = [rowOf(pointedId), rowOf(focusedId)].filter(
    (row): row is number => row !== undefined,
  );

  const virtualizer = useVirtualizer({
    count: layout === undefined ? 0 : rowCount,
    estimateSize: () => CARD_ROW_ESTIMATE,
    getItemKey: (row) => String(props.cards[row * columns]?.threadId ?? row),
    getScrollElement: () => layout?.scrollElement ?? null,
    gap: layout?.rowGap ?? 0,
    overscan: CARD_ROW_OVERSCAN,
    scrollMargin: layout?.scrollMargin ?? 0,
    rangeExtractor: (range) => {
      const rows = defaultRangeExtractor(range);
      const kept = new Set(rows);
      for (const row of keptRows) if (row < range.count) kept.add(row);
      return kept.size === rows.length ? rows : [...kept].sort((left, right) => left - right);
    },
    useAnimationFrameWithResizeObserver: true,
  });

  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const scrollElement = nearestScroller(list);
    const update = () => {
      const next = readLayout(list, scrollElement);
      setLayout((current) => (current !== undefined && sameLayout(current, next) ? current : next));
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    observer?.observe(list);
    if (scrollElement !== null && scrollElement !== list) {
      observer?.observe(scrollElement);
      scrollElement.addEventListener("scroll", update, { passive: true });
    }
    return () => {
      observer?.disconnect();
      scrollElement?.removeEventListener("scroll", update);
    };
  }, []);

  const slotId = (target: EventTarget): string | undefined =>
    target instanceof Element
      ? (target.closest<HTMLElement>("li[data-thread-id]")?.dataset.threadId ?? undefined)
      : undefined;
  const listHandlers = {
    onPointerOver: (event: { readonly target: EventTarget }) => setPointedId(slotId(event.target)),
    onPointerLeave: () => setPointedId(undefined),
    onFocus: (event: { readonly target: EventTarget }) => setFocusedId(slotId(event.target)),
    onBlur: (event: { readonly relatedTarget: EventTarget | null }) => {
      if (event.relatedTarget === null || slotId(event.relatedTarget) === undefined) {
        setFocusedId(undefined);
      }
    },
  };

  // Nothing scrolls this list (a test DOM, or a host layout without a
  // scroller): every card is drawn, which is always correct, only slower.
  if (layout !== undefined && layout.scrollElement === null) {
    return (
      <ul className={props.className} ref={listRef}>
        {props.cards.map((card) => (
          <li data-thread-id={String(card.threadId)} key={String(card.threadId)}>
            {props.renderCard(card)}
          </li>
        ))}
      </ul>
    );
  }

  const items = virtualizer.getVirtualItems();
  const gap = layout?.rowGap ?? 0;
  const origin = layout?.scrollMargin ?? 0;
  const slots: ReactNode[] = [];
  let drawnEnd = origin - gap;
  for (const item of items) {
    const skipped = item.start - drawnEnd - 2 * gap;
    if (skipped > 0) slots.push(<RowSpacer height={skipped} key={`gap-${String(item.key)}`} />);
    const rowCards = props.cards.slice(item.index * columns, (item.index + 1) * columns);
    rowCards.forEach((card, offset) => {
      slots.push(
        <li
          data-index={offset === 0 ? item.index : undefined}
          data-thread-id={String(card.threadId)}
          key={String(card.threadId)}
          ref={offset === 0 ? virtualizer.measureElement : undefined}
        >
          {props.renderCard(card)}
        </li>,
      );
    });
    drawnEnd = item.end;
  }
  const trailing = origin + virtualizer.getTotalSize() - drawnEnd - gap;
  if (trailing > 0) slots.push(<RowSpacer height={trailing} key="gap-end" />);

  return (
    <ul className={props.className} ref={listRef} {...listHandlers}>
      {slots}
    </ul>
  );
}

function RowSpacer({ height }: { readonly height: number }) {
  return (
    <li
      aria-hidden="true"
      data-board-spacer=""
      role="presentation"
      style={{ gridColumn: "1 / -1", height, padding: 0, margin: 0 }}
    />
  );
}

interface ListLayout {
  readonly columns: number;
  readonly rowGap: number;
  readonly scrollElement: HTMLElement | null;
  readonly scrollMargin: number;
}

function readLayout(list: HTMLElement, scrollElement: HTMLElement | null): ListLayout {
  const style = getComputedStyle(list);
  // A grid's resolved track list is one length per column ("280px 280px").
  const tracks =
    style.display === "grid"
      ? style.gridTemplateColumns.split(/\s+/).filter((track) => /^[\d.]+px$/.test(track)).length
      : 0;
  const rowGap = Number.parseFloat(style.rowGap);
  return {
    columns: Math.max(1, tracks),
    rowGap: Number.isFinite(rowGap) ? rowGap : 0,
    scrollElement,
    scrollMargin:
      scrollElement === null || scrollElement === list
        ? 0
        : list.getBoundingClientRect().top -
          scrollElement.getBoundingClientRect().top +
          scrollElement.scrollTop,
  };
}

function sameLayout(left: ListLayout, right: ListLayout): boolean {
  return (
    left.columns === right.columns &&
    left.rowGap === right.rowGap &&
    left.scrollElement === right.scrollElement &&
    left.scrollMargin === right.scrollMargin
  );
}

/** The list itself when it scrolls (a Status column), else its nearest scrolling ancestor. */
function nearestScroller(list: HTMLElement): HTMLElement | null {
  let candidate: HTMLElement | null = list;
  while (candidate !== null) {
    if (/^(auto|overlay|scroll)$/.test(getComputedStyle(candidate).overflowY)) return candidate;
    candidate = candidate.parentElement;
  }
  return null;
}
