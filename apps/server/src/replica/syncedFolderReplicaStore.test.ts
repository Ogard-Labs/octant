import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isInsideHomeDirectory } from "../canvas/artifactMirrorFilePort";
import {
  DATALESS_FLAG,
  SYNCED_FOLDER_REPLICA_DIRECTORY,
  isSyncedFolderWriteTempName,
  openSyncedFolderReplicaStore,
  type OpenSyncedFolderReplicaStoreInput,
} from "./syncedFolderReplicaStore";

const created: string[] = [];

afterEach(() => {
  for (const path of created.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function temporaryDirectory(parent: string): string {
  const directory = mkdtempSync(join(parent, "octant-replica-"));
  created.push(directory);
  return directory;
}

function openFolder(folder: string, overrides: Partial<OpenSyncedFolderReplicaStoreInput> = {}) {
  return openSyncedFolderReplicaStore({
    folder,
    homeDirectory: homedir(),
    outsideHomeApproved: false,
    installed: true,
    enabled: true,
    readFileFlags: async () => 0,
    ...overrides,
  });
}

async function offeredStore(
  folder: string,
  overrides: Partial<OpenSyncedFolderReplicaStoreInput> = {},
) {
  const opened = openFolder(folder, overrides);
  expect(opened.status).toBe("offered");
  if (opened.status !== "offered") throw new Error("Store was not offered.");
  return opened.store;
}

describe("synced folder replica store", () => {
  it("leaves the original bytes unchanged when the key is already present", async () => {
    const folder = temporaryDirectory(homedir());
    const store = await offeredStore(folder);
    const key = "11111111-1111-4111-8111-111111111111/1.json";
    const original = new TextEncoder().encode("original");
    expect(await store.putIfAbsent(key, original)).toEqual({ status: "stored" });

    const replacement = new TextEncoder().encode("replacement");
    expect(await store.putIfAbsent(key, replacement)).toEqual({ status: "already-exists" });

    const onDisk = readFileSync(join(folder, SYNCED_FOLDER_REPLICA_DIRECTORY, key));
    expect(new Uint8Array(onDisk)).toEqual(original);
    expect(await store.get(key)).toEqual({ status: "ready", bytes: original });
  });

  it("does not list a half-written temporary file", async () => {
    const folder = temporaryDirectory(homedir());
    const store = await offeredStore(folder);
    const key = "11111111-1111-4111-8111-111111111111/1.json";
    expect(await store.putIfAbsent(key, new TextEncoder().encode("kept"))).toEqual({
      status: "stored",
    });
    const tempName = ".1.json.octant-write-half.tmp";
    expect(isSyncedFolderWriteTempName(tempName)).toBe(true);
    writeFileSync(
      join(
        folder,
        SYNCED_FOLDER_REPLICA_DIRECTORY,
        "11111111-1111-4111-8111-111111111111",
        tempName,
      ),
      "partial",
    );

    const listed = await store.list();
    expect(listed.status).toBe("ready");
    if (listed.status !== "ready") return;
    expect(listed.entries.map((entry) => entry.key)).toEqual([key]);
    expect(listed.reports).toEqual([]);
    expect(listed.entries.some((entry) => entry.key.endsWith(tempName))).toBe(false);
  });

  it("skips a placeholder or conflict-copy file and reports it", async () => {
    const folder = temporaryDirectory(homedir());
    const instance = "11111111-1111-4111-8111-111111111111";
    const sync = join(folder, SYNCED_FOLDER_REPLICA_DIRECTORY, instance);
    mkdirSync(sync, { recursive: true });
    writeFileSync(join(sync, "1 (conflicted copy 2026-10-04).json"), "conflict");
    writeFileSync(join(sync, "2.sync-conflict-20261004-120000-ABC123.json"), "sync-conflict");
    writeFileSync(join(sync, ".3.json.icloud"), "stub");
    writeFileSync(join(sync, "4.json"), "real");
    const dataless = join(sync, "5.json");
    writeFileSync(dataless, "not-downloaded");

    const store = await offeredStore(folder, {
      readFileFlags: async (path) => (path === dataless ? DATALESS_FLAG : 0),
    });
    const listed = await store.list();
    expect(listed.status).toBe("ready");
    if (listed.status !== "ready") return;
    expect(listed.entries).toEqual([{ key: `${instance}/4.json` }]);
    expect(listed.reports).toEqual([
      { key: `${instance}/.3.json.icloud`, reason: "not-downloaded" },
      { key: `${instance}/1 (conflicted copy 2026-10-04).json`, reason: "conflict-copy" },
      { key: `${instance}/2.sync-conflict-20261004-120000-ABC123.json`, reason: "conflict-copy" },
      { key: `${instance}/5.json`, reason: "not-downloaded" },
    ]);
    expect(await store.get(`${instance}/5.json`)).toEqual({
      status: "refused",
      reason: "not-downloaded",
    });
    expect(await store.get(`${instance}/1 (conflicted copy 2026-10-04).json`)).toEqual({
      status: "refused",
      reason: "conflict-copy",
    });
  });

  it("refuses a folder outside the home directory", async () => {
    const folder = temporaryDirectory(tmpdir());
    expect(isInsideHomeDirectory(folder, homedir())).toBe(false);
    const opened = openFolder(folder);
    expect(opened.status).toBe("offered");
    if (opened.status !== "offered") return;
    expect(await opened.store.status()).toBe("refused");
    expect(await opened.store.putIfAbsent("instance/1.json", new Uint8Array([1]))).toEqual({
      status: "refused",
      reason: "outside-home",
    });
    expect(await opened.store.list()).toEqual({ status: "refused", reason: "outside-home" });
    expect(existsSync(join(folder, SYNCED_FOLDER_REPLICA_DIRECTORY))).toBe(false);
  });

  it("stores outside the home directory only when that access is approved", async () => {
    const folder = temporaryDirectory(tmpdir());
    expect(isInsideHomeDirectory(folder, homedir())).toBe(false);
    const store = await offeredStore(folder, { outsideHomeApproved: true });
    const key = "11111111-1111-4111-8111-111111111111/1.json";
    const bytes = new TextEncoder().encode("approved");
    expect(await store.putIfAbsent(key, bytes)).toEqual({ status: "stored" });
    expect(readFileSync(join(folder, SYNCED_FOLDER_REPLICA_DIRECTORY, key))).toEqual(
      Buffer.from(bytes),
    );
  });

  it("refuses a folder inside the home directory whose target is outside it", async () => {
    const outside = temporaryDirectory(tmpdir());
    const inside = temporaryDirectory(homedir());
    const link = join(inside, "linked");
    symlinkSync(outside, link);
    const opened = openFolder(link);
    expect(opened.status).toBe("offered");
    if (opened.status !== "offered") return;
    expect(await opened.store.status()).toBe("refused");
    expect(await opened.store.putIfAbsent("instance/1.json", new Uint8Array([1]))).toEqual({
      status: "refused",
      reason: "outside-home",
    });
    expect(existsSync(join(outside, SYNCED_FOLDER_REPLICA_DIRECTORY))).toBe(false);
  });

  it("refuses a key that would leave the sync directory", async () => {
    const folder = temporaryDirectory(homedir());
    const store = await offeredStore(folder);
    expect(await store.putIfAbsent("../escaped.txt", new TextEncoder().encode("no"))).toEqual({
      status: "refused",
      reason: "key-refused",
    });
    expect(await store.putIfAbsent("id/../../escaped.txt", new Uint8Array([1]))).toEqual({
      status: "refused",
      reason: "key-refused",
    });
    expect(existsSync(join(folder, "escaped.txt"))).toBe(false);
  });

  it("refuses a get whose parent directory is a symlink out of the folder", async () => {
    const folder = temporaryDirectory(homedir());
    const outside = temporaryDirectory(homedir());
    mkdirSync(join(folder, SYNCED_FOLDER_REPLICA_DIRECTORY));
    symlinkSync(outside, join(folder, SYNCED_FOLDER_REPLICA_DIRECTORY, "id"));
    writeFileSync(join(outside, "1.json"), "secret");
    const store = await offeredStore(folder);
    expect(await store.get("id/1.json")).toEqual({ status: "refused", reason: "key-refused" });
  });

  it("refuses a get whose key is a symlink, even to bytes inside the folder", async () => {
    const folder = temporaryDirectory(homedir());
    const store = await offeredStore(folder);
    const instance = "11111111-1111-4111-8111-111111111111";
    const sync = join(folder, SYNCED_FOLDER_REPLICA_DIRECTORY, instance);
    mkdirSync(sync, { recursive: true });
    writeFileSync(join(sync, "real.json"), "real");
    symlinkSync(join(sync, "real.json"), join(sync, "1.json"));
    expect(await store.get(`${instance}/1.json`)).toEqual({
      status: "refused",
      reason: "key-refused",
    });
    expect(await store.get(`${instance}/real.json`)).toEqual({
      status: "ready",
      bytes: new TextEncoder().encode("real"),
    });
  });

  it("refuses a get when a sync client swaps the file for a symlink outside the folder", async () => {
    const folder = temporaryDirectory(homedir());
    const outside = temporaryDirectory(homedir());
    writeFileSync(join(outside, "stolen.json"), "outside-bytes");
    const store = await offeredStore(folder);
    const key = "11111111-1111-4111-8111-111111111111/1.json";
    expect(await store.putIfAbsent(key, new TextEncoder().encode("kept"))).toEqual({
      status: "stored",
    });
    const destination = join(folder, SYNCED_FOLDER_REPLICA_DIRECTORY, key);
    rmSync(destination);
    symlinkSync(join(outside, "stolen.json"), destination);
    expect(await store.get(key)).toEqual({ status: "refused", reason: "key-refused" });
  });

  it("refuses a publish whose parent directory was swapped for a symlink out of the folder", async () => {
    const folder = temporaryDirectory(homedir());
    const outside = temporaryDirectory(homedir());
    const store = await offeredStore(folder);
    const key = "11111111-1111-4111-8111-111111111111/1.json";
    expect(await store.putIfAbsent(key, new TextEncoder().encode("kept"))).toEqual({
      status: "stored",
    });
    const instance = "11111111-1111-4111-8111-111111111111";
    const sync = join(folder, SYNCED_FOLDER_REPLICA_DIRECTORY);
    rmSync(join(sync, instance), { recursive: true });
    mkdirSync(join(outside, instance));
    writeFileSync(join(outside, instance, "1.json"), "old");
    symlinkSync(join(outside, instance), join(sync, instance));
    expect(await store.putIfAbsent(key, new TextEncoder().encode("no"))).toEqual({
      status: "refused",
      reason: "key-refused",
    });
    expect(readFileSync(join(outside, instance, "1.json"), "utf8")).toBe("old");
    expect(readdirSync(join(outside, instance))).toEqual(["1.json"]);
    expect(readlinkSync(join(sync, instance))).toBe(join(outside, instance));
  });

  it("refuses a publish whose key name is a symlink instead of reporting it as taken", async () => {
    const folder = temporaryDirectory(homedir());
    const outside = temporaryDirectory(homedir());
    writeFileSync(join(outside, "victim.json"), "victim");
    const store = await offeredStore(folder);
    const key = "11111111-1111-4111-8111-111111111111/1.json";
    const sync = join(folder, SYNCED_FOLDER_REPLICA_DIRECTORY);
    mkdirSync(join(sync, "11111111-1111-4111-8111-111111111111"), { recursive: true });
    symlinkSync(join(outside, "victim.json"), join(sync, key));
    expect(await store.putIfAbsent(key, new TextEncoder().encode("no"))).toEqual({
      status: "refused",
      reason: "key-refused",
    });
    expect(readFileSync(join(outside, "victim.json"), "utf8")).toBe("victim");
    expect(readlinkSync(join(sync, key))).toBe(join(outside, "victim.json"));
  });

  it("refuses a write through a key-directory symlink that stays inside the folder", async () => {
    const folder = temporaryDirectory(homedir());
    const store = await offeredStore(folder);
    const instance = "11111111-1111-4111-8111-111111111111";
    expect(await store.putIfAbsent(`${instance}/1.json`, new TextEncoder().encode("kept"))).toEqual(
      { status: "stored" },
    );
    symlinkSync(
      join(folder, SYNCED_FOLDER_REPLICA_DIRECTORY, instance),
      join(folder, SYNCED_FOLDER_REPLICA_DIRECTORY, "alias"),
    );
    expect(await store.putIfAbsent("alias/2.json", new TextEncoder().encode("no"))).toEqual({
      status: "refused",
      reason: "key-refused",
    });
    expect(existsSync(join(folder, SYNCED_FOLDER_REPLICA_DIRECTORY, instance, "2.json"))).toBe(
      false,
    );
    expect(await store.putIfAbsent(`${instance}/2.json`, new TextEncoder().encode("kept"))).toEqual(
      { status: "stored" },
    );
  });

  it("does not create directories through an intermediate symlink out of the folder", async () => {
    const folder = temporaryDirectory(homedir());
    const outside = temporaryDirectory(homedir());
    mkdirSync(join(folder, SYNCED_FOLDER_REPLICA_DIRECTORY));
    symlinkSync(outside, join(folder, SYNCED_FOLDER_REPLICA_DIRECTORY, "escape"));
    const store = await offeredStore(folder);
    expect(await store.putIfAbsent("escape/nested/1.json", new TextEncoder().encode("no"))).toEqual(
      { status: "refused", reason: "key-refused" },
    );
    expect(existsSync(join(outside, "nested"))).toBe(false);
  });

  it("does not offer or call a disabled or uninstalled store", async () => {
    const folder = temporaryDirectory(homedir());
    expect(openFolder(folder, { installed: false })).toEqual({
      status: "withheld",
      reason: "not-installed",
    });
    expect(openFolder(folder, { enabled: false })).toEqual({
      status: "withheld",
      reason: "disabled",
    });
    expect(existsSync(join(folder, SYNCED_FOLDER_REPLICA_DIRECTORY))).toBe(false);
  });

  it("continues a listing after the cursor", async () => {
    const folder = temporaryDirectory(homedir());
    const store = await offeredStore(folder, { pageSize: 1 });
    expect(await store.putIfAbsent("a/1.json", new Uint8Array([1]))).toEqual({ status: "stored" });
    expect(await store.putIfAbsent("b/1.json", new Uint8Array([2]))).toEqual({ status: "stored" });
    const first = await store.list();
    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;
    expect(first.entries).toEqual([{ key: "a/1.json" }]);
    expect(first.nextCursor).toBe("a/1.json");
    const second = await store.list(first.nextCursor);
    expect(second).toEqual({
      status: "ready",
      entries: [{ key: "b/1.json" }],
      reports: [],
    });
  });
});
