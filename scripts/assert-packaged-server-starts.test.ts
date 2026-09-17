import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  assertPackagedServerStarts,
  packagedServerBundle,
  packagedServerEntry,
  packagedServerExecutable,
} from "./assert-packaged-server-starts";

describe("assertPackagedServerStarts", () => {
  it("refuses hosts that are not Apple Silicon macOS", async () => {
    await expect(
      assertPackagedServerStarts({
        platform: "linux",
        arch: "x64",
        repositoryRoot: "/repo",
      }),
    ).rejects.toThrow(/Apple Silicon macOS/);
  });

  it("refuses a missing packaged app", async () => {
    await expect(
      assertPackagedServerStarts({
        platform: "darwin",
        arch: "arm64",
        repositoryRoot: "/tmp/octant-no-such-checkout",
      }),
    ).rejects.toThrow(/Octant\.app is missing/);
  });

  it("names the staged bundle, executable, and server entry under the app", () => {
    const bundle = packagedServerBundle("/repo");
    expect(bundle).toBe(resolve("/repo/out/Octant.app"));
    expect(packagedServerExecutable(bundle)).toBe(
      resolve("/repo/out/Octant.app/Contents/MacOS/Octant"),
    );
    expect(packagedServerEntry(bundle)).toBe(
      resolve("/repo/out/Octant.app/Contents/Resources/app/apps/server/dist/main.mjs"),
    );
  });
});
