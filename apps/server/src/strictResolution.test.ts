import { afterEach, describe, expect, it } from "vitest";
import { configureSandboxRestrictionsAuthority } from "./process/sandboxRuntimePolicy";

import { createStrictResolver } from "./strictResolution";
afterEach(() => configureSandboxRestrictionsAuthority(undefined));

describe("Strict resolution", () => {
  it("keeps both tightening and relaxation pending while an admitted turn owns its boundary", () => {
    let active: boolean | undefined = true;
    let requested = false;
    configureSandboxRestrictionsAuthority({
      strictForActiveTurn: () => active,
      active: () => undefined,
      validateSelection: () => false,
      storageDirectory: () => undefined,
      registerCleanup: () => () => undefined,
      deny: () => undefined,
      beginTurn: () => ({ status: "refused", message: "unused" }),
    });
    const resolve = createStrictResolver({
      codeThread: () => ({ projectId: "project", strict: requested }),
      workThread: () => undefined,
      project: () => undefined,
      codeSettings: () => undefined,
      workSettings: () => undefined,
    });
    expect(resolve("thread")).toBe(true);
    active = false;
    requested = true;
    expect(resolve("thread")).toBe(false);
    active = undefined;
    expect(resolve("thread")).toBe(true);
  });
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
      project: () => ({ type: "code", defaultStrict: state.projectStrict }),
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
