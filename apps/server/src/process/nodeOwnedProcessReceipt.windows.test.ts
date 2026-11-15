import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  persistProcessReceipt,
  readProcessIdentity,
  readWindowsProcessIdentity,
} from "./nodeOwnedProcessReceipt";
import { windowsSystemProgram } from "./windowsProcessTree";

describe("a Windows process's ownership identity", () => {
  it("names a process by its pid and creation time, read with an exact argument list", async () => {
    const reads: Array<ReadonlyArray<string>> = [];
    const at = (started: string) => async (_program: string, args: ReadonlyArray<string>) => {
      reads.push(args);
      return `${started}\r\n`;
    };
    const first = await readWindowsProcessIdentity(4242, at("133700000000000000"));
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await readWindowsProcessIdentity(4242, at("133700000000000000"))).toBe(first);
    // The same pid started again is another process.
    expect(await readWindowsProcessIdentity(4242, at("133700000000000001"))).not.toBe(first);
    expect(reads[0]).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-Process -Id 4242 -ErrorAction Stop).StartTime.ToFileTimeUtc()",
    ]);
  });

  it("reads no identity for a pid that cannot name a process", async () => {
    const read = vi.fn(async () => "1");
    expect(await readWindowsProcessIdentity(0, read)).toBeUndefined();
    expect(await readWindowsProcessIdentity(-3, read)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "win32")(
    "reads a running process's identity the same way twice and keeps a receipt for it",
    async () => {
      const child = spawn(
        windowsSystemProgram("WindowsPowerShell\\v1.0\\powershell.exe"),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 120"],
        { stdio: "ignore", windowsHide: true },
      );
      const pid = child.pid;
      if (pid === undefined) throw new Error("The fixture process did not start.");
      const receiptDirectory = await mkdtemp(join(tmpdir(), "octant-receipts-"));
      try {
        const identity = await readProcessIdentity(pid);
        expect(identity).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(await readProcessIdentity(pid)).toBe(identity);
        const receipt = await persistProcessReceipt(
          { supervisor: "provider", receiptDirectory },
          "windows-fixture",
          pid,
        );
        await receipt.ready;
        expect(await readdir(receiptDirectory)).toHaveLength(1);
        child.kill();
        await new Promise((resolve) => child.once("exit", resolve));
        await vi.waitFor(async () => expect(await readProcessIdentity(pid)).toBeUndefined(), {
          timeout: 20_000,
        });
        await receipt.remove();
        expect(await readdir(receiptDirectory)).toEqual([]);
      } finally {
        child.kill();
        await rm(receiptDirectory, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
