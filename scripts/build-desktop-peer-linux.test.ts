import { existsSync } from "node:fs";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DESKTOP_PEER_LINUX_SOURCES, desktopPeerLinuxBinding } from "./build-desktop-peer-linux";

const native = resolve(import.meta.dirname, "../apps/desktop/src/native");

describe("the Linux desktop client trust binding", () => {
  it("stages only its own sources and keeps warnings fatal", () => {
    for (const source of DESKTOP_PEER_LINUX_SOURCES)
      expect(existsSync(resolve(native, source))).toBe(true);
    const [target] = desktopPeerLinuxBinding().targets;
    expect(target?.sources).toEqual(["desktopPeerLinux.cc"]);
    expect(target?.cflags_cc).toEqual(expect.arrayContaining(["-std=c++20", "-Werror"]));
  });

  it.skipIf(process.platform !== "linux")(
    "admits a same-user peer and refuses sandboxed, other-user and handed-over peers on a real socket",
    async () => {
      const directory = await mkdtemp(resolve(tmpdir(), "octant-peer-linux-"));
      try {
        // Another user runs this binary in the other-user case.
        await chmod(directory, 0o755);
        const executable = resolve(directory, "peer-linux");
        const build = spawnSync(
          process.env.CXX ?? "c++",
          [
            "-std=c++20",
            "-O1",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-Wno-unused-function",
            resolve(native, "desktopPeerLinux.test.cpp"),
            "-o",
            executable,
          ],
          { encoding: "utf8", timeout: 120_000 },
        );
        expect(build.error).toBeUndefined();
        expect(build.status, build.stderr).toBe(0);
        const result = spawnSync(executable, [], { encoding: "utf8", timeout: 120_000 });
        expect(result.error).toBeUndefined();
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("linux peer policy passed");
        expect(result.stdout).toContain("linux peer socket passed");
        expect(result.stdout).toContain("linux launcher record passed");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    240_000,
  );
});
