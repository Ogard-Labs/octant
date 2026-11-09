import { describe, expect, it } from "vitest";
import { decodeProviderFileReviewRead, decodeProviderFileReviewPath } from "./providerFileReview";

const snapshot = {
  status: "ready",
  file: {
    path: "src/example.ts",
    checkpoint: "before\n",
    scopes: [{ id: "native-turn:7", label: "Provider turn 7", source: "provider-turn" }],
    comparison: {
      scopeId: "native-turn:7",
      change: "modified",
      before: "before\n",
      after: "after\n",
    },
    anchors: [{ side: "after", line: 1 }],
  },
};

describe("supplementary provider file review", () => {
  it("keeps an empty checkpoint distinct from an unavailable reading", () => {
    expect(
      decodeProviderFileReviewRead({ ...snapshot, file: { ...snapshot.file, checkpoint: "" } })
        .status,
    ).toBe("ready");
    expect(decodeProviderFileReviewRead({ status: "refused", reason: "cold-unavailable" })).toEqual(
      { status: "refused", reason: "cold-unavailable" },
    );
  });

  it("accepts bounded read data without a verdict or a filesystem mutation", () => {
    expect(decodeProviderFileReviewRead(snapshot)).toEqual(snapshot);
    expect(() => decodeProviderFileReviewRead({ ...snapshot, approved: true })).toThrow();
    expect(() =>
      decodeProviderFileReviewRead({
        ...snapshot,
        file: { ...snapshot.file, cwd: "/private/host" },
      }),
    ).toThrow();
  });

  it("refuses escaping paths, unbounded text and a comparison from an unknown scope", () => {
    for (const path of [
      "../outside",
      "/private/host",
      "src/../outside",
      "C:\\outside",
      "src\\outside",
      "a\0b",
    ]) {
      expect(() => decodeProviderFileReviewPath(path)).toThrow();
    }
    expect(() =>
      decodeProviderFileReviewRead({
        ...snapshot,
        file: { ...snapshot.file, checkpoint: "x".repeat(262145) },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderFileReviewRead({
        ...snapshot,
        file: { ...snapshot.file, comparison: { ...snapshot.file.comparison, scopeId: "unknown" } },
      }),
    ).toThrow();
  });
});
