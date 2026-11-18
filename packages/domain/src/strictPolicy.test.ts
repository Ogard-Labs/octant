import { describe, expect, it } from "vitest";
import { resolveStrictPolicy } from "./strictPolicy";

describe("Strict protection inheritance", () => {
  it("uses one preference at every level with explicit thread overrides", () => {
    for (const executionPolicy of [
      "approval-gated",
      "auto-accept-edits",
      "full-access",
      "plan",
    ] as const) {
      expect(
        resolveStrictPolicy({ executionPolicy, settings: { defaultStrict: true } }),
      ).toMatchObject({ enabled: true, source: "settings" });
      expect(
        resolveStrictPolicy({
          executionPolicy,
          settings: { defaultStrict: true },
          project: { defaultStrict: false },
        }),
      ).toMatchObject({ enabled: false, source: "project" });
      expect(
        resolveStrictPolicy({
          executionPolicy,
          project: { defaultStrict: true },
          thread: { strict: false },
        }),
      ).toMatchObject({ enabled: false, source: "thread" });
    }
  });
  it("retains legacy protection without broadening the level where it applied", () => {
    expect(
      resolveStrictPolicy({
        executionPolicy: "full-access",
        thread: { fullAccessSandbox: true },
        project: { defaultStrict: false },
      }),
    ).toMatchObject({ enabled: true, source: "thread", legacy: true });
    expect(
      resolveStrictPolicy({
        executionPolicy: "approval-gated",
        settings: { defaultFullAccessSandbox: true },
      }),
    ).toMatchObject({ enabled: false });
    expect(
      resolveStrictPolicy({
        executionPolicy: "full-access",
        settings: { defaultFullAccessSandbox: true, defaultStrict: false },
      }),
    ).toMatchObject({ enabled: false, legacy: false });
    expect(
      resolveStrictPolicy({ executionPolicy: "approval-gated", legacyPolicyScope: "project" }),
    ).toMatchObject({ enabled: true, source: "project", legacy: true });
    expect(
      resolveStrictPolicy({
        executionPolicy: "approval-gated",
        legacyPolicyScope: "project",
        thread: { strict: false },
      }),
    ).toMatchObject({ enabled: false });
  });
  it("does not reapply old new-thread sandbox defaults to an existing thread that ran open", () => {
    expect(
      resolveStrictPolicy({
        executionPolicy: "full-access",
        thread: {},
        project: { defaultFullAccessSandbox: true },
        settings: { defaultFullAccessSandbox: true },
      }),
    ).toMatchObject({ enabled: false });
    expect(
      resolveStrictPolicy({
        executionPolicy: "full-access",
        thread: {},
        settings: { defaultStrict: true, defaultFullAccessSandbox: true },
      }),
    ).toMatchObject({ enabled: true, legacy: false, source: "settings" });
    expect(
      resolveStrictPolicy({
        executionPolicy: "full-access",
        thread: { fullAccessSandbox: true },
        settings: { defaultStrict: false },
      }),
    ).toMatchObject({ enabled: true, legacy: true, source: "thread" });
  });

  it("leaves an ordinary unconfigured run outside Strict", () => {
    expect(resolveStrictPolicy({ executionPolicy: "full-access" })).toEqual({
      enabled: false,
      source: "default",
      legacy: false,
    });
  });
});
