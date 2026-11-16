import { describe, expect, it } from "vitest";

import { createStrictResolver } from "./strictResolution";

describe("Strict resolution", () => {
  it("reads each thread's choice, its Project's and Settings' as they are at the moment it is asked", () => {
    const state = {
      codeThreadStrict: undefined as boolean | undefined,
      projectStrict: undefined as boolean | undefined,
      codeDefault: undefined as boolean | undefined,
      workDefault: undefined as boolean | undefined,
    };
    const resolve = createStrictResolver({
      codeThread: (threadId) =>
        threadId === "code-thread"
          ? { projectId: "project", strict: state.codeThreadStrict }
          : undefined,
      workThread: (threadId) => (threadId === "work-thread" ? { projectId: "project" } : undefined),
      project: () => ({ defaultStrict: state.projectStrict }),
      codeSettings: () => ({ defaultStrict: state.codeDefault }),
      workSettings: () => ({ defaultStrict: state.workDefault }),
    });

    expect(resolve("code-thread")).toBe(false);
    state.codeDefault = true;
    expect(resolve("code-thread")).toBe(true);
    expect(resolve("work-thread")).toBe(false);
    state.projectStrict = false;
    expect(resolve("code-thread")).toBe(false);
    state.codeThreadStrict = true;
    expect(resolve("code-thread")).toBe(true);
    // A Chat thread has no switch of its own and follows either default.
    expect(resolve("chat-thread")).toBe(true);
    state.codeDefault = false;
    expect(resolve("chat-thread")).toBe(false);
    state.workDefault = true;
    expect(resolve("chat-thread")).toBe(true);
  });
});
