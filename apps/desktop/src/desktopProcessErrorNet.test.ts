import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readHostCrashRecords, type ProcessErrorNetTarget } from "@octant/host-runtime";
import {
  configureDesktopProcessErrorNet,
  installDesktopProcessErrorNet,
} from "./desktopProcessErrorNet";

class FakeTarget extends EventEmitter implements ProcessErrorNetTarget {}

describe("desktop process error net", () => {
  it("records a redacted desktop crash record and exits non-zero after main configures the data directory", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "octant-desktop-net-"));
    const target = new FakeTarget();
    const lines: string[] = [];
    const exit = vi.fn();

    const handle = installDesktopProcessErrorNet({
      target,
      stdioStreams: [],
      homeDirectory: "/Users/ada",
      writeLine: (line) => lines.push(line),
      exit,
      now: () => new Date("2026-11-21T10:30:00.000Z"),
    });

    try {
      configureDesktopProcessErrorNet({
        dataDirectory,
        isShuttingDown: () => false,
      });

      target.emit(
        "uncaughtException",
        new Error("failed at /Users/ada/work token=sk-secret987654"),
      );

      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("[octant:desktop] fatal uncaughtException");
      expect(lines[0]).not.toContain("/Users/ada");
      expect(lines[0]).not.toContain("sk-secret987654");

      const records = await readHostCrashRecords(dataDirectory);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        process: "desktop",
        exitReason: "uncaughtException",
      });
      expect(JSON.stringify(records[0])).not.toContain("/Users/ada");
      expect(JSON.stringify(records[0])).not.toContain("sk-secret987654");
    } finally {
      handle.uninstall();
      configureDesktopProcessErrorNet({});
    }
  });
});
