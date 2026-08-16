import { describe, expect, it } from "vitest";
import { createProjectRequestGuard } from "./projectRequestGuard";

describe("project request guard", () => {
  it("invalidates an earlier host response when a newer request starts", () => {
    const guard = createProjectRequestGuard();
    const first = guard.begin();
    const second = guard.begin();

    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);

    guard.invalidate();

    expect(guard.isCurrent(second)).toBe(false);
  });
});
