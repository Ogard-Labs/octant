import type { ChatAttemptOutcome } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { chatVisitorState, codeVisitorState } from "./visitorThreadSources";

const ran = (outcome: ChatAttemptOutcome) => ({ outcome, usageLimitStop: false });
const limitStop = { outcome: "waiting", usageLimitStop: true } as const;

describe("a visitor's thread state follows the run, not the messages", () => {
  it("reads a Chat reply still streaming as working, and a turn stopped before it replied as idle", () => {
    expect(chatVisitorState([ran("queued")], false)).toBe("working");
    expect(chatVisitorState([ran("streaming")], false)).toBe("working");
    expect(chatVisitorState([ran("interrupted")], false)).toBe("idle");
    expect(chatVisitorState([ran("cancelled")], false)).toBe("idle");
    expect(chatVisitorState([ran("failed")], false)).toBe("idle");
    expect(chatVisitorState([ran("completed")], false)).toBe("idle");
    expect(chatVisitorState([ran("waiting")], false)).toBe("owner-deciding");
    expect(chatVisitorState([undefined], false)).toBe("idle");
    expect(chatVisitorState([], false)).toBe("idle");
  });

  it("reads a regenerated older Chat reply as working even when the last turn is done", () => {
    expect(chatVisitorState([ran("streaming"), ran("completed")], false)).toBe("working");
  });

  it("reads a question from a regenerated older reply as the owner deciding", () => {
    expect(chatVisitorState([ran("waiting"), ran("completed")], false)).toBe("owner-deciding");
  });

  it("reads a usage-limit stop as the owner deciding only while it is the last turn's and not released", () => {
    expect(chatVisitorState([ran("completed"), limitStop], false)).toBe("owner-deciding");
    expect(chatVisitorState([ran("completed"), limitStop], true)).toBe("idle");
    expect(chatVisitorState([limitStop, ran("completed")], false)).toBe("idle");
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
