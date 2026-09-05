import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useThreadUtilityPresentation } from "./useThreadUtilityPresentation";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

const windowId = "00000000-0000-4000-8000-0000000009a1";

function storedOpen(storage: Storage): unknown {
  const raw = storage.getItem(`octant.shell.utility-dock.${windowId}.v1`);
  return raw === null ? undefined : (JSON.parse(raw) as { readonly open?: unknown }).open;
}

describe("useThreadUtilityPresentation", () => {
  it("shows the dock when a wide window arrives having never chosen", () => {
    const localStorage = memoryStorage();
    const { result } = renderHook(() =>
      useThreadUtilityPresentation(windowId, { localStorage }, true),
    );

    expect(result.current.dockVisible).toBe(true);
  });

  // A wide window that arrives with the dock hidden leaves the workspace as one
  // column against an empty region, which is the layout 0041 exists to prevent.
  // Two shell passes have flipped this default while restyling; the argument is
  // optional, so the fallback has to be the wide-window answer on its own.
  it("shows the dock when a caller passes no arrival width", () => {
    const localStorage = memoryStorage();
    const { result } = renderHook(() => useThreadUtilityPresentation(windowId, { localStorage }));

    expect(result.current.dockVisible).toBe(true);
  });

  it("hides the dock when a narrow window arrives, where it would cover the workspace", () => {
    const localStorage = memoryStorage();
    const { result } = renderHook(() =>
      useThreadUtilityPresentation(windowId, { localStorage }, false),
    );

    expect(result.current.dockVisible).toBe(false);
  });

  it("honours an explicit close on the next launch of the same window", () => {
    const localStorage = memoryStorage();
    const first = renderHook(() => useThreadUtilityPresentation(windowId, { localStorage }, true));
    act(() => {
      first.result.current.setDockVisible(false);
    });
    first.unmount();

    const { result } = renderHook(() =>
      useThreadUtilityPresentation(windowId, { localStorage }, true),
    );

    expect(result.current.dockVisible).toBe(false);
  });

  // An embedded window reports a zero-width viewport on its first frame, which
  // reads as narrow. Recording that reading turned "not chosen yet" into a
  // close the user never made, and the window honoured it on every later launch.
  it("records no choice for a window nobody has shown or hidden the dock in", () => {
    const localStorage = memoryStorage();
    renderHook(() => useThreadUtilityPresentation(windowId, { localStorage }, false));

    expect(storedOpen(localStorage)).toBeUndefined();
  });
});
