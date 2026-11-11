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
});
