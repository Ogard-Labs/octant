import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useCodeDiffIgnoreWhitespace } from "./codeDiffWhitespacePreference";

beforeEach(() => localStorage.clear());

describe("diff whitespace preference in mounted views", () => {
  it("moves every mounted view when one of them changes the choice", () => {
    const hidden = renderHook(() => useCodeDiffIgnoreWhitespace());
    const visible = renderHook(() => useCodeDiffIgnoreWhitespace());
    expect(hidden.result.current[0]).toBe(false);

    act(() => visible.result.current[1](true));
    expect(visible.result.current[0]).toBe(true);
    expect(hidden.result.current[0]).toBe(true);

    act(() => hidden.result.current[1](false));
    expect(visible.result.current[0]).toBe(false);
  });
});
