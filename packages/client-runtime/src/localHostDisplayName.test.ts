import { describe, expect, it } from "vitest";
import { localHostDisplayName } from "./localHostDisplayName";

describe("localHostDisplayName", () => {
  it("uses the Mac label for Apple platforms", () => {
    expect(localHostDisplayName({ userAgentData: { platform: "macOS" } })).toBe("This Mac");
    expect(localHostDisplayName({ platform: "MacIntel" })).toBe("This Mac");
  });

  it("uses the neutral computer label for other platforms", () => {
    expect(localHostDisplayName({ userAgentData: { platform: "Linux" } })).toBe("This computer");
    expect(localHostDisplayName({ platform: "Linux x86_64" })).toBe("This computer");
  });
});
