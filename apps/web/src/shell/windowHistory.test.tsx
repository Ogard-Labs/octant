import { act, renderHook } from "@testing-library/react";
import { decodePaneId, decodeWorkspaceTabId } from "@octant/contracts/shell";
import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_WINDOW_HISTORY,
  WINDOW_HISTORY_LIMIT,
  recordPlace,
  useWindowHistory,
  type WindowPlace,
} from "./windowHistory";

const inbox: WindowPlace = { kind: "page", mode: "code", destination: "inbox" };
const board: WindowPlace = { kind: "page", mode: "code", destination: "thread-board" };
const paneId = decodePaneId("10000000-0000-4000-8000-000000000001");
const tabIds = new Map<string, string>();
const thread = (name: string): WindowPlace => {
  if (!tabIds.has(name)) {
    tabIds.set(name, `20000000-0000-4000-8000-${String(tabIds.size + 1).padStart(12, "0")}`);
  }
  return { kind: "tab", mode: "code", paneId, tabId: decodeWorkspaceTabId(tabIds.get(name)) };
};

describe("window history", () => {
  it("drops the steps ahead when a new place is opened after going back, and counts a repeat once", () => {
    let state = recordPlace(EMPTY_WINDOW_HISTORY, inbox);
    state = recordPlace(state, board);
    state = recordPlace(state, board);
    expect(state.entries).toEqual([inbox, board]);
    state = recordPlace({ ...state, index: 0 }, thread("a"));
    expect(state.entries).toEqual([inbox, thread("a")]);
    expect(state.index).toBe(1);
  });

  it("keeps only the most recent steps", () => {
    let state = EMPTY_WINDOW_HISTORY;
    for (let step = 0; step < WINDOW_HISTORY_LIMIT + 5; step += 1) {
      state = recordPlace(state, thread(`t${String(step)}`));
    }
    expect(state.entries).toHaveLength(WINDOW_HISTORY_LIMIT);
    expect(state.entries[0]).toEqual(thread("t5"));
  });

  it("goes back and forward through the places the window opened, without recording the moves", async () => {
    const restore = vi.fn(async () => true);
    const { result, rerender } = renderHook(
      ({ current }: { current: WindowPlace }) => useWindowHistory(current, restore),
      { initialProps: { current: thread("a") } },
    );
    rerender({ current: inbox });
    rerender({ current: thread("b") });
    expect(result.current.canGoBack).toBe(true);
    expect(result.current.canGoForward).toBe(false);

    await act(async () => result.current.goBack());
    expect(restore).toHaveBeenLastCalledWith(inbox);
    rerender({ current: inbox });
    expect(result.current.canGoForward).toBe(true);

    await act(async () => result.current.goForward());
    expect(restore).toHaveBeenLastCalledWith(thread("b"));
    rerender({ current: thread("b") });
    expect(result.current.canGoForward).toBe(false);
    expect(result.current.canGoBack).toBe(true);
  });

  it("skips a step whose tab was closed and goes on to the one before it", async () => {
    const closed = thread("b");
    const restore = vi.fn(
      async (place: WindowPlace) =>
        !(
          place.kind === "tab" &&
          closed.kind === "tab" &&
          String(place.tabId) === String(closed.tabId)
        ),
    );
    const { result, rerender } = renderHook(
      ({ current }: { current: WindowPlace }) => useWindowHistory(current, restore),
      { initialProps: { current: thread("a") } },
    );
    rerender({ current: thread("b") });
    rerender({ current: inbox });

    await act(async () => result.current.goBack());
    expect(restore).toHaveBeenNthCalledWith(1, thread("b"));
    expect(restore).toHaveBeenNthCalledWith(2, thread("a"));
    rerender({ current: thread("a") });
    expect(result.current.canGoBack).toBe(false);
    expect(result.current.canGoForward).toBe(true);
  });
});
