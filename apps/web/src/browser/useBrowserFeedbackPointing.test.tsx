import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BrowserSurfaceState, OctantHostBridge } from "../shell/hostBridge";
import type { ProductFeedback } from "./useProductFeedback";
import { useBrowserFeedbackPointing } from "./useBrowserFeedbackPointing";

const contextId = "60000000-0000-4000-8000-000000000001";
const threadId = "10000000-0000-4000-8000-000000000001";
function transport(holdFirstReply = false) {
  const listeners = new Set<(state: BrowserSurfaceState) => void>();
  const base: BrowserSurfaceState = {
    contextId,
    url: "https://example.test/",
    title: "Example",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    control: "user",
    tabs: [],
    activeTabId: "tab",
  };
  let state = base;
  let nextId = 1;
  const replies: Array<() => void> = [];
  const publish = () => {
    for (const listener of listeners) listener(state);
  };
  const select = vi.fn(
    async (request: Parameters<NonNullable<OctantHostBridge["selectBrowserSurfacePoint"]>>[0]) => {
      if (request.enabled) {
        state = {
          ...base,
          pointSelection: {
            status: "armed",
            requestId: request.requestId,
            selectionId: `62000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
          },
        };
        const snapshot = state;
        publish();
        if (holdFirstReply && nextId === 2)
          return await new Promise<BrowserSurfaceState>((resolve) => {
            replies.push(() => resolve(snapshot));
          });
      } else if (state.pointSelection?.requestId === request.requestId) {
        state = base;
        publish();
      }
      return state;
    },
  );
  const bridge: OctantHostBridge = {
    selectBrowserSurfacePoint: select,
    subscribeBrowserSurfaceState: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    bridge,
    select,
    listeners,
    replies,
    state: () => state,
    selected: () => {
      const armed = state.pointSelection;
      if (armed === undefined) throw Error("No owned selection");
      state = {
        ...state,
        pointSelection: { ...armed, status: "selected", point: { x: 0.25, y: 0.5 } },
      };
      publish();
    },
  };
}
function feedback() {
  return {
    prepare: vi.fn<ProductFeedback["prepare"]>().mockResolvedValue(true),
    cancelPrepare: vi.fn(),
    pauseRefresh: vi.fn(),
  };
}
function Pane(props: {
  name: string;
  bridge: OctantHostBridge;
  feedback: ReturnType<typeof feedback>;
}) {
  const pointing = useBrowserFeedbackPointing({
    contextId,
    threadId,
    native: true,
    bridge: props.bridge,
    feedback: props.feedback,
  });
  return (
    <section aria-label={props.name}>
      <button onClick={pointing.toggle}>{pointing.pointing ? "Cancel pointing" : "Point"}</button>
      {pointing.message === undefined ? null : <p role="status">{pointing.message}</p>}
    </section>
  );
}

describe("a pane's native feedback gesture", () => {
  it("keeps two same-task panes separate across replacement, unmount and a late arm reply", async () => {
    const api = transport(true),
      first = feedback(),
      second = feedback();
    const view = render(
      <>
        <Pane key="first" name="First" bridge={api.bridge} feedback={first} />
        <Pane key="second" name="Second" bridge={api.bridge} feedback={second} />
      </>,
    );
    try {
      fireEvent.click(
        within(screen.getByRole("region", { name: "First" })).getByRole("button", {
          name: "Point",
        }),
      );
      const firstId = api.state().pointSelection?.requestId;
      fireEvent.click(
        within(screen.getByRole("region", { name: "Second" })).getByRole("button", {
          name: "Point",
        }),
      );
      const secondId = api.state().pointSelection?.requestId;
      expect(secondId).not.toBe(firstId);
      expect(api.select).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false, requestId: firstId }),
      );
      expect(api.state().pointSelection?.requestId).toBe(secondId);
      view.rerender(
        <>
          <Pane key="second" name="Second" bridge={api.bridge} feedback={second} />
        </>,
      );
      await act(async () => {
        for (const reply of api.replies.splice(0)) reply();
        await Promise.resolve();
      });
      expect(api.state().pointSelection?.requestId).toBe(secondId);
      await act(async () => {
        api.selected();
        await Promise.resolve();
      });
      expect(first.prepare).not.toHaveBeenCalled();
      expect(second.prepare).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          contextId,
          point: { x: 0.25, y: 0.5 },
          selectionId: expect.any(String),
        }),
      );
      expect(api.state().pointSelection).toBeUndefined();
    } finally {
      await act(async () => {
        for (const reply of api.replies.splice(0)) reply();
      });
      view.unmount();
      expect(api.listeners.size).toBe(0);
    }
  });

  it("cancels an owned in-flight read on unmount and ignores its late completion", async () => {
    vi.useFakeTimers();
    const api = transport(),
      note = feedback();
    let release: () => void = () => undefined;
    note.prepare.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        }),
    );
    const view = render(<Pane name="First" bridge={api.bridge} feedback={note} />);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Point" }));
      act(() => api.selected());
      expect(note.prepare).toHaveBeenCalledOnce();
      const requestId = api.state().pointSelection?.requestId;
      view.unmount();
      expect(note.cancelPrepare).toHaveBeenCalled();
      expect(api.select).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false, requestId }),
      );
      await act(async () => {
        release();
        await Promise.resolve();
      });
      expect(api.select.mock.calls.filter(([request]) => request.enabled)).toHaveLength(1);
      expect(api.state().pointSelection).toBeUndefined();
      expect(api.listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });
});
