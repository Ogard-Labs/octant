import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decodeProviderInstanceId, type ProviderFailure } from "@octant/contracts";
import { Effect, Either } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCodexDriver } from "./codexDriver";
import { makeCodexProcessLive, type CodexLaunchAuthority } from "./codexProcess";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

/**
 * The fake Codex app-server compiled to a Windows program (`bun build
 * --compile fixtures/fakeCodexCli.ts`), which the Windows CI job builds and
 * names here. Without it the real Windows checks do not run.
 */
const fakeCodex = process.env.OCTANT_FAKE_CODEX_EXE;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    // Windows can retain a just-exited process's cwd handle briefly.
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function port(catalogUnconfined: boolean) {
  return makeCodexProcessLive({
    platform: "win32",
    octantVersion: "0.1.0-test",
    startupTimeoutMs: 20_000,
    shutdownTimeoutMs: 2_000,
    windowsCatalogUnconfined: () => catalogUnconfined,
  });
}

async function startAndStop(
  binaryPath: string,
  authority: CodexLaunchAuthority,
  catalogUnconfined = false,
): Promise<Either.Either<{ readonly version: string; readonly pid: number }, ProviderFailure>> {
  return await Effect.runPromise(
    Effect.either(
      Effect.scoped(
        port(catalogUnconfined)
          .start({ binaryPath, authority })
          .pipe(Effect.map((connection) => ({ version: connection.version, pid: connection.pid }))),
      ),
    ),
  );
}

describe.runIf(process.platform === "win32" && fakeCodex !== undefined)(
  "Codex on a Windows host",
  () => {
    it("starts at open Full access with an unconfined version read and app-server, and stops it", async () => {
      const root = mkdtempSync(join(tmpdir(), "octant-codex-windows-"));
      directories.push(root);
      const started = await startAndStop(fakeCodex ?? "", {
        kind: "thread",
        root,
        mode: "code",
        executionPolicy: "full-access",
      });
      if (Either.isLeft(started)) throw new Error(started.left.message);
      expect(started.right.version).toBe("0.144.4");
      expect(running(started.right.pid)).toBe(false);
    }, 60_000);

    it("starts a guarded level outside Strict with Codex's own approvals, and stops it", async () => {
      const root = mkdtempSync(join(tmpdir(), "octant-codex-windows-"));
      directories.push(root);
      const started = await startAndStop(fakeCodex ?? "", {
        kind: "thread",
        root,
        mode: "code",
        executionPolicy: "approval-gated",
        strict: false,
      });
      if (Either.isLeft(started)) throw new Error(started.left.message);
      expect(running(started.right.pid)).toBe(false);
    }, 60_000);

    it("refuses Strict and a kept sandbox by name before Codex runs", async () => {
      const root = mkdtempSync(join(tmpdir(), "octant-codex-windows-"));
      directories.push(root);
      for (const level of [{ executionPolicy: "full-access", fullAccessSandbox: true }] as const) {
        const refused = await startAndStop(fakeCodex ?? "", {
          kind: "thread",
          root,
          mode: "code",
          ...level,
        });
        expect(Either.isLeft(refused)).toBe(true);
        if (Either.isLeft(refused))
          expect(refused.left.message).toMatch(/sandbox Windows doesn't have yet/);
      }
    }, 60_000);

    it("starts through an npm command shim by the program it names, with no shell", async () => {
      const npm = mkdtempSync(join(tmpdir(), "octant-codex-npm-"));
      directories.push(npm);
      const program = join(npm, "node_modules", "@openai", "codex", "vendor", "codex.exe");
      mkdirSync(dirname(program), { recursive: true });
      copyFileSync(fakeCodex ?? "", program);
      writeFileSync(
        join(npm, "codex.cmd"),
        '@ECHO off\r\n"%dp0%\\node_modules\\@openai\\codex\\vendor\\codex.exe"   %*\r\n',
      );
      const started = await startAndStop(join(npm, "codex.cmd"), {
        kind: "thread",
        root: npm,
        mode: "code",
        executionPolicy: "full-access",
      });
      if (Either.isLeft(started)) throw new Error(started.left.message);
      expect(started.right.version).toBe("0.144.4");
      expect(running(started.right.pid)).toBe(false);
    }, 60_000);

    it("reads the catalog through the production driver with each process's ownership receipt, and removes the receipt once it ends", async () => {
      const receiptDirectory = mkdtempSync(join(tmpdir(), "octant-codex-receipts-"));
      directories.push(receiptDirectory);
      const registry = new ProviderRuntimeRegistry({ receiptDirectory, shutdownTimeoutMs: 10_000 });
      const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000071");
      const driver = makeCodexDriver({
        instanceId,
        binaryPath: fakeCodex ?? "",
        process: port(true),
        runtimeRegistry: registry,
        idleLeaseMs: 0,
      });
      const probed = await Effect.runPromise(
        Effect.scoped(Effect.either(driver.probe({ instanceId }))),
      );
      if (Either.isLeft(probed)) throw new Error(probed.left.message);
      expect(probed.right.models.length).toBeGreaterThan(0);
      await vi.waitFor(() => expect(readdirSync(receiptDirectory)).toEqual([]), {
        timeout: 20_000,
      });
    }, 60_000);

    it("reads the catalog only for a host whose new threads run with no Octant sandbox", async () => {
      const refused = await startAndStop(fakeCodex ?? "", { kind: "catalog" }, false);
      if (Either.isLeft(refused)) throw new Error(refused.left.message);
      expect(refused.right.version).toBe("0.144.4");
      const read = await startAndStop(fakeCodex ?? "", { kind: "catalog" }, true);
      if (Either.isLeft(read)) throw new Error(read.left.message);
      expect(read.right.version).toBe("0.144.4");
    }, 60_000);
  },
);
