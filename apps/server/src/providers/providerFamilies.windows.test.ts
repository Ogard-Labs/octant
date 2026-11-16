import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderExecutionPolicy } from "@octant/contracts";
import { Effect, Either } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeClaudeProcessLive } from "./claudeProcess";
import { makeOpenCodeProcessLive } from "./openCodeProcess";

/**
 * The fake Claude and OpenCode CLIs compiled to Windows programs (`bun build
 * --compile fixtures/fakeClaudeCli.ts`, `fixtures/fakeOpenCodeCli.ts`), which
 * the Windows CI job builds and names here. Without them the real Windows
 * checks do not run.
 */
const fakeClaude = process.env.OCTANT_FAKE_CLAUDE_EXE;
const fakeOpenCode = process.env.OCTANT_FAKE_OPENCODE_EXE;
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

describe.runIf(process.platform === "win32" && fakeClaude !== undefined)(
  "Claude on a Windows host",
  () => {
    it("reads its version unconfined", async () => {
      const version = await Effect.runPromise(
        makeClaudeProcessLive({ platform: "win32" }).probeVersion(fakeClaude ?? ""),
      );
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    }, 60_000);
  },
);

describe.runIf(process.platform === "win32" && fakeOpenCode !== undefined)(
  "OpenCode on a Windows host",
  () => {
    const startAndStop = async (level: {
      readonly executionPolicy: ProviderExecutionPolicy;
      readonly fullAccessSandbox?: boolean;
      readonly strict?: boolean;
    }) => {
      const root = mkdtempSync(join(tmpdir(), "octant-opencode-windows-"));
      directories.push(root);
      return await Effect.runPromise(
        Effect.either(
          Effect.scoped(
            makeOpenCodeProcessLive({
              platform: "win32",
              runtimeConfigResolver: async () => undefined,
              startupTimeoutMs: 20_000,
            })
              .start({ binaryPath: fakeOpenCode ?? "", cwd: root, mode: "code", ...level })
              .pipe(Effect.map((connection) => connection.pid)),
          ),
        ),
      );
    };

    it("starts at Full access and below it outside Strict with no sandbox, and stops its whole tree", async () => {
      for (const level of [
        { executionPolicy: "full-access" },
        { executionPolicy: "approval-gated", strict: false },
      ] as const) {
        const started = await startAndStop(level);
        if (Either.isLeft(started)) throw new Error(started.left.message);
        expect(running(started.right)).toBe(false);
      }
    }, 90_000);

    it("refuses Strict and a kept sandbox by name before OpenCode runs", async () => {
      for (const level of [
        { executionPolicy: "approval-gated" },
        { executionPolicy: "full-access", fullAccessSandbox: true, strict: false },
      ] as const) {
        const refused = await startAndStop(level);
        expect(Either.isLeft(refused)).toBe(true);
        if (Either.isLeft(refused))
          expect(refused.left.message).toMatch(/sandbox Windows doesn't have yet/);
      }
    }, 60_000);
  },
);
