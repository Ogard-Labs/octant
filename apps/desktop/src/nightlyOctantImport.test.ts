import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopIdentity } from "@octant/host-runtime";
import type { DesktopHostRole } from "@octant/host-runtime/desktop-identity";
import {
  createNightlyOctantImportControl,
  decodeImportReport,
  LAST_OCTANT_IMPORT_FILE,
  type MaintenanceRun,
} from "./nightlyOctantImport";
import { resolveStartupHostRole } from "./nightlyTestData";

let home: string;
let appData: string;
let storage: string;
let octant: string;
let role: DesktopHostRole;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "octant-nightly-import-")));
  appData = join(home, "Library", "Application Support");
  storage = join(appData, "Octant Nightly");
  octant = join(appData, "Octant");
  await mkdir(storage, { recursive: true });
  await mkdir(octant, { recursive: true });
  await writeFile(join(octant, "octant.sqlite3"), "");
  role = resolveStartupHostRole({
    identity: desktopIdentity("nightly"),
    windowStorageDirectory: storage,
    appDataDirectory: appData,
    platform: "darwin",
    env: {},
  });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const imported = JSON.stringify({
  kind: "imported",
  counts: { events: 12, threads: 3, contentRows: 40, settled: 1 },
  conflicts: [{ mode: "work", octantThreadId: "t" }],
  kept: [{ aggregateType: "settings", aggregateId: "s" }],
});

function control(
  overrides: {
    readonly role?: DesktopHostRole;
    readonly maintenance?: MaintenanceRun;
    readonly stopHost?: () => Promise<void>;
    readonly startHost?: () => Promise<void>;
    readonly env?: Record<string, string>;
  } = {},
) {
  const calls: string[] = [];
  const runMaintenance = vi.fn(async (args: ReadonlyArray<string>) => {
    calls.push("maintenance");
    void args;
    return overrides.maintenance ?? { exitCode: 0, stdout: imported };
  });
  const copyKeys = vi.fn(async () => {
    calls.push("keys");
    return { status: "copied" as const, copied: 2, existing: 1, failed: 0 };
  });
  const copyPreferences = vi.fn(async (input: { readonly overwrite: boolean }) => {
    calls.push("preferences");
    void input;
    return { status: "copied" as const, copied: 4 };
  });
  const reloadOtherWindows = vi.fn((requester: number) => {
    calls.push(`reload:${requester}`);
  });
  const stopHost = vi.fn(
    overrides.stopHost ??
      (async () => {
        calls.push("stop");
      }),
  );
  const startHost = vi.fn(
    overrides.startHost ??
      (async () => {
        calls.push("start");
      }),
  );
  return {
    calls,
    runMaintenance,
    copyKeys,
    copyPreferences,
    reloadOtherWindows,
    stopHost,
    startHost,
    control: createNightlyOctantImportControl({
      role: overrides.role ?? role,
      platform: "darwin",
      appDataDirectory: appData,
      windowStorageDirectory: storage,
      env: overrides.env ?? {},
      now: () => new Date("2026-11-27T10:00:00.000Z"),
      stopHost,
      startHost,
      reloadOtherWindows,
      runMaintenance,
      copyKeys,
      copyPreferences,
    }),
  };
}

