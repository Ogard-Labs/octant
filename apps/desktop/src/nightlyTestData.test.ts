import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopIdentity } from "@octant/host-runtime";
import {
  readStoredDesktopDataChoice,
  createNightlyDataControl,
  createRelaunchIntent,
  resolveHostOwningStartup,
  removeNightlyTestData,
  resolveStartupHostRole,
  storeDesktopDataChoice,
} from "./nightlyTestData";

const nightly = desktopIdentity("nightly");
const stable = desktopIdentity("stable");

let home: string;
let appData: string;
let storage: string;
let testData: string;

beforeEach(async () => {
  // Real path: removal compares the test folder with its real path.
  home = await realpath(await mkdtemp(join(tmpdir(), "octant-nightly-test-data-")));
  appData = join(home, "Library", "Application Support");
  storage = join(appData, "Octant Nightly");
  testData = join(storage, "Test Data");
  await mkdir(storage, { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function startupRole(identity = nightly) {
  return resolveStartupHostRole({
    identity,
    windowStorageDirectory: storage,
    appDataDirectory: appData,
    platform: "darwin",
    env: {},
  });
}

describe("Nightly's stored Data choice", () => {
  it("connects to Octant's host until separate test data is chosen", async () => {
    expect(startupRole()).toEqual({ kind: "octant-client" });
    await storeDesktopDataChoice(storage, "test-data");
    expect(readStoredDesktopDataChoice(storage)).toBe("test-data");
    expect(startupRole()).toEqual({
      kind: "test-host",
      dataDirectory: testData,
      serverPort: 13_774,
      keychainServiceFamily: "octant-nightly-test-data",
    });
    await storeDesktopDataChoice(storage, "octant");
    expect(startupRole()).toEqual({ kind: "octant-client" });
  });

  it("reads a malformed, oversized or linked choice as Octant's data", async () => {
    const file = join(storage, "data-choice.json");
    await writeFile(file, "{not json");
    expect(startupRole()).toEqual({ kind: "octant-client" });
    await writeFile(file, `{"data":"test-data"}${" ".repeat(2_000)}`);
    expect(startupRole()).toEqual({ kind: "octant-client" });
    await rm(file);
    const elsewhere = join(home, "elsewhere.json");
    await writeFile(elsewhere, '{"data":"test-data"}');
    await symlink(elsewhere, file);
    expect(startupRole()).toEqual({ kind: "octant-client" });
  });

  it("reads a FIFO in place of the choice as Octant's data without waiting on it", () => {
    execFileSync("/usr/bin/mkfifo", [join(storage, "data-choice.json")]);
    expect(startupRole()).toEqual({ kind: "octant-client" });
  });

  it("leaves Octant the owner of its host whatever Nightly's storage says", async () => {
    await storeDesktopDataChoice(storage, "test-data");
    expect(startupRole(stable)).toEqual({ kind: "octant-host" });
  });
});

describe("what the host-owning desktop may start", () => {
  const testHost = (dataDirectory: string) => ({
    kind: "test-host" as const,
    dataDirectory,
    serverPort: 13_774,
    keychainServiceFamily: "octant-nightly-test-data" as const,
  });
  function startup(
    role: Parameters<typeof resolveHostOwningStartup>[0]["role"],
    overrides: {
      identity?: typeof nightly;
      platform?: NodeJS.Platform;
      env?: Record<string, string>;
    } = {},
  ) {
    return resolveHostOwningStartup({
      identity: overrides.identity ?? nightly,
      role,
      platform: overrides.platform ?? "darwin",
      appDataDirectory: appData,
      env: overrides.env ?? {},
    });
  }

  it("never falls back to Octant's folder or port when Nightly has no test-host role", () => {
    expect(startup({ kind: "octant-client" })).toEqual({
      kind: "refused",
      message: expect.stringMatching(/^Octant Nightly refused to start a host/),
    });
    expect(startup({ kind: "octant-host" })).toMatchObject({ kind: "refused" });
  });

  it("starts the test host on its own folder, port, logs and Keychain services", () => {
    expect(startup(testHost(testData))).toEqual({
      kind: "start",
      configuredDataDirectory: testData,
      serverPort: 13_774,
      logsDirectory: join(home, "Library", "Logs", "Octant Nightly"),
      keychainServiceFamily: "octant-nightly-test-data",
      hostEnvironment: {
        OCTANT_LOGS_DIR: join(home, "Library", "Logs", "Octant Nightly"),
        OCTANT_KEYCHAIN_SERVICE_FAMILY: "octant-nightly-test-data",
        OCTANT_DEFAULT_FOLDER: join(home, "Octant Nightly"),
      },
    });
  });

  it("keeps Octant on its own defaults", () => {
    expect(startup({ kind: "octant-host" }, { identity: stable })).toEqual({
      kind: "start",
      configuredDataDirectory: undefined,
      serverPort: undefined,
      logsDirectory: undefined,
      keychainServiceFamily: "octant",
      hostEnvironment: {},
    });
  });

  it("refuses the test host on Linux, where credentials would be shared", () => {
    expect(
      startup(testHost("/home/test/.local/share/octant-nightly/test-data"), { platform: "linux" }),
    ).toEqual({
      kind: "refused",
      message: expect.stringContaining("macOS only"),
    });
  });

  it("refuses a test folder that overlaps Octant's unless the data folder was set explicitly", () => {
    const inside = join(appData, "Octant", "Test Data");
    expect(startup(testHost(inside))).toEqual({
      kind: "refused",
      message: expect.stringContaining("overlaps Octant's data folder"),
    });
    expect(startup(testHost(inside), { env: { OCTANT_DATA_DIR: inside } })).toMatchObject({
      kind: "start",
      configuredDataDirectory: inside,
    });
  });
});

describe("removing Nightly's test data", () => {
  function remove(role: Parameters<typeof removeNightlyTestData>[0]["role"], identity = nightly) {
    const trashItem = vi.fn(async (_path: string) => undefined);
    return {
      trashItem,
      result: removeNightlyTestData({
        role,
        identity,
        platform: "darwin",
        appDataDirectory: appData,
        env: {},
        trashItem,
      }),
    };
  }

  it("moves only Nightly's fixed test folder to the Trash while the test host is stopped", async () => {
    await mkdir(testData);
    const { trashItem, result } = remove({ kind: "octant-client" });
    await expect(result).resolves.toEqual({ kind: "removed" });
    expect(trashItem).toHaveBeenCalledExactlyOnceWith(testData);
  });

  it("refuses while the test host runs on that folder", async () => {
    await mkdir(testData);
    const { trashItem, result } = remove({
      kind: "test-host",
      dataDirectory: testData,
      serverPort: 13_774,
      keychainServiceFamily: "octant-nightly-test-data",
    });
    await expect(result).resolves.toEqual({ kind: "refused", reason: "test-host-running" });
    expect(trashItem).not.toHaveBeenCalled();
  });

  it("refuses in Octant, and refuses a linked test folder", async () => {
    await expect(remove({ kind: "octant-host" }, stable).result).resolves.toEqual({
      kind: "refused",
      reason: "not-nightly",
    });
    const octant = join(appData, "Octant");
    await mkdir(octant, { recursive: true });
    await symlink(octant, testData);
    const { trashItem, result } = remove({ kind: "octant-client" });
    await expect(result).resolves.toEqual({ kind: "refused", reason: "unsafe-folder" });
    expect(trashItem).not.toHaveBeenCalled();
  });

  it("refuses a test folder reached through a linked parent", async () => {
    const elsewhere = join(home, "elsewhere");
    await mkdir(join(elsewhere, "Test Data"), { recursive: true });
    await rm(storage, { recursive: true });
    await symlink(elsewhere, storage);
    const { trashItem, result } = remove({ kind: "octant-client" });
    await expect(result).resolves.toEqual({ kind: "refused", reason: "unsafe-folder" });
    expect(trashItem).not.toHaveBeenCalled();
  });

  it("refuses while a live host owns the test folder, and removes it once that owner is gone", async () => {
    await mkdir(join(testData, "run"), { recursive: true });
    const receipt = (pid: number) =>
      JSON.stringify({
        schemaVersion: 1,
        hostId: "00000000-0000-4000-8000-000000000001",
        instanceId: "00000000-0000-4000-8000-000000000002",
        endpoint: "/private/tmp/octant-501/fixture.sock",
        pid,
        processStart: "fixture",
        serverVersion: "0.1.0",
        wireVersion: "1",
        serviceMode: "desktop",
        nonceDigest: "a".repeat(64),
        createdAt: "2026-11-06T00:00:00.000Z",
      });
    await writeFile(join(testData, "run", "owner.json"), receipt(process.pid));
    const live = remove({ kind: "octant-client" });
    await expect(live.result).resolves.toEqual({ kind: "refused", reason: "test-host-running" });
    expect(live.trashItem).not.toHaveBeenCalled();
    // A pid no running process has.
    await writeFile(join(testData, "run", "owner.json"), receipt(2_147_483_646));
    const gone = remove({ kind: "octant-client" });
    await expect(gone.result).resolves.toEqual({ kind: "removed" });
  });

  it("reports nothing to remove when there is no test data", async () => {
    await expect(remove({ kind: "octant-client" }).result).resolves.toEqual({ kind: "absent" });
  });
});

describe("Nightly's Data control", () => {
  function control(role: Parameters<typeof createNightlyDataControl>[0]["role"]) {
    const relaunch = vi.fn();
    const trashItem = vi.fn(async (_path: string) => undefined);
    return {
      relaunch,
      trashItem,
      data: createNightlyDataControl({
        identity: nightly,
        role,
        platform: "darwin",
        appDataDirectory: appData,
        windowStorageDirectory: storage,
        env: {},
        trashItem,
        requestRelaunch: relaunch,
      }),
    };
  }

  it("stores only the two fixed choices and relaunches only when the choice changed", async () => {
    const { data, relaunch } = control({ kind: "octant-client" });
    await expect(data.state()).resolves.toEqual({
      running: "octant",
      chosen: "octant",
      testDataPresent: false,
    });
    expect(data.relaunch()).toEqual({ kind: "unchanged" });
    await expect(data.choose("/Users/test/Library/Application Support/Octant")).rejects.toThrow();
    await expect(data.choose("test-data")).resolves.toMatchObject({ chosen: "test-data" });
    expect(data.relaunch()).toEqual({ kind: "relaunching" });
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("reports a refused removal while the test host runs", async () => {
    await mkdir(testData);
    const { data, trashItem } = control({
      kind: "test-host",
      dataDirectory: testData,
      serverPort: 13_774,
      keychainServiceFamily: "octant-nightly-test-data",
    });
    await expect(data.remove()).resolves.toMatchObject({
      running: "test-data",
      testDataPresent: true,
      removal: "test-host-running",
    });
    expect(trashItem).not.toHaveBeenCalled();
  });
});

describe("a relaunch asked for from Settings", () => {
  it("relaunches only when its quit is accepted, and a cancelled quit forgets it", () => {
    const quit = vi.fn();
    const relaunch = vi.fn();
    const intent = createRelaunchIntent({ quit, relaunch });
    intent.request();
    expect(quit).toHaveBeenCalledOnce();
    expect(relaunch).not.toHaveBeenCalled();
    intent.quitCancelled();
    intent.quitAccepted();
    expect(relaunch).not.toHaveBeenCalled();
    intent.request();
    intent.quitAccepted();
    expect(relaunch).toHaveBeenCalledOnce();
    intent.quitAccepted();
    expect(relaunch).toHaveBeenCalledOnce();
  });
});
