import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { desktopIdentity } from "@octant/host-runtime";
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

  it("selects Nightly's bundle and executable without falling back to an installed stable app", () => {
    const identity = desktopIdentity("nightly");
    const bundle = packagedServerBundle("/repo", identity);
    expect(bundle).toBe(resolve("/repo/out/Octant Nightly.app"));
    expect(packagedServerExecutable(bundle, identity)).toBe(
      resolve("/repo/out/Octant Nightly.app/Contents/MacOS/Octant Nightly"),
    );
  });
});
