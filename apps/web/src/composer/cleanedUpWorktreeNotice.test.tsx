import { cleanedUpWorktreeSentence } from "@octant/domain";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { cleanedUpWorktreeNotice } from "./cleanedUpWorktreeNotice";

describe("the cleaned-up worktree notice above a Code thread's composer", () => {
  it("says the worktree was cleaned up and the branch is kept, and offers Restore worktree", () => {
    const onRestore = vi.fn();
    const notice = cleanedUpWorktreeNotice({ standing: "cleaned-up", onRestore });
    expect(notice?.text).toBe(cleanedUpWorktreeSentence("cleaned-up"));
    expect(notice?.text).toContain("branch and the thread are kept");
    render(<>{notice?.action}</>);
    fireEvent.click(screen.getByRole("button", { name: "Restore worktree" }));
    expect(onRestore).toHaveBeenCalledOnce();
  });

  it("gives a device that may not restore the sentence without the button", () => {
    const notice = cleanedUpWorktreeNotice({ standing: "cleaned-up", onRestore: undefined });
    expect(notice?.text).toBe(cleanedUpWorktreeSentence("cleaned-up"));
    expect(notice?.action).toBeUndefined();
  });

  it("shows nothing while the thread has its folder, and disables the button while restoring", () => {
    expect(cleanedUpWorktreeNotice({ standing: undefined, onRestore: vi.fn() })).toBeUndefined();
    const notice = cleanedUpWorktreeNotice({
      standing: "cleaned-up",
      busy: true,
      onRestore: vi.fn(),
    });
    render(<>{notice?.action}</>);
    expect(screen.getByRole("button", { name: "Restoring…" })).toBeDisabled();
  });
});
