import { describe, expect, it } from "vitest";
import { chatVisitorState, codeVisitorState } from "./visitorThreadSources";

describe("a visitor's thread state follows the run, not the messages", () => {
  it("reads a Chat reply still streaming as working, and a turn stopped before it replied as idle", () => {
    expect(chatVisitorState(["queued"], false)).toBe("working");
    expect(chatVisitorState(["streaming"], false)).toBe("working");
    expect(chatVisitorState(["interrupted"], false)).toBe("idle");
    expect(chatVisitorState(["cancelled"], false)).toBe("idle");
    expect(chatVisitorState(["failed"], false)).toBe("idle");
    expect(chatVisitorState(["completed"], false)).toBe("idle");
    expect(chatVisitorState(["waiting"], false)).toBe("owner-deciding");
    expect(chatVisitorState([undefined], false)).toBe("idle");
    expect(chatVisitorState([], false)).toBe("idle");
  });

  it("reads a regenerated older Chat reply as working even when the last turn is done", () => {
    expect(chatVisitorState(["streaming", "completed"], false)).toBe("working");
  });

  it("reads a usage-limit stop as the owner deciding only while it is the last turn's and not released", () => {
    expect(chatVisitorState(["completed", "waiting"], false)).toBe("owner-deciding");
    expect(chatVisitorState(["completed", "waiting"], true)).toBe("idle");
    expect(chatVisitorState(["waiting", "completed"], false)).toBe("idle");
  });

  it("reads a Code turn still executing as working, and one stopped before it replied as idle", () => {
    expect(codeVisitorState("active", { executing: true, awaitingInput: false })).toBe("working");
    expect(codeVisitorState("active", { executing: false, awaitingInput: false })).toBe("idle");
    expect(codeVisitorState("active", {})).toBe("idle");
    expect(codeVisitorState("active", { executing: false, awaitingInput: true })).toBe(
      "owner-deciding",
    );
    expect(codeVisitorState("waiting", { executing: false })).toBe("owner-deciding");
  });
});
