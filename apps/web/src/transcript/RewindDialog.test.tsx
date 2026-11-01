import { describe, expect, it } from "vitest";
import { composerAfterRewind } from "./RewindDialog";

describe("composerAfterRewind", () => {
  it("returns the rewound message and keeps a draft the person was already writing below it", () => {
    expect(composerAfterRewind("rewrite the parser", "")).toBe("rewrite the parser");
    expect(composerAfterRewind("rewrite the parser", "  ")).toBe("rewrite the parser");
    expect(composerAfterRewind("rewrite the parser", "and add tests")).toBe(
      "rewrite the parser\n\nand add tests",
    );
  });
});
