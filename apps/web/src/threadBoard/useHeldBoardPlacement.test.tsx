import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useHeldBoardPlacement } from "./useHeldBoardPlacement";

interface Card {
  readonly threadId: string;
  readonly line: string;
}
interface Column {
  readonly key: string;
  readonly cards: ReadonlyArray<Card>;
}

function Board(props: { readonly columns: ReadonlyArray<Column> }) {
  const held = useHeldBoardPlacement<Card, Column>(props.columns);
  return (
    <div data-testid="board" {...held.pointerHandlers}>
      {held.columns.map((column) => (
        <ul aria-label={column.key} key={column.key}>
          {column.cards.map((card) => (
            <li key={card.threadId}>{`${card.threadId}: ${card.line}`}</li>
          ))}
        </ul>
      ))}
    </div>
  );
}

function listed(column: string): string[] {
  return Array.from(screen.getByRole("list", { name: column }).querySelectorAll("li")).map(
    (item) => item.textContent ?? "",
  );
}

const waiting = (...cards: Card[]): Column => ({ key: "waiting", cards });
const progress = (...cards: Card[]): Column => ({ key: "in-progress", cards });
const card = (threadId: string, line = "asking"): Card => ({ threadId, line });

describe("useHeldBoardPlacement", () => {
  it("keeps each card in its slot while the pointer is on the board and shows its newest content", () => {
    const { rerender } = render(<Board columns={[waiting(card("a"), card("b")), progress()]} />);
    fireEvent.pointerEnter(screen.getByTestId("board"), { pointerType: "mouse" });

    rerender(<Board columns={[waiting(card("b")), progress(card("a", "working"))]} />);

    expect(listed("waiting")).toEqual(["a: working", "b: asking"]);
    expect(listed("in-progress")).toEqual([]);
  });

  it("applies the host's placement once the pointer leaves", () => {
    const { rerender } = render(<Board columns={[waiting(card("a"), card("b")), progress()]} />);
    fireEvent.pointerEnter(screen.getByTestId("board"), { pointerType: "mouse" });
    rerender(<Board columns={[waiting(card("b")), progress(card("a", "working"))]} />);

    fireEvent.pointerLeave(screen.getByTestId("board"), { pointerType: "mouse" });

    expect(listed("waiting")).toEqual(["b: asking"]);
    expect(listed("in-progress")).toEqual(["a: working"]);
  });

  it("keeps a card the host no longer lists until the pointer leaves", () => {
    const { rerender } = render(<Board columns={[waiting(card("a"), card("b"))]} />);
    fireEvent.pointerEnter(screen.getByTestId("board"), { pointerType: "mouse" });

    rerender(<Board columns={[waiting(card("b"))]} />);
    expect(listed("waiting")).toEqual(["a: asking", "b: asking"]);

    fireEvent.pointerLeave(screen.getByTestId("board"), { pointerType: "mouse" });
    expect(listed("waiting")).toEqual(["b: asking"]);
  });

  it("adds a newly listed card to the end of its column without moving the others", () => {
    const { rerender } = render(<Board columns={[waiting(card("a"), card("b"))]} />);
    fireEvent.pointerEnter(screen.getByTestId("board"), { pointerType: "mouse" });

    rerender(<Board columns={[waiting(card("c"), card("b"), card("a"))]} />);

    expect(listed("waiting")).toEqual(["a: asking", "b: asking", "c: asking"]);
  });

  it("holds nothing for touch, which has no hover", () => {
    const { rerender } = render(<Board columns={[waiting(card("a"), card("b"))]} />);
    fireEvent.pointerEnter(screen.getByTestId("board"), { pointerType: "touch" });

    rerender(<Board columns={[waiting(card("b"))]} />);

    expect(listed("waiting")).toEqual(["b: asking"]);
  });

  it("follows the host when nothing is pointed at", () => {
    const { rerender } = render(<Board columns={[waiting(card("a"), card("b"))]} />);

    rerender(<Board columns={[waiting(card("b"), card("a"))]} />);

    expect(listed("waiting")).toEqual(["b: asking", "a: asking"]);
  });
});
