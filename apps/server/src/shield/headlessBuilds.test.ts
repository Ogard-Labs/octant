import { describe, expect, it } from "vitest";
import { isNewerVersion } from "./headlessBuilds";

describe("headless build versions", () => {
  it("offers a final release to a member running its own candidate, and not the reverse", () => {
    expect(isNewerVersion("1.2.3", "1.2.3-candidate.20261121.4")).toBe(true);
    expect(isNewerVersion("1.2.3-candidate.20261121.4", "1.2.3")).toBe(false);
    expect(isNewerVersion("1.2.10", "1.2.9")).toBe(true);
  });
});
