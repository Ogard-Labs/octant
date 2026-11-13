import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOST_CRASH_RECORD_LIMIT,
  hostCrashRecordsDirectory,
  keepUncleanStopCrashRecord,
  readHostCrashRecords,
  recordHostCrash,
} from "./crashRecords";

async function dataDirectory(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "octant-crash-records-"));
}

describe("host crash records", () => {
  it("keeps an owner-only record with the home folder as ~ and secrets removed", async () => {
    const data = await dataDirectory();
    const outcome = await recordHostCrash(data, {
      recordedAt: "2026-11-13T10:00:00.000Z",
      process: "host",
      exitReason: "signal SIGKILL",
      lastLines: [
        "opening /Users/ada/Library/octant/store.db",
        "",
        "token=sk-abcdefghijklmnop1234",
      ],
      homeDirectory: "/Users/ada",
    });
    expect(outcome).toEqual({ status: "recorded" });
    const [record] = await readHostCrashRecords(data);
    expect(record?.exitReason).toBe("signal SIGKILL");
    expect(record?.lastLines[0]).toBe("opening ~/Library/octant/store.db");
    expect(record?.lastLines).toHaveLength(2);
    expect(JSON.stringify(record)).not.toContain("sk-abcdefghijklmnop1234");
    expect(JSON.stringify(record)).not.toContain("/Users/ada");
    if (process.platform !== "win32") {
      const [name] = await readdir(hostCrashRecordsDirectory(data));
      const mode = (await stat(join(hostCrashRecordsDirectory(data), name ?? ""))).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("keeps only the newest records and reads them newest first", async () => {
    const data = await dataDirectory();
    for (let index = 0; index < HOST_CRASH_RECORD_LIMIT + 3; index += 1) {
      await recordHostCrash(data, {
        recordedAt: `2026-11-13T10:${String(index).padStart(2, "0")}:00.000Z`,
        process: "host",
        exitReason: `exit code ${index}`,
        lastLines: [],
      });
    }
    const records = await readHostCrashRecords(data);
    expect(records).toHaveLength(HOST_CRASH_RECORD_LIMIT);
    expect(records[0]?.exitReason).toBe(`exit code ${HOST_CRASH_RECORD_LIMIT + 2}`);
    expect(await readdir(hostCrashRecordsDirectory(data))).toHaveLength(HOST_CRASH_RECORD_LIMIT);
  });

  it("writes its own record after an unclean exit nobody watched", async () => {
    const data = await dataDirectory();
    const record = await keepUncleanStopCrashRecord(data, {
      lastSeenAt: "2026-11-13T09:59:00.000Z",
      recordedAt: "2026-11-13T10:05:00.000Z",
      lastLines: ["last reading normal, 300 MB"],
    });
    expect(record).toMatchObject({
      recordedAt: "2026-11-13T10:05:00.000Z",
      exitReason: "stopped without a clean exit",
    });
    expect(await readHostCrashRecords(data)).toHaveLength(1);
  });

  it("reuses the record a watching desktop already kept for the same exit", async () => {
    const data = await dataDirectory();
    await recordHostCrash(data, {
      recordedAt: "2026-11-13T10:00:00.000Z",
      process: "host",
      exitReason: "signal SIGKILL",
      lastLines: [],
    });
    const record = await keepUncleanStopCrashRecord(data, {
      lastSeenAt: "2026-11-13T09:59:00.000Z",
      recordedAt: "2026-11-13T10:05:00.000Z",
      lastLines: [],
    });
    expect(record?.exitReason).toBe("signal SIGKILL");
    expect(await readHostCrashRecords(data)).toHaveLength(1);
  });

  it("reads a host that never crashed as no records", async () => {
    expect(await readHostCrashRecords(await dataDirectory())).toEqual([]);
  });
});
