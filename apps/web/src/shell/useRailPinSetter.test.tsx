import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRailPinSetter } from "./useRailPinSetter";

describe("useRailPinSetter", () => {
  it("keeps the other saved pins while the Project list is not loaded", () => {
    const save = vi.fn();
    const { result } = renderHook(() => useRailPinSetter<string>(["a", "b"], undefined, save));
    act(() => result.current("c", true));
    expect(save).toHaveBeenLastCalledWith(["a", "b", "c"]);
  });

  it("keeps the other saved pins when unpinning while the list is not loaded", () => {
    const save = vi.fn();
    const { result } = renderHook(() => useRailPinSetter<string>(["a", "b"], undefined, save));
    act(() => result.current("a", false));
    expect(save).toHaveBeenLastCalledWith(["b"]);
  });

  it("drops pins for Projects that are gone once the list is complete", () => {
    const save = vi.fn();
    const { result } = renderHook(() =>
      useRailPinSetter<string>(["a", "gone"], new Set(["a", "b"]), save),
    );
    act(() => result.current("b", true));
    expect(save).toHaveBeenLastCalledWith(["a", "b"]);
  });

  it("saves both of two actions made in the same tick", () => {
    const save = vi.fn();
    const { result } = renderHook(() => useRailPinSetter<string>(["a"], undefined, save));
    act(() => {
      result.current("b", true);
      result.current("c", true);
    });
    expect(save).toHaveBeenNthCalledWith(1, ["a", "b"]);
    expect(save).toHaveBeenNthCalledWith(2, ["a", "b", "c"]);
  });

  it("keeps a later pin when an earlier write is shown while saves are still queued", async () => {
    const answers: Array<(accepted: boolean) => void> = [];
    const save = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answers.push(resolve);
        }),
    );
    const { result, rerender } = renderHook(
      ({ saved }: { saved: ReadonlyArray<string> }) =>
        useRailPinSetter<string>(saved, undefined, save),
      { initialProps: { saved: ["a"] } },
    );
    await act(async () => {
      result.current("b", true);
      result.current("c", true);
    });
    // The controller shows the first queued write before the second is sent.
    rerender({ saved: ["a", "b"] });
    await act(async () => {
      result.current("d", true);
    });
    expect(save).toHaveBeenNthCalledWith(3, ["a", "b", "c", "d"]);
    await act(async () => {
      for (const answer of answers) answer(true);
    });
  });

  it("follows a list the host hands back once nothing of its own is in flight", async () => {
    const save = vi.fn(async () => true);
    const { result, rerender } = renderHook(
      ({ saved }: { saved: ReadonlyArray<string> }) =>
        useRailPinSetter<string>(saved, undefined, save),
      { initialProps: { saved: ["a"] } },
    );
    await act(async () => {
      result.current("b", true);
    });
    // Another window unpinned A and pinned Z.
    rerender({ saved: ["b", "z"] });
    await act(async () => {
      result.current("c", true);
    });
    expect(save).toHaveBeenLastCalledWith(["b", "z", "c"]);
  });

  it("does not build on a pin whose write the host refused", async () => {
    const save = vi.fn(async () => false);
    const { result } = renderHook(() => useRailPinSetter<string>(["a"], undefined, save));
    await act(async () => {
      result.current("b", true);
    });
    await act(async () => {
      result.current("c", true);
    });
    expect(save).toHaveBeenLastCalledWith(["a", "c"]);
  });
});
