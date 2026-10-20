import { describe, expect, it } from "vitest";
import { createRequestGuard } from "./requestGuard";

describe("request guard", () => {
  it("invalidates an earlier response when a newer request starts", () => {
    const guard = createRequestGuard();
    const first = guard.begin();
    const second = guard.begin();

    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);

    guard.invalidate();

    expect(guard.isCurrent(second)).toBe(false);
  });

  it("keeps separate guards independent", () => {
    const inbox = createRequestGuard();
    const projects = createRequestGuard();
    const request = inbox.begin();
    projects.begin();

    expect(inbox.isCurrent(request)).toBe(true);
  });
});
