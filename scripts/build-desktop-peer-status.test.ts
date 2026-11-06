import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Each case compiles native code, which already allows 20 s; the default 5 s
// test timeout cut that off on loaded macOS runners.
describe("the main-process desktop status binding", { timeout: 60_000 }, () => {
  it.skipIf(process.platform !== "darwin")(
    "refuses unsafe or malformed fuse artifacts before native peer admission",
    async () => {
      const directory = await mkdtemp(resolve(tmpdir(), "octant-peer-policy-"));
      try {
        const executable = resolve(directory, "policy");
        const source = resolve(
          import.meta.dirname,
          "../apps/desktop/src/native/desktopPeerPolicy.test.cpp",
        );
        const build = spawnSync(
          "xcrun",
          ["clang++", "-std=c++20", "-Wall", "-Wextra", "-Werror", source, "-o", executable],
          { encoding: "utf8", timeout: 20_000 },
        );
        expect(build.error).toBeUndefined();
        expect(build.status, build.stderr).toBe(0);
        const result = spawnSync(executable, [], { encoding: "utf8", timeout: 3_000 });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("bounded fuse policy passed");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it.skipIf(process.platform !== "darwin")(
    "refuses closed while an OS launch is outstanding and settles a late completion once",
    async () => {
      const directory = await mkdtemp(resolve(tmpdir(), "octant-peer-launch-"));
      try {
        const executable = resolve(directory, "launch-cleanup");
        const build = spawnSync(
          "xcrun",
          [
            "clang++",
            "-x",
            "objective-c++",
            "-std=c++20",
            "-fblocks",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-Wno-unused-function",
            "-Wno-deprecated-declarations",
            resolve(import.meta.dirname, "../apps/desktop/src/native/desktopPeerLaunch.test.cpp"),
            "-framework",
            "Security",
            "-framework",
            "CoreFoundation",
            "-framework",
            "AppKit",
            "-lbsm",
            "-o",
            executable,
          ],
          { encoding: "utf8", timeout: 20_000 },
        );
        expect(build.error).toBeUndefined();
        expect(build.status, build.stderr).toBe(0);
        const result = spawnSync(executable, [], { encoding: "utf8", timeout: 3_000 });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("pending launch cleanup passed");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
