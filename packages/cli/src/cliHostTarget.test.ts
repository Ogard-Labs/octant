import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { desktopIdentity } from "@octant/host-runtime";
import { hostNotRunningMessage, resolveCliHostTarget } from "./cliHostTarget";

const nightly = desktopIdentity("nightly");
const home = "/Users/person";
const choiceFolder = join(home, "Library", "Application Support", "Octant Nightly");
const testData = join(choiceFolder, "Test Data");

function target(
  choice: "octant" | "test-data",
  env: Readonly<Record<string, string | undefined>> = {},
  platform: NodeJS.Platform = "darwin",
) {
  const folders: string[] = [];
  const resolved = resolveCliHostTarget(nightly, {
    platform,
    home,
    env,
    readDataChoice: (folder) => {
      folders.push(folder);
      return choice;
    },
  });
  return { resolved, folders };
}

describe("which host octant-nightly attaches to", () => {
  it("attaches to Octant's host when Octant's data is chosen, with the environment unchanged", () => {
    const { resolved, folders } = target("octant", { PATH: "/usr/bin" });

    expect(resolved).toEqual({ kind: "octant-host", environment: { PATH: "/usr/bin" } });
    expect(folders).toEqual([choiceFolder]);
  });

  it("attaches to Nightly's test host on its folder and port 13774 when the Data choice is test data", () => {
    expect(target("test-data", { PATH: "/usr/bin" }).resolved).toEqual({
      kind: "test-host",
      serverPort: 13_774,
      environment: {
        PATH: "/usr/bin",
        OCTANT_DATA_DIR: testData,
        OCTANT_SERVER_PORT: "13774",
        OCTANT_LOGS_DIR: join(home, "Library", "Logs", "Octant Nightly"),
      },
    });
  });

  it("follows OCTANT_DATA_DIR as octant does, without reading the Data choice", () => {
    const { resolved, folders } = target("test-data", { OCTANT_DATA_DIR: "/tmp/dev-data" });

    expect(resolved).toEqual({
      kind: "octant-host",
      environment: { OCTANT_DATA_DIR: "/tmp/dev-data" },
    });
    expect(folders).toEqual([]);
  });

  it("keeps an OCTANT_SERVER_PORT override for the test host", () => {
    expect(target("test-data", { OCTANT_SERVER_PORT: "14000" }).resolved).toMatchObject({
      kind: "test-host",
      serverPort: 14_000,
      environment: { OCTANT_DATA_DIR: testData, OCTANT_SERVER_PORT: "14000" },
    });
  });

  it("attaches to Nightly's own host on Linux on its XDG folder and log folder", () => {
    expect(
      target("test-data", { XDG_DATA_HOME: "/xdg/data", XDG_STATE_HOME: "/xdg/state" }, "linux")
        .resolved,
    ).toMatchObject({
      kind: "test-host",
      serverPort: 13_774,
      environment: {
        OCTANT_DATA_DIR: "/xdg/data/octant-nightly/test-data",
        OCTANT_LOGS_DIR: "/xdg/state/octant-nightly/logs",
      },
    });
  });

  it("refuses where Nightly has no host of its own", () => {
    expect(target("test-data", {}, "win32").resolved).toMatchObject({ kind: "refused" });
  });

  it("treats a Data choice that cannot be read as Nightly's own data", () => {
    const resolved = resolveCliHostTarget(nightly, {
      platform: "darwin",
      home,
      env: {},
      readDataChoice: () => {
        throw new Error("EACCES");
      },
    });

    expect(resolved).toMatchObject({ kind: "test-host", serverPort: 13_774 });
  });

  it("reads the same data-choice.json rule as the desktop: only an exact regular file selects Octant's data", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "octant-nightly-choice-"));
    try {
      const folder = join(root, "Library", "Application Support", "Octant Nightly");
      await mkdir(folder, { recursive: true });
      const at = () => resolveCliHostTarget(nightly, { platform: "darwin", home: root, env: {} });

      expect(at()).toMatchObject({
        kind: "test-host",
        environment: {
          OCTANT_DATA_DIR: join(folder, "Test Data"),
        },
      });
      await writeFile(join(folder, "data-choice.json"), '{"data":"octant","extra":1}');
      expect(at().kind).toBe("test-host");
      await writeFile(join(root, "elsewhere.json"), '{"data":"octant"}');
      await rm(join(folder, "data-choice.json"));
      await symlink(join(root, "elsewhere.json"), join(folder, "data-choice.json"));
      expect(at().kind).toBe("test-host");
      await rm(join(folder, "data-choice.json"));
      await writeFile(join(folder, "data-choice.json"), '{"data":"octant"}\n');
      expect(at().kind).toBe("octant-host");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets octant own and start its host, as before", () => {
    expect(
      resolveCliHostTarget(desktopIdentity("stable"), {
        platform: "darwin",
        home,
        env: { PATH: "/usr/bin" },
        readDataChoice: () => "test-data",
      }),
    ).toEqual({ kind: "own-host", environment: { PATH: "/usr/bin" } });
  });

  it("names how to start the host it attaches to instead of starting one", () => {
    expect(hostNotRunningMessage(nightly, target("octant").resolved)).toBe(
      "Octant is not running on this host. Open Octant, or start its host with `octant server start`; octant-nightly never starts a host on Octant's data.",
    );
    expect(hostNotRunningMessage(nightly, target("test-data").resolved)).toBe(
      "Octant Nightly's own host is not running. Open Octant Nightly to start it; octant-nightly never starts a host.",
    );
  });
});
