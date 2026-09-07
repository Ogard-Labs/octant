import { describe, expect, it } from "vitest";
import { composerPlaceholder, THREAD_HINT } from "./composerPlaceholder";

describe("composerPlaceholder", () => {
  it("names only the triggers the composer mounts", () => {
    expect(composerPlaceholder("Message Octant", [undefined, THREAD_HINT])).toBe(
      "Message Octant · # threads",
    );
    expect(composerPlaceholder("Message Octant", [undefined, undefined])).toBe("Message Octant");
  });
});
