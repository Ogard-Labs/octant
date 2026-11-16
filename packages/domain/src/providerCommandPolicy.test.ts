import { describe, expect, it } from "vitest";
import { providerCommandOf } from "./providerCommandPolicy";

const commands = [{ name: "review" }, { name: "plugin:deploy" }];

describe("provider slash commands", () => {
  it("names the listed command a prompt opens with", () => {
    expect(providerCommandOf("  /review src", commands)).toBe("review");
    expect(providerCommandOf("/plugin:deploy", commands)).toBe("plugin:deploy");
  });

  it("leaves text that only starts with a slash alone when the provider listed no such command", () => {
    expect(providerCommandOf("/usr/bin is on PATH", commands)).toBeUndefined();
    expect(providerCommandOf("/reviewer please", commands)).toBeUndefined();
    expect(providerCommandOf("please /review", commands)).toBeUndefined();
    expect(providerCommandOf("/review", undefined)).toBeUndefined();
  });
});
