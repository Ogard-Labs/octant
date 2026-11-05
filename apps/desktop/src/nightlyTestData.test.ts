import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopIdentity } from "@octant/host-runtime";
import {
  readStoredDesktopDataChoice,
  refuseTestDataInsideOctantData,
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
  home = await mkdtemp(join(tmpdir(), "octant-nightly-test-data-"));
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

  it("leaves Octant the owner of its host whatever Nightly's storage says", async () => {
    await storeDesktopDataChoice(storage, "test-data");
    expect(startupRole(stable)).toEqual({ kind: "octant-host" });
  });

  it("refuses a test folder that overlaps Octant's unless the data folder was set explicitly", () => {
    const role = {
      kind: "test-host" as const,
      dataDirectory: join(appData, "Octant", "Test Data"),
      serverPort: 13_774,
      keychainServiceFamily: "octant-nightly-test-data" as const,
    };
    const octantDataDirectory = join(appData, "Octant");
    expect(
      refuseTestDataInsideOctantData({
        role,
        octantDataDirectory,
        explicitDataDirectory: undefined,
      }),
    ).toMatchObject({ kind: "refused" });
    expect(
      refuseTestDataInsideOctantData({
        role,
        octantDataDirectory,
        explicitDataDirectory: role.dataDirectory,
      }),
    ).toEqual({ kind: "apart" });
    expect(
      refuseTestDataInsideOctantData({
        role: { ...role, dataDirectory: testData },
        octantDataDirectory,
        explicitDataDirectory: undefined,
      }),
    ).toEqual({ kind: "apart" });
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
        octantDataDirectory: join(appData, "Octant"),
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

  it("reports nothing to remove when there is no test data", async () => {
    await expect(remove({ kind: "octant-client" }).result).resolves.toEqual({ kind: "absent" });
  });
});
