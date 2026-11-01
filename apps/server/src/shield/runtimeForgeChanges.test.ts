import { describe, expect, it, vi } from "vitest";
import { createRuntimeForgeChangeObserver } from "./runtimeForgeChanges";

const branches = () => ({ ownBranch: "feature/mine", otherThreadBranches: ["feature/theirs"] });

describe("pushes and pull-request changes a provider runtime starts", () => {
  it("records each one seen after it started, flagging a hard line only at Full access", () => {
    const record = vi.fn();
    const observer = createRuntimeForgeChangeObserver({ branches, record });
    observer.observe({
      threadId: "t",
      command: "git push origin feature/theirs",
      fullAccess: true,
    });
    observer.observe({ threadId: "t", command: "gh pr merge 3", fullAccess: false });
    observer.observe({ threadId: "t", command: "bun test", fullAccess: true });
    expect(record).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        via: "provider-runtime",
        outcome: "seen-after-start",
        hardLine: "other-thread-branch",
      }),
    );
    expect(record.mock.calls[1]?.[0]).not.toHaveProperty("hardLine");
  });

  it("leaves the turn alone when the record cannot be kept", () => {
    const observer = createRuntimeForgeChangeObserver({
      branches,
      record: () => {
        throw new Error("journal closed");
      },
    });
    expect(() =>
      observer.observe({ threadId: "t", command: "git push", fullAccess: true }),
    ).not.toThrow();
  });
});