describe("Nightly's import from Octant", () => {
  it("refuses unless Nightly runs its own host, without stopping anything", async () => {
    const f = control({ role: { kind: "octant-client" } });
    await expect(f.control.import(false, 1)).resolves.toEqual({
      kind: "refused",
      reason: "not-test-host",
    });
    await expect(f.control.preview()).resolves.toEqual({ octantDataPresent: false });
    expect(f.stopHost).not.toHaveBeenCalled();
    expect(f.runMaintenance).not.toHaveBeenCalled();
  });

  it("takes only a boolean from the renderer and names both folders itself", async () => {
    const f = control();
    await expect(f.control.import("/Users/someone/Other", 1)).rejects.toThrow(TypeError);
    await expect(f.control.import({ from: "/tmp/x" }, 1)).rejects.toThrow(TypeError);
    expect(f.stopHost).not.toHaveBeenCalled();
    await f.control.import(false, 1);
    expect(f.runMaintenance).toHaveBeenCalledWith(["import-octant", "--from", octant]);
  });

  it("refuses when a developer's explicit data folder is set", async () => {
    const f = control({ env: { OCTANT_DATA_DIR: join(home, "elsewhere") } });
    await expect(f.control.import(false, 1)).resolves.toEqual({
      kind: "refused",
      reason: "unsafe-folder",
    });
    expect(f.stopHost).not.toHaveBeenCalled();
  });

  it("refuses when Octant has no data, and offers nothing to preview", async () => {
    await rm(join(octant, "octant.sqlite3"));
    const f = control();
    await expect(f.control.preview()).resolves.toEqual({ octantDataPresent: false });
    await expect(f.control.import(false, 1)).resolves.toEqual({
      kind: "refused",
      reason: "octant-missing",
    });
    expect(f.stopHost).not.toHaveBeenCalled();
  });

  it("stops its host before the import and starts it again after the copies", async () => {
    const f = control();
    const outcome = await f.control.import(true, 7);
    expect(f.calls).toEqual(["stop", "maintenance", "keys", "preferences", "start", "reload:7"]);
    expect(outcome).toEqual({
      kind: "imported",
      counts: { events: 12, threads: 3, contentRows: 40, settled: 1 },
      conflicts: 1,
      heldBack: 1,
      keys: { status: "copied", copied: 2, existing: 1, failed: 0 },
      preferences: { status: "copied", copied: 4 },
    });
  });

  it("copies keys only when asked", async () => {
    const f = control();
    const outcome = await f.control.import(false, 1);
    expect(f.copyKeys).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: "imported", keys: { status: "not-requested" } });
  });

  it("starts its host again when the server refuses, and copies nothing", async () => {
    const f = control({
      maintenance: {
        exitCode: 1,
        stdout: JSON.stringify({ kind: "refused", reason: "octant-newer" }),
      },
    });
    await expect(f.control.import(true, 1)).resolves.toEqual({
      kind: "refused",
      reason: "octant-newer",
    });
    expect(f.calls).toEqual(["stop", "maintenance", "start", "reload:1"]);
    await expect(readFile(join(storage, LAST_OCTANT_IMPORT_FILE))).rejects.toThrow();
  });

  it("reports the stage a failed import stopped at and starts its host again", async () => {
    const f = control({
      maintenance: { exitCode: 1, stdout: JSON.stringify({ kind: "failed", stage: "merge" }) },
    });
    await expect(f.control.import(false, 1)).resolves.toEqual({ kind: "failed", stage: "merge" });
    expect(f.startHost).toHaveBeenCalledOnce();
  });

  it("treats output that is not the server's report as a failed maintenance step", async () => {
    for (const run of [
      { exitCode: 2, stdout: "" },
      { exitCode: null, stdout: "" },
      { exitCode: 0, stdout: "not json" },
      { exitCode: 0, stdout: JSON.stringify({ kind: "imported", counts: {} }) },
      { exitCode: 1, stdout: JSON.stringify({ kind: "refused", reason: "unheard-of" }) },
    ]) {
      expect(decodeImportReport(run)).toEqual({ kind: "failed", stage: "maintenance" });
    }
  });

  it("does not run the import when its host will not stop", async () => {
    const f = control({
      stopHost: async () => {
        throw new Error("separately managed");
      },
    });
    await expect(f.control.import(false, 1)).resolves.toEqual({
      kind: "failed",
      stage: "stop-host",
    });
    expect(f.runMaintenance).not.toHaveBeenCalled();
    expect(f.startHost).not.toHaveBeenCalled();
  });

  it("says its host did not start again without losing the imported data", async () => {
    const f = control({
      startHost: async () => {
        throw new Error("port busy");
      },
    });
    await expect(f.control.import(false, 1)).resolves.toEqual({
      kind: "failed",
      stage: "start-host",
    });
    await expect(f.control.preview()).resolves.toMatchObject({
      lastImportedAt: "2026-11-27T10:00:00.000Z",
    });
  });

  it("records the last import, and a later import never replaces preferences Nightly has", async () => {
    const f = control();
    await expect(f.control.preview()).resolves.toEqual({ octantDataPresent: true });
    await f.control.import(false, 1);
    await expect(f.control.preview()).resolves.toEqual({
      octantDataPresent: true,
      lastImportedAt: "2026-11-27T10:00:00.000Z",
    });
    await f.control.import(false, 1);
    expect(f.copyPreferences.mock.calls.map(([input]) => input.overwrite)).toEqual([true, false]);
  });

  it("allows one import at a time", async () => {
    let release: () => void = () => undefined;
    const f = control({
      stopHost: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const first = f.control.import(false, 1);
    await vi.waitFor(() => expect(f.stopHost).toHaveBeenCalled());
    await expect(f.control.import(false, 2)).resolves.toEqual({ kind: "refused", reason: "busy" });
    release();
    await first;
  });
});
