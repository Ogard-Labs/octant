import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CodeBoardCard, CodeBoardView } from "@octant/contracts";
import { useContinueCards } from "./useContinueCards";

function card(title: string, lastMeaningfulActivityAt: string): CodeBoardCard {
  return { title, lastMeaningfulActivityAt } as unknown as CodeBoardCard;
}

function view(cards: ReadonlyArray<CodeBoardCard>): CodeBoardView {
  return {
    version: 1,
    query: { version: 1 },
    cards,
    generatedAt: "2026-09-08T03:00:00.000Z",
  } as unknown as CodeBoardView;
}

function titles(cards: ReadonlyArray<CodeBoardCard>): ReadonlyArray<string> {
  return cards.map((entry) => entry.title);
}

describe("the threads a Code start screen offers to continue", () => {
  it("offers the six most recently active threads, newest first", async () => {
    const loadBoard = vi.fn(async () =>
      view([
        card("Oldest", "2026-09-01T09:00:00.000Z"),
        card("Newest", "2026-09-08T09:00:00.000Z"),
        card("Sixth", "2026-09-02T09:00:00.000Z"),
        card("Fifth", "2026-09-03T09:00:00.000Z"),
        card("Fourth", "2026-09-04T09:00:00.000Z"),
        card("Third", "2026-09-05T09:00:00.000Z"),
        card("Second", "2026-09-06T09:00:00.000Z"),
      ]),
    );
    const { result } = renderHook(() => useContinueCards(loadBoard, 0));

    await waitFor(() => expect(result.current.kind).toBe("ready"));
    expect(result.current.kind === "ready" ? titles(result.current.cards) : []).toEqual([
      "Newest",
      "Second",
      "Third",
      "Fourth",
      "Fifth",
      "Sixth",
    ]);
  });

  it("reads the board once while its loader keeps its identity across rerenders", async () => {
    const loadBoard = vi.fn(async () =>
      view([card("Ai slop callouts", "2026-09-06T01:00:00.000Z")]),
    );
    const { rerender } = renderHook(() => useContinueCards(loadBoard, 0));

    await waitFor(() => expect(loadBoard).toHaveBeenCalledTimes(1));
    // A rerender the board has nothing to do with must not re-query it. The
    // shell renders on every streamed turn chunk.
    rerender();
    rerender();
    await waitFor(() => expect(loadBoard).toHaveBeenCalledTimes(1));
  });

  it("keeps the threads on screen while the board is read again", async () => {
    let pending: ((board: CodeBoardView) => void) | undefined;
    const loadBoard = vi.fn(async () =>
      view([card("Ai slop callouts", "2026-09-06T01:00:00.000Z")]),
    );
    const { result, rerender } = renderHook(
      ({ revision }: { readonly revision: number }) => useContinueCards(loadBoard, revision),
      { initialProps: { revision: 0 } },
    );
    await waitFor(() => expect(result.current.kind).toBe("ready"));

    // A read that has not landed yet leaves the section nothing new to say, so
    // it keeps saying what it already said rather than emptying.
    loadBoard.mockImplementation(
      () => new Promise<CodeBoardView>((resolve) => (pending = resolve)),
    );
    rerender({ revision: 1 });

    await waitFor(() => expect(loadBoard).toHaveBeenCalledTimes(2));
    expect(result.current.kind === "ready" ? titles(result.current.cards) : []).toEqual([
      "Ai slop callouts",
    ]);

    pending?.(view([card("Open PRs merge order", "2026-09-07T01:00:00.000Z")]));
    await waitFor(() =>
      expect(result.current.kind === "ready" ? titles(result.current.cards) : []).toEqual([
        "Open PRs merge order",
      ]),
    );
  });

  it("keeps the threads on screen when a later read is refused", async () => {
    const loadBoard = vi.fn(async () =>
      view([card("Ai slop callouts", "2026-09-06T01:00:00.000Z")]),
    );
    const { result, rerender } = renderHook(
      ({ revision }: { readonly revision: number }) => useContinueCards(loadBoard, revision),
      { initialProps: { revision: 0 } },
    );
    await waitFor(() => expect(result.current.kind).toBe("ready"));

    loadBoard.mockRejectedValue(new Error("board refused"));
    rerender({ revision: 1 });

    await waitFor(() => expect(loadBoard).toHaveBeenCalledTimes(2));
    expect(result.current.kind === "ready" ? titles(result.current.cards) : []).toEqual([
      "Ai slop callouts",
    ]);
  });

  it("has nothing to continue without a board to read", () => {
    const { result } = renderHook(() => useContinueCards(undefined, 0));
    expect(result.current).toEqual({ kind: "idle" });
  });
});
