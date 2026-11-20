import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type {
  BrowserSurfaceTabIcon,
  BrowserSurfaceTabIconsRequest,
} from "@octant/contracts/desktop-bridge";
import type { OctantHostBridge } from "../shell/hostBridge";
import { applyTabIconRows, useBrowserSurfaceTabIcons, type BrowserTabIconMemory } from "./tabIcons";

const ICON_A = "data:image/png;base64,AAAA";
const ICON_B = "data:image/png;base64,BBBB";

function held(
  entries: ReadonlyArray<readonly [string, number, string | undefined]>,
): Map<string, BrowserTabIconMemory> {
  return new Map(
    entries.map(([tabId, revision, dataUrl]) => [
      tabId,
      { revision, ...(dataUrl === undefined ? {} : { dataUrl }) },
    ]),
  );
}

function row(
  tabId: string,
  revision: number,
  active = false,
  dataUrl?: string,
  sleeping?: boolean,
): BrowserSurfaceTabIcon {
  return {
    tabId,
    revision,
    active,
    ...(dataUrl === undefined ? {} : { dataUrl }),
    ...(sleeping === true ? { sleeping: true } : {}),
  };
}

describe("applyTabIconRows", () => {
  it("returns two sites' icons in the first read, including a background tab", () => {
    const merged = applyTabIconRows(new Map(), [
      row("tab-1", 1, true, ICON_A),
      row("tab-2", 2, false, ICON_B),
    ]);
    expect(merged.changed).toBe(true);
    expect(merged.activeTabId).toBe("tab-1");
    expect(merged.next.get("tab-1")?.dataUrl).toBe(ICON_A);
    expect(merged.next.get("tab-2")?.dataUrl).toBe(ICON_B);
  });

  it("keeps the window's image when the host reports the same revision without one", () => {
    const previous = held([["tab-1", 3, ICON_A]]);
    const merged = applyTabIconRows(previous, [row("tab-1", 3, true)]);
    expect(merged.changed).toBe(false);
    expect(merged.next.get("tab-1")?.dataUrl).toBe(ICON_A);
  });

  it("replaces the image when its revision moves", () => {
    const previous = held([["tab-1", 3, ICON_A]]);
    const merged = applyTabIconRows(previous, [row("tab-1", 4, true, ICON_B)]);
    expect(merged.changed).toBe(true);
    expect(merged.next.get("tab-1")?.dataUrl).toBe(ICON_B);
  });

  it("clears a tab's icon when a new revision arrives without an image", () => {
    const previous = held([["tab-1", 3, ICON_A]]);
    const merged = applyTabIconRows(previous, [row("tab-1", 4, true)]);
    expect(merged.changed).toBe(true);
    expect(merged.next.get("tab-1")?.dataUrl).toBeUndefined();
  });

  it("advances the remembered revision even when the bytes never changed", () => {
    const previous = held([["tab-1", 3, ICON_A]]);
    const merged = applyTabIconRows(previous, [row("tab-1", 4, true, ICON_A)]);
    expect(merged.changed).toBe(false);
    expect(merged.next.get("tab-1")?.revision).toBe(4);
  });

  it("advances the remembered revision across a clear-to-clear update", () => {
    const previous = held([["tab-1", 3, undefined]]);
    const merged = applyTabIconRows(previous, [row("tab-1", 4, true)]);
    expect(merged.changed).toBe(false);
    expect(merged.next.get("tab-1")?.revision).toBe(4);
    expect(merged.next.get("tab-1")?.dataUrl).toBeUndefined();
  });

  it("reports a sleeping read only while every row is asleep", () => {
    expect(applyTabIconRows(new Map(), [row("tab-1", 1, true, ICON_A, true)]).sleeping).toBe(true);
    expect(
      applyTabIconRows(new Map(), [
        row("tab-1", 1, true, ICON_A, true),
        row("tab-2", 2, false, ICON_B),
      ]).sleeping,
    ).toBe(false);
  });

  it("forgets a tab the read no longer lists", () => {
    const previous = held([
      ["tab-1", 1, ICON_A],
      ["tab-2", 2, ICON_B],
    ]);
    const merged = applyTabIconRows(previous, [row("tab-1", 1, true)]);
    expect(merged.changed).toBe(true);
    expect(merged.next.has("tab-2")).toBe(false);
  });

  it("marks only the change when one tab of several moved", () => {
    const previous = held([
      ["tab-1", 1, ICON_A],
      ["tab-2", 2, ICON_B],
    ]);
    const merged = applyTabIconRows(previous, [
      row("tab-1", 1, true),
      row("tab-2", 5, false, ICON_A),
    ]);
    expect(merged.next.get("tab-1")?.dataUrl).toBe(ICON_A);
    expect(merged.next.get("tab-2")?.dataUrl).toBe(ICON_A);
    expect(merged.activeTabId).toBe("tab-1");
  });
});

