import { describe, expect, it } from "vitest";
import {
  createSideTaskChildStanding,
  sideTaskChildState,
  type SideTaskChildReaders,
} from "./sideTaskThreads";

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

describe("what the host reads of a started child before it settles the parent", () => {
  const readers = (overrides: Partial<SideTaskChildReaders> = {}): SideTaskChildReaders => ({
    chatRow: () => ({ executing: false, followUpOpen: false }),
    workThread: () => ({ lifecycle: "active" }),
    workRuntime: () => ({ executing: false }),
    codeThread: () => ({ lifecycle: "active" }),
    codeActivity: () => ({ executing: false, awaitingInput: false }),
    codeFollowUpOpen: () => false,
    ...overrides,
  });
  const standing = (
    mode: "chat" | "work" | "code",
    overrides: Partial<SideTaskChildReaders> = {},
  ) => createSideTaskChildStanding(readers(overrides))({ mode, threadId: "child" });

  it("reads a child at rest as quiet in every mode", () => {
    expect(standing("chat")).toBe("quiet");
    expect(standing("work")).toBe("quiet");
    expect(standing("code")).toBe("quiet");
  });

  it("reads a child that works or needs the person in every mode", () => {
    expect(standing("chat", { chatRow: () => ({ executing: true, followUpOpen: false }) })).toBe(
      "working",
    );
    expect(standing("work", { workRuntime: () => ({ executing: true }) })).toBe("working");
    expect(standing("code", { codeActivity: () => ({ executing: true }) })).toBe("working");
    expect(
      standing("work", { workRuntime: () => ({ executing: false, awaitingInput: true }) }),
    ).toBe("attention");
    expect(standing("chat", { chatRow: () => ({ executing: false, followUpOpen: true }) })).toBe(
      "attention",
    );
    expect(standing("code", { codeFollowUpOpen: () => true })).toBe("attention");
  });

  it("reads a child that is archived, deleted or purged as closed, whatever its last turn did", () => {
    expect(standing("chat", { chatRow: () => undefined })).toBe("closed");
    const working = { workRuntime: () => ({ executing: true }) };
    expect(standing("work", { ...working, workThread: () => undefined })).toBe("closed");
    expect(standing("work", { ...working, workThread: () => ({ lifecycle: "archived" }) })).toBe(
      "closed",
    );
    const running = { codeActivity: () => ({ executing: true }) };
    expect(standing("code", { ...running, codeThread: () => undefined })).toBe("closed");
    expect(standing("code", { ...running, codeThread: () => ({ lifecycle: "archived" }) })).toBe(
      "closed",
    );
  });
});
