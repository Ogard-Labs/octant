import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { readHostCrashRecords, type ProcessErrorNetTarget } from "@octant/host-runtime";
import {
  configureDesktopProcessErrorNet,
  installDesktopProcessErrorNet,
} from "./desktopProcessErrorNet";

class FakeTarget extends EventEmitter implements ProcessErrorNetTarget {}

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const DESKTOP_NET_SOURCE = fileURLToPath(new URL("./desktopProcessErrorNet.ts", import.meta.url));
const MACOS_ELECTRON_BINARY = join(
  REPO_ROOT,
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);

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
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "darwin" && existsSync(MACOS_ELECTRON_BINARY))(
    "exits real Electron with code 1 and a redacted crash record without opening its error dialog",
    async () => {
      const workDirectory = await mkdtemp(join(tmpdir(), "octant-electron-net-"));
      const dataDirectory = join(workDirectory, "data");
      const entrySource = join(workDirectory, "probe.ts");
      const entryBundle = join(workDirectory, "probe.mjs");
      try {
        await writeFile(
          entrySource,
          [
            `import { app } from "electron";`,
            `import { installDesktopProcessErrorNet } from ${JSON.stringify(DESKTOP_NET_SOURCE)};`,
            `installDesktopProcessErrorNet({`,
            `  homeDirectory: "/Users/ada",`,
            `  dataDirectory: ${JSON.stringify(dataDirectory)},`,
            `  exit: (code) => {`,
            `    try { app.exit(code); } catch { process.exit(code); }`,
            `  },`,
            `});`,
            `void app.whenReady().then(() => {`,
            `  setTimeout(() => {`,
            `    throw new Error("electron crash at /Users/ada/repo Authorization: Bearer electronsecret12345");`,
            `  }, 50);`,
            `});`,
          ].join("\n"),
          "utf8",
        );

        const built = spawnSync(
          "bun",
          [
            "build",
            entrySource,
            "--target=node",
            "--external=electron",
            `--outfile=${entryBundle}`,
          ],
          { encoding: "utf8", timeout: 15_000 },
        );
        expect(built.error).toBeUndefined();
        expect(built.status).toBe(0);

        const ran = spawnSync(MACOS_ELECTRON_BINARY, [entryBundle], {
          encoding: "utf8",
          timeout: 15_000,
        });
        expect(ran.error).toBeUndefined();
        expect(ran.status).toBe(1);
        expect(ran.stderr).toContain("[octant:desktop] fatal uncaughtException");
        expect(ran.stderr).toContain("electron crash at ~/repo");
        expect(ran.stderr).not.toContain("/Users/ada");
        expect(ran.stderr).not.toContain("electronsecret12345");

        const records = await readHostCrashRecords(dataDirectory);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          process: "desktop",
          exitReason: "uncaughtException",
        });
        expect(JSON.stringify(records[0])).not.toContain("/Users/ada");
        expect(JSON.stringify(records[0])).not.toContain("electronsecret12345");
      } finally {
        await rm(workDirectory, { recursive: true, force: true });
      }
    },
  );
});
