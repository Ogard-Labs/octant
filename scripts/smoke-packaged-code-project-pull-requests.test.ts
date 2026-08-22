import { describe, expect, it, vi } from "vitest";
import {
  darwinPackageUnavailableReason,
  runPackagedCodeProjectPullRequestSmoke,
} from "./smoke-packaged-code-project-pull-requests";

describe("packaged Code project pull-request smoke orchestration", () => {
  it("records that the Darwin package step is unavailable off Apple Silicon", () => {
    expect(darwinPackageUnavailableReason("linux", "x64")).toBe(
      "The Darwin package step is unavailable on this host.",
    );
    expect(darwinPackageUnavailableReason("darwin", "arm64")).toBeUndefined();
  });

  it("runs package inspection then the fake-gh port proof", async () => {
    const run = vi.fn(async () => undefined);
    await runPackagedCodeProjectPullRequestSmoke(run);
    expect(run.mock.calls.map(([step]) => step)).toEqual(["package", "fake-gh-port"]);
  });

  it("stops after the first failed step without leaking host diagnostics", async () => {
    const run = vi.fn(async (step: string) => {
      if (step === "package") throw new Error("secret checkout path");
    });
    await expect(runPackagedCodeProjectPullRequestSmoke(run)).rejects.toThrow(
      "Packaged Code project pull-request smoke failed during package.",
    );
    expect(
      JSON.stringify(await runPackagedCodeProjectPullRequestSmoke(run).catch((error) => error)),
    ).not.toContain("secret checkout path");
  });
});
