import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockedHome = vi.hoisted(
  () => `/private/tmp/octant-path-preflight-${process.pid}-${Date.now()}`,
);

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => mockedHome,
}));

import { prepareHostRuntimePaths, resolveHostRuntimePaths } from "./paths";

afterEach(async () => {
  await rm(mockedHome, { recursive: true, force: true });
});

describe.runIf(process.platform === "darwin")("macOS Octant path preflight", () => {
  it("accepts existing state in the canonical directory", async () => {
    const applicationSupport = join(mockedHome, "Library", "Application Support");
    const canonical = join(applicationSupport, "Octant");
    await mkdir(canonical, { recursive: true, mode: 0o700 });
    await writeFile(join(canonical, "octant.sqlite3"), "octant");

    const paths = resolveHostRuntimePaths({
      env: {},
      platform: "darwin",
      home: mockedHome,
      temporaryDirectory: tmpdir(),
      uid: process.getuid?.() ?? 501,
    });

    expect(await readdir(applicationSupport)).toEqual(["Octant"]);
    await expect(prepareHostRuntimePaths(paths)).resolves.toBeUndefined();
    expect(await readdir(applicationSupport)).toEqual(["Octant"]);
    expect(paths.dataDirectory).toBe(canonical);
  });
});
