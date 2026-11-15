import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThreadBoardBody } from "./ThreadBoardView";

interface Card {
  readonly threadId: string;
  readonly status: string;
}
interface Column {
  readonly key: string;
  readonly label: string;
  readonly kind: "status";
  readonly status: string;
  readonly cards: ReadonlyArray<Card>;
}

const cards = (count: number, prefix = "Thread"): ReadonlyArray<Card> =>
  Array.from({ length: count }, (_value, index) => ({
    threadId: `${prefix} ${String(index + 1)}`,
    status: "waiting",
  }));

function Board(props: { readonly cards: ReadonlyArray<Card> }) {
  return (
    // The stylesheet is not loaded in tests; this wrapper is the scroller the
    // workspace pane provides in the app.
    <div data-board-scroller="" style={{ height: "600px", overflowY: "auto" }}>
      <ThreadBoardBody<Card, Column, ReadonlyArray<Card>>
        activeFilterSummary={undefined}
        board={{ status: "ready", view: props.cards }}
        cardsOf={(view) => view}
        copy={{ eyebrow: "Board", emptyDetail: "", emptyFilteredTitle: "", emptyTitle: "Empty" }}
        emptyGroupsInNarrowList="hidden"
        groupCards={(all) => [
          { key: "waiting", label: "Waiting", kind: "status", status: "waiting", cards: all },
        ]}
        grouping="status"
        isNarrow={false}
        layout="columns"
        onClearFilters={() => {}}
        renderCard={(card) => <button type="button">{card.threadId}</button>}
        showEmptyGroups={false}
      />
    </div>
  );
}

const drawn = () => screen.queryAllByRole("button").map((button) => button.textContent);

describe("a dense board column", () => {
  // jsdom lays nothing out; the scroller and the measured rows report heights.
  const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.hasAttribute("data-board-scroller")) return 600;
        return this.hasAttribute("data-index") ? 132 : (offsetHeight?.get?.call(this) ?? 0);
      },
    });
  });
  afterEach(() => {
    if (offsetHeight === undefined) Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
    else Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
  });

  it("draws every card of a column at or below the threshold", () => {
    render(<Board cards={cards(60)} />);
    expect(drawn()).toHaveLength(60);
  });

  it("mounts only the cards near the viewport of a large column", () => {
    render(<Board cards={cards(400)} />);
    const shown = drawn();
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(40);
    expect(shown[0]).toBe("Thread 1");
    expect(screen.queryByRole("button", { name: "Thread 400" })).toBeNull();
    // The column still counts every card it holds.
    expect(screen.getByRole("region", { name: "Waiting (400)" })).toBeInTheDocument();
  });

  it("keeps a focused card mounted and focused when a re-sort moves it out of view", () => {
    const initial = cards(400);
    const { rerender } = render(<Board cards={initial} />);
    const focused = screen.getByRole("button", { name: "Thread 2" });
    focused.focus();

    const [first, second, ...rest] = initial;
    if (first === undefined || second === undefined) throw new Error("fixture");
    rerender(<Board cards={[first, ...rest, second]} />);

    expect(screen.getByRole("button", { name: "Thread 2" })).toHaveFocus();
    expect(drawn().length).toBeLessThan(40);
  });

  it("holds each drawn card in its slot while the pointer rests on a large board", () => {
    const initial = cards(400);
    const { container, rerender } = render(<Board cards={initial} />);
    const body = container.querySelector(".code-board__body");
    if (!(body instanceof HTMLElement)) throw new Error("board body");
    fireEvent.pointerEnter(body, { pointerType: "mouse" });
    fireEvent.pointerOver(screen.getByRole("button", { name: "Thread 3" }));

    rerender(<Board cards={[...initial].reverse()} />);

    expect(drawn().slice(0, 3)).toEqual(["Thread 1", "Thread 2", "Thread 3"]);
    fireEvent.pointerLeave(body, { pointerType: "mouse" });
    expect(drawn()[0]).toBe("Thread 400");
  });
});
