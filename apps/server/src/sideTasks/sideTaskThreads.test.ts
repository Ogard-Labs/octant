import { describe, expect, it } from "vitest";
import { sideTaskChildState } from "./sideTaskThreads";

describe("sideTaskChildState", () => {
  it("answers nothing for a child the window cannot read", () => {
    expect(sideTaskChildState(undefined)).toBeUndefined();
  });

  it("reads a turn parked on the person as attention even while the row still executes", () => {
    expect(sideTaskChildState({ executing: true, awaitingInput: true })).toBe("attention");
  });

  it("reads a running turn as working", () => {
    expect(sideTaskChildState({ executing: true })).toBe("working");
    expect(sideTaskChildState({ executing: true, followUp: false })).toBe("working");
  });

  it("reads an open follow-up obligation as attention", () => {
    expect(sideTaskChildState({ followUp: true })).toBe("attention");
  });

  it("reads a Code lifecycle of waiting or interrupted as attention", () => {
    expect(sideTaskChildState({ lifecycle: "waiting" })).toBe("attention");
    expect(sideTaskChildState({ lifecycle: "interrupted" })).toBe("attention");
  });

  it("reads every other readable row as quiet", () => {
    expect(sideTaskChildState({})).toBe("quiet");
    expect(sideTaskChildState({ lifecycle: "active" })).toBe("quiet");
    expect(sideTaskChildState({ lifecycle: "archived" })).toBe("quiet");
  });
});
