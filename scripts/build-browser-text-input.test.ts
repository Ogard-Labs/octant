import { mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "darwin")(
  "accepts only the host selection start and exact selected span",
  async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "octant-caret-range-"));
    const executable = resolve(directory, "range-policy");
    const build = spawnSync(
      "xcrun",
      [
        "clang++",
        "-std=c++20",
        "-Wall",
        "-Wextra",
        "-Werror",
        resolve(import.meta.dirname, "../apps/desktop/src/native/browserTextInputRange.test.cpp"),
        "-o",
        executable,
      ],
      { encoding: "utf8", timeout: 20000 },
    );
    expect(build.error).toBeUndefined();
    expect(build.status, build.stderr).toBe(0);
    const result = spawnSync(executable, [], { encoding: "utf8", timeout: 3000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("exact host selection ranges passed");
  },
);
