import { describe, expect, it } from "vitest";
import { localHostDisplayName } from "./localHostDisplayName";

describe("localHostDisplayName", () => {
  it("uses the neutral host label without inspecting the browser platform", () => {
    expect(localHostDisplayName()).toBe("This computer");
  });
});
