import { describe, expect, it } from "vitest";
import { resolveWorkKind, visibleModeOf, visibleModes } from "./workKind";

describe("work kinds", () => {
  it("shows Chat and Work as one Work mode beside Code", () => {
    expect(visibleModes(["chat", "work", "code"])).toEqual(["work", "code"]);
    expect(visibleModes(["chat", "code"])).toEqual(["work", "code"]);
    expect(visibleModes(["code"])).toEqual(["code"]);
    expect(visibleModeOf("chat")).toBe("work");
    expect(visibleModeOf("work")).toBe("work");
    expect(visibleModeOf("code")).toBe("code");
  });

  it("opens Work on the kind last used while it is still enabled, falling back to Chat", () => {
    expect(resolveWorkKind("work", ["chat", "work", "code"])).toBe("work");
    expect(resolveWorkKind("work", ["chat", "code"])).toBe("chat");
    expect(resolveWorkKind(undefined, ["chat", "work", "code"])).toBe("chat");
    expect(resolveWorkKind(undefined, ["work", "code"])).toBe("work");
    expect(resolveWorkKind("chat", ["code"])).toBeUndefined();
  });
});
