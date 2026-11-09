import { describe, expect, it } from "vitest";
import { decodeBrowserSessionGrantsCommand } from "./browserSessionGrants";

const review = {
  kind: "review",
  grantee: { kind: "child", runId: "10000000-0000-4000-8000-000000000001" },
  profile: { kind: "personal" },
  origins: ["https://example.com"],
  durationMinutes: 15,
};
describe("Browser session permission commands", () => {
  it("accepts explicit child, routine and terminal identities without accepting supplied authority", () => {
    for (const grantee of [
      review.grantee,
      { kind: "routine", routineId: "10000000-0000-4000-8000-000000000002" },
      { kind: "terminal", grantId: "10000000-0000-4000-8000-000000000003" },
    ])
      expect(decodeBrowserSessionGrantsCommand({ ...review, grantee })).toMatchObject({ grantee });
    expect(() =>
      decodeBrowserSessionGrantsCommand({ ...review, authority: { mode: "code" } }),
    ).toThrow();
    expect(() =>
      decodeBrowserSessionGrantsCommand({ ...review, continuesWithoutWindow: true }),
    ).toThrow();
    expect(() =>
      decodeBrowserSessionGrantsCommand({ ...review, ownerId: review.grantee.runId }),
    ).toThrow();
    expect(() =>
      decodeBrowserSessionGrantsCommand({
        ...review,
        grantee: { ...review.grantee, parentRunId: review.grantee.runId },
      }),
    ).toThrow();
  });
  it("bounds site count, expiry choices and review references", () => {
    expect(() =>
      decodeBrowserSessionGrantsCommand({
        ...review,
        origins: Array.from({ length: 17 }, () => "https://example.com"),
      }),
    ).toThrow();
    expect(() => decodeBrowserSessionGrantsCommand({ ...review, durationMinutes: 0 })).toThrow();
    expect(() =>
      decodeBrowserSessionGrantsCommand({ kind: "grant", reviewId: "not-a-review" }),
    ).toThrow();
  });
});