type ReadIcons = (
  request: BrowserSurfaceTabIconsRequest,
) => Promise<ReadonlyArray<BrowserSurfaceTabIcon> | undefined>;

function iconBridge(read: ReadIcons): OctantHostBridge {
  return { readBrowserSurfaceTabIcons: read } as unknown as OctantHostBridge;
}

function strip(bridge: OctantHostBridge, contextId = "ctx-1") {
  return renderHook(
    (props: { refreshKey: number }) =>
      useBrowserSurfaceTabIcons({
        contextIds: [contextId],
        hostBridge: bridge,
        refreshKey: props.refreshKey,
        threadId: "thread-1",
      }),
    { initialProps: { refreshKey: 0 } },
  );
}

describe("useBrowserSurfaceTabIcons", () => {
  it("holds every tab's icon on the first read, including an unselected one", async () => {
    const read = vi.fn(async (_request: BrowserSurfaceTabIconsRequest) => [
      row("tab-1", 1, true, ICON_A),
      row("tab-2", 2, false, ICON_B),
    ]);
    const { result } = strip(iconBridge(read));
    await waitFor(() => expect(result.current.get("ctx-1")?.icons.get("tab-2")).toBe(ICON_B));
    expect(result.current.get("ctx-1")?.icons.get("tab-1")).toBe(ICON_A);
    expect(result.current.get("ctx-1")?.activeTabId).toBe("tab-1");
    expect(read.mock.calls[0]?.[0].known).toEqual([]);
  });

  it("names the remembered revision on the next read even at identical bytes", async () => {
    const read = vi
      .fn<ReadIcons>()
      .mockResolvedValueOnce([row("tab-1", 3, true, ICON_A)])
      .mockResolvedValue([row("tab-1", 4, true, ICON_A)]);
    const { rerender } = strip(iconBridge(read));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    rerender({ refreshKey: 1 });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(read.mock.calls[1]?.[0].known).toEqual([{ tabId: "tab-1", revision: 3 }]);
    rerender({ refreshKey: 2 });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    // Same bytes, newer revision: the read still names what it now holds, so
    // the host does not resend the image every poll.
    expect(read.mock.calls[2]?.[0].known).toEqual([{ tabId: "tab-1", revision: 4 }]);
  });

  it("folds an updated icon and a cleared one into later reads", async () => {
    const read = vi
      .fn<ReadIcons>()
      .mockResolvedValueOnce([row("tab-1", 1, true, ICON_A), row("tab-2", 2, false, ICON_B)])
      .mockResolvedValue([row("tab-1", 5, true, ICON_B), row("tab-2", 3, false)]);
    const { result, rerender } = strip(iconBridge(read));
    await waitFor(() => expect(result.current.get("ctx-1")?.icons.get("tab-2")).toBe(ICON_B));
    rerender({ refreshKey: 1 });
    await waitFor(() => expect(result.current.get("ctx-1")?.icons.has("tab-2")).toBe(false));
    expect(result.current.get("ctx-1")?.icons.get("tab-1")).toBe(ICON_B);
  });

  it("drops a context's icons when the host refuses the read", async () => {
    const read = vi
      .fn<ReadIcons>()
      .mockResolvedValueOnce([row("tab-1", 1, true, ICON_A)])
      .mockResolvedValue(undefined);
    const { result, rerender } = strip(iconBridge(read));
    await waitFor(() => expect(result.current.get("ctx-1")?.icons.get("tab-1")).toBe(ICON_A));
    rerender({ refreshKey: 1 });
    await waitFor(() => expect(result.current.has("ctx-1")).toBe(false));
  });

  it("keeps the last icons through a transient read failure", async () => {
    const read = vi
      .fn<ReadIcons>()
      .mockResolvedValueOnce([row("tab-1", 1, true, ICON_A)])
      .mockRejectedValue(new Error("ipc channel closed"));
    const { result, rerender } = strip(iconBridge(read));
    await waitFor(() => expect(result.current.get("ctx-1")?.icons.get("tab-1")).toBe(ICON_A));
    rerender({ refreshKey: 1 });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(result.current.get("ctx-1")?.icons.get("tab-1")).toBe(ICON_A);
  });

  it("commits a multi-context read whole or not at all when the poll is replaced", async () => {
    let hangSecondContext = false;
    const read = vi.fn<ReadIcons>((request) => {
      if (request.contextId === "ctx-1") {
        return Promise.resolve(
          request.known.length === 0
            ? [row("tab-1", 1, true, ICON_A)]
            : [row("tab-1", 2, true, ICON_B)],
        );
      }
      // The second poll's read on ctx-2 stays open while the whole poll is
      // replaced, so nothing it staged can be committed.
      if (hangSecondContext && request.known.length !== 0) {
        return new Promise<ReadonlyArray<BrowserSurfaceTabIcon>>(() => {});
      }
      return Promise.resolve([row("tab-9", 1, true, ICON_A)]);
    });
    const bridge = iconBridge(read);
    const { result, rerender } = renderHook(
      (props: { refreshKey: number }) =>
        useBrowserSurfaceTabIcons({
          contextIds: ["ctx-1", "ctx-2"],
          hostBridge: bridge,
          refreshKey: props.refreshKey,
          threadId: "thread-1",
        }),
      { initialProps: { refreshKey: 0 } },
    );
    await waitFor(() => expect(result.current.get("ctx-1")?.icons.get("tab-1")).toBe(ICON_A));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    // Poll two answers ctx-1's new image but hangs on ctx-2; replacing it must
    // not ack ctx-1's new revision early.
    hangSecondContext = true;
    rerender({ refreshKey: 1 });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(4));
    hangSecondContext = false;
    rerender({ refreshKey: 2 });
    await waitFor(() => expect(result.current.get("ctx-1")?.icons.get("tab-1")).toBe(ICON_B));
    // The replaced poll's read of ctx-1 asked with the last committed
    // revision — the hung poll's newer one was never acked.
    const replacedPollRead = read.mock.calls
      .map(([request]) => request)
      .filter((request) => request.contextId === "ctx-1")
      .at(-2);
    expect(replacedPollRead?.known).toEqual([{ tabId: "tab-1", revision: 1 }]);
    // And the committed poll's read still names that same revision until the
    // new image actually lands — no stale ack.
    const committedRead = read.mock.calls
      .map(([request]) => request)
      .filter((request) => request.contextId === "ctx-1")
      .at(-1);
    expect(committedRead?.known).toEqual([{ tabId: "tab-1", revision: 1 }]);
  });

  it("forgets the old bridge's icons when the bridge changes", async () => {
    const readOld = vi.fn(async (_request: BrowserSurfaceTabIconsRequest) => [
      row("tab-1", 1, true, ICON_A),
    ]);
    const readNew = vi.fn(async (_request: BrowserSurfaceTabIconsRequest) => [
      row("tab-1", 1, true, ICON_B),
    ]);
    const { result, rerender } = renderHook(
      (props: { bridge: OctantHostBridge }) =>
        useBrowserSurfaceTabIcons({
          contextIds: ["ctx-1"],
          hostBridge: props.bridge,
          threadId: "thread-1",
        }),
      { initialProps: { bridge: iconBridge(readOld) } },
    );
    await waitFor(() => expect(result.current.get("ctx-1")?.icons.get("tab-1")).toBe(ICON_A));
    rerender({ bridge: iconBridge(readNew) });
    // The new bridge's read is a new authority: the old answer is gone the
    // moment it changes, and only the new bridge's rows may show.
    await waitFor(() => expect(result.current.get("ctx-1")?.icons.get("tab-1")).toBe(ICON_B));
    expect(readNew.mock.calls[0]?.[0].known).toEqual([]);
  });

  it("marks a sleeping read so the strip can dim the kept icons", async () => {
    const read = vi.fn(async (_request: BrowserSurfaceTabIconsRequest) => [
      row("tab-1", 1, true, ICON_A, true),
    ]);
    const { result } = strip(iconBridge(read));
    await waitFor(() => expect(result.current.get("ctx-1")?.sleeping).toBe(true));
    expect(result.current.get("ctx-1")?.icons.get("tab-1")).toBe(ICON_A);
  });
});
