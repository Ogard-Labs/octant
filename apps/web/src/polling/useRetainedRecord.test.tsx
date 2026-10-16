import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useRetainedRecord } from "./useRetainedRecord";

describe("retained records", () => {
  it("keeps the previous object while every field holds the same value", () => {
    const list: ReadonlyArray<string> = ["a"];
    const { result, rerender } = renderHook(
      ({ count }: { readonly count: number }) => useRetainedRecord({ count, list }),
      { initialProps: { count: 1 } },
    );
    const first = result.current;
    rerender({ count: 1 });
    expect(result.current).toBe(first);
    rerender({ count: 2 });
    expect(result.current).not.toBe(first);
    expect(result.current.count).toBe(2);
  });

  it("treats a field that appears or disappears as a change", () => {
    const { result, rerender } = renderHook(
      ({ message }: { readonly message?: string }) =>
        useRetainedRecord({ status: "ready", ...(message === undefined ? {} : { message }) }),
      { initialProps: {} },
    );
    const quiet = result.current;
    rerender({ message: "said" });
    expect(result.current).not.toBe(quiet);
    expect(result.current.message).toBe("said");
    rerender({});
    expect(result.current).not.toBe(quiet);
    expect("message" in result.current).toBe(false);
  });
});
