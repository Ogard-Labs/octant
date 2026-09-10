import { describe, expect, it, vi } from "vitest";
import {
  formatUnsignedDeveloperPackageSmokeEvidence,
  prepareUnsignedDeveloperPackageSmoke,
} from "./smoke-packaged-desktop";

const commit = "4b94829bd78b86127b8eb1c5befafbca1c95616e";

describe("unsigned developer-package smoke", () => {
  it("refuses to smoke a local unsigned developer package off Apple Silicon", async () => {
    const readHead = vi.fn(async () => commit);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      prepareUnsignedDeveloperPackageSmoke({
        platform: "linux",
        arch: "x64",
        repositoryRoot: "/tmp/octant",
        readHead,
      }),
    ).rejects.toThrow("The packaged desktop smoke requires Apple Silicon macOS.");
    await expect(
      prepareUnsignedDeveloperPackageSmoke({
        platform: "darwin",
        arch: "x64",
        repositoryRoot: "/tmp/octant",
        readHead,
      }),
    ).rejects.toThrow("The packaged desktop smoke requires Apple Silicon macOS.");

    expect(readHead).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("prints the repository HEAD commit when git can resolve it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      prepareUnsignedDeveloperPackageSmoke({
        platform: "darwin",
        arch: "arm64",
        repositoryRoot: "/tmp/octant",
        readHead: async () => `${commit}\n`,
      }),
    ).resolves.toBe(commit);

    expect(log).toHaveBeenCalledWith(`Unsigned developer-package smoke commit: ${commit}`);
    log.mockRestore();
  });

  it("fails closed when git cannot record the smoked commit", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      prepareUnsignedDeveloperPackageSmoke({
        platform: "darwin",
        arch: "arm64",
        repositoryRoot: "/tmp/octant",
        readHead: async () => {
          throw new Error("git: command not found");
        },
      }),
    ).rejects.toThrow("The unsigned developer-package smoke could not record git HEAD.");
    await expect(
      prepareUnsignedDeveloperPackageSmoke({
        platform: "darwin",
        arch: "arm64",
        repositoryRoot: "/tmp/octant",
        readHead: async () => "HEAD",
      }),
    ).rejects.toThrow("The unsigned developer-package smoke could not record git HEAD.");

    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("records launch and clean shutdown as asserted and leaves first-run, provider setup, and thread creation to a maintainer", () => {
    const evidence = formatUnsignedDeveloperPackageSmokeEvidence(commit);

    expect(evidence).toContain(`package commit: asserted ${commit}`);
    expect(evidence).toMatch(/launch: asserted/);
    expect(evidence).toMatch(/clean shutdown: asserted/);
    expect(evidence).toMatch(/first-run: maintainer/);
    expect(evidence).toMatch(/provider setup: maintainer/);
    expect(evidence).toMatch(/thread creation: maintainer/);
    expect(evidence).not.toMatch(
      /first-run: asserted|provider setup: asserted|thread creation: asserted/,
    );
    expect(evidence.toLowerCase()).not.toContain("unsigned technical preview");
  });
});
