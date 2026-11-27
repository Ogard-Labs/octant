import { describe, expect, it } from "vitest";
import { chatVisitorState, codeVisitorState } from "./visitorThreadSources";

describe("a visitor's thread state follows the run, not the messages", () => {
  it("reads a Chat reply still streaming as working, and a turn stopped before it replied as idle", () => {
    expect(chatVisitorState("queued")).toBe("working");
    expect(chatVisitorState("streaming")).toBe("working");
    expect(chatVisitorState("interrupted")).toBe("idle");
    expect(chatVisitorState("cancelled")).toBe("idle");
    expect(chatVisitorState("failed")).toBe("idle");
    expect(chatVisitorState("completed")).toBe("idle");
    expect(chatVisitorState("waiting")).toBe("owner-deciding");
    expect(chatVisitorState(undefined)).toBe("idle");
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
