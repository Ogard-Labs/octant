import { describe, expect, it } from "vitest";
import { decodeThreadBoardReason, decodeThreadBoardStatus } from "./threadBoard";

describe("thread board contracts", () => {
  it("decodes the four shared board statuses and rejects unknown ones", () => {
    for (const status of ["ready", "in-progress", "waiting", "done"] as const) {
      expect(decodeThreadBoardStatus(status)).toBe(status);
    }
    expect(() => decodeThreadBoardStatus("blocked")).toThrow();
  });

  it("decodes each specific board reason and rejects unknown ones", () => {
    for (const reason of [
      "delivery-satisfied",
      "executing",
      "awaiting-input",
      "interrupted",
      "recovering",
      "delivery-waiting",
      "idle-unmet-delivery",
    ] as const) {
      expect(decodeThreadBoardReason(reason)).toBe(reason);
    }
    expect(() => decodeThreadBoardReason("waiting-runtime")).toThrow();
  });
});
