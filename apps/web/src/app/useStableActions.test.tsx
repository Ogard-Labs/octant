import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useStableActions } from "./useStableActions";

describe("stable shell actions", () => {
  it("keeps one function identity across renders while calling the newest action", () => {
    const seen: string[] = [];
    const { result, rerender } = renderHook(
      ({ label }: { readonly label: string }) =>
        useStableActions(() => ({
          note: (suffix: string) => {
            seen.push(`${label}${suffix}`);
            return `${label}${suffix}`;
          },
        })),
      { initialProps: { label: "first" } },
    );
    const noteBefore = result.current.note;
    expect(noteBefore("!")).toBe("first!");

    rerender({ label: "second" });
    act(() => undefined);
    expect(result.current.note).toBe(noteBefore);
    expect(result.current.note("?")).toBe("second?");
    expect(seen).toEqual(["first!", "second?"]);
  });

  it("answers a name that is not an action the way a plain object would", () => {
    const { result } = renderHook(() => useStableActions(() => ({ open: () => "opened" })));
    expect("open" in result.current).toBe(true);
    expect(Object.keys(result.current)).toEqual(["open"]);
    expect(String(result.current)).toBe("[object Object]");
  });
});
