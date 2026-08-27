import { describe, expect, it } from "vitest";
import { localHostDisplayName } from "./localHostDisplayName";

describe("localHostDisplayName", () => {
  it("uses the Mac label only for Darwin", () => {
    expect(localHostDisplayName("darwin")).toBe("This Mac");
  });

  it("uses the neutral computer label elsewhere", () => {
    expect(localHostDisplayName("linux")).toBe("This computer");
    expect(localHostDisplayName("win32")).toBe("This computer");
  });
});
