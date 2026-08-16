import { describe, expect, it, vi } from "vitest";
import {
  acceptExpectedForcedFailure,
  combinePackagedCodeSmokeFailures,
  runPackagedCodeSmoke,
} from "./smoke-packaged-code";

describe("packaged Code smoke orchestration", () => {
  it("runs package inspection, deterministic Code lifecycle, and success/failure cleanup", async () => {
    const run = vi.fn(async () => undefined);
    await runPackagedCodeSmoke(run);
    expect(run.mock.calls.map(([step]) => step)).toEqual([
      "package",
      "code-lifecycle",
      "authenticated-web-authority",
      "packaged-success-cleanup",
      "packaged-failure-cleanup",
    ]);
  });

  it("stops after the first failed step and returns a sanitized phase", async () => {
    const run = vi.fn(async (step: string) => {
      if (step === "code-lifecycle") throw new Error("secret checkout path");
    });
    await expect(runPackagedCodeSmoke(run)).rejects.toThrow(
      "Packaged Code smoke failed during code-lifecycle.",
    );
    expect(JSON.stringify(await runPackagedCodeSmoke(run).catch((error) => error))).not.toContain(
      "secret checkout path",
    );
  });

  it("preserves primary and cleanup failure categories without raw diagnostics", () => {
    const failure = combinePackagedCodeSmokeFailures(
      new Error("private repository"),
      new Error("private process listing"),
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect(String(failure)).toContain("workflow and cleanup");
    expect(JSON.stringify(failure, errorProperties)).not.toMatch(
      /private repository|process listing/,
    );
  });

  it("accepts only the packaged smoke's intentional post-cleanup failure", () => {
    expect(() =>
      acceptExpectedForcedFailure(
        new Error("command failed: Intentional packaged smoke failure after readiness."),
      ),
    ).not.toThrow();
    expect(() => acceptExpectedForcedFailure(new Error("process remained alive"))).toThrow(
      "forced-failure cleanup did not reach",
    );
    expect(() => acceptExpectedForcedFailure(undefined)).toThrow(
      "forced-failure cleanup did not reach",
    );
  });
});

function errorProperties(_key: string, value: unknown): unknown {
  if (value instanceof AggregateError) return { message: value.message, errors: value.errors };
  if (value instanceof Error) return { message: value.message };
  return value;
}
