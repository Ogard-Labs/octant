import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderFailure } from "@octant/contracts";
import { Effect, Either } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeCodexProcessLive, type CodexLaunchAuthority } from "./codexProcess";

/**
 * The fake Codex app-server compiled to a Windows program (`bun build
 * --compile fixtures/fakeCodexCli.ts`), which the Windows CI job builds and
 * names here. Without it the real Windows checks do not run.
 */
const fakeCodex = process.env.OCTANT_FAKE_CODEX_EXE;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function port(catalogForOpenFullAccess: boolean) {
  return makeCodexProcessLive({
    platform: "win32",
    octantVersion: "0.1.0-test",
    startupTimeoutMs: 20_000,
    shutdownTimeoutMs: 2_000,
    windowsCatalogForOpenFullAccess: () => catalogForOpenFullAccess,
  });
}

async function startAndStop(
  binaryPath: string,
  authority: CodexLaunchAuthority,
  catalogForOpenFullAccess = false,
): Promise<Either.Either<{ readonly version: string; readonly pid: number }, ProviderFailure>> {
  return await Effect.runPromise(
    Effect.either(
      Effect.scoped(
        port(catalogForOpenFullAccess)
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

    it("refuses a guarded or sandboxed launch, naming the missing sandbox, before Codex runs", async () => {
      const root = mkdtempSync(join(tmpdir(), "octant-codex-windows-"));
      directories.push(root);
      for (const level of [
        { executionPolicy: "approval-gated" },
        { executionPolicy: "full-access", fullAccessSandbox: true },
      ] as const) {
        const refused = await startAndStop(fakeCodex ?? "", {
          kind: "thread",
          root,
          mode: "code",
          ...level,
        });
        expect(Either.isLeft(refused)).toBe(true);
        if (Either.isLeft(refused)) expect(refused.left.message).toMatch(/sandbox|confine/i);
      }
    }, 60_000);

    it("reads the catalog only for a host that starts threads at open Full access", async () => {
      const refused = await startAndStop(fakeCodex ?? "", { kind: "catalog" }, false);
      expect(Either.isLeft(refused)).toBe(true);
      const read = await startAndStop(fakeCodex ?? "", { kind: "catalog" }, true);
      if (Either.isLeft(read)) throw new Error(read.left.message);
      expect(read.right.version).toBe("0.144.4");
    }, 60_000);
  },
);
