import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { settledThreadNotice } from "./settledThreadNotice";

describe("the settled notice above a thread's composer", () => {
  it("says how long ago the thread settled and un-settles it in one click", () => {
    const onUnsettle = vi.fn();
    const now = Date.parse("2026-11-24T12:00:00Z");
    const notice = settledThreadNotice({
      settledAt: "2026-11-24T11:41:00Z",
      onUnsettle,
      now,
    });
    expect(notice?.text).toBe("Settled 19m ago");
    render(<>{notice?.action}</>);
    fireEvent.click(screen.getByRole("button", { name: "Un-settle" }));
    expect(onUnsettle).toHaveBeenCalledOnce();
  });

  it("shows nothing for a thread that has not settled", () => {
    expect(settledThreadNotice({ settledAt: undefined, onUnsettle: vi.fn() })).toBeUndefined();
  });
});
