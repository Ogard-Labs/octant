import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderExecutionPolicy } from "@octant/contracts";
import {
  WINDOWS_CHAT_PROVIDER_REFUSAL,
  WINDOWS_STRICT_REFUSAL,
} from "@octant/domain/guardrail-policy";
import { Effect, Either } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeAcpProcessLive } from "./acpProcess";
import { acpProviderProfiles } from "./acpProfiles";
import { makeClaudeProcessLive } from "./claudeProcess";
import { makeOpenCodeProcessLive } from "./openCodeProcess";
import { makePiConfinementLive, makePiProcessLive } from "./piProcess";

/**
 * The fake Claude, OpenCode, Pi and Kilo ACP runtimes compiled to Windows
 * programs (`bun build --compile fixtures/fakeClaudeCli.ts`,
 * `fixtures/fakeOpenCodeCli.ts`, `fixtures/fakePiCli.ts`,
 * `fixtures/fakeKiloAcpAgent.ts`), which the Windows CI job builds and names
 * here. Without them the real Windows checks do not run.
 */
const fakeClaude = process.env.OCTANT_FAKE_CLAUDE_EXE;
const fakeOpenCode = process.env.OCTANT_FAKE_OPENCODE_EXE;
const fakePi = process.env.OCTANT_FAKE_PI_EXE;
const fakeAcpAgent = process.env.OCTANT_FAKE_ACP_EXE;
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

describe.runIf(process.platform === "win32" && fakePi !== undefined)("Pi on a Windows host", () => {
  const startAndStop = async (level: {
    readonly mode: "chat" | "code";
    readonly executionPolicy: ProviderExecutionPolicy;
    readonly strict?: boolean;
  }) => {
    // Pi's launch takes only canonical folders, so the test names them as the
    // host reads them back, whatever short form the runner's temp path has.
    const base = realpathSync(mkdtempSync(join(tmpdir(), "octant-pi-windows-")));
    directories.push(base);
    const root = join(base, "project");
    mkdirSync(root);
    return await Effect.runPromise(
      Effect.either(
        Effect.scoped(
          makePiProcessLive({
            platform: "win32",
            confinement: makePiConfinementLive({
              platform: "win32",
              credentialPath: join(base, "auth.json"),
              modelsPath: join(base, "models.json"),
              ownSetupPath: join(base, "own"),
            }),
            versionTimeoutMs: 30_000,
          })
            .start({
              binaryPath: fakePi ?? "",
              root,
              piHome: join(base, "home"),
              sessionDirectory: join(base, "home", "sessions"),
              sessionId: "session-1",
              ...level,
            })
            .pipe(Effect.map((connection) => connection.pid)),
        ),
      ),
    );
  };

  it("starts at Full access, below it and in Chat outside Strict with no sandbox, and stops its whole tree", async () => {
    for (const level of [
      { mode: "code", executionPolicy: "full-access" },
      { mode: "code", executionPolicy: "approval-gated", strict: false },
      { mode: "chat", executionPolicy: "approval-gated", strict: false },
    ] as const) {
      const started = await startAndStop(level);
      if (Either.isLeft(started)) throw new Error(started.left.message);
      await vi.waitFor(() => expect(running(started.right)).toBe(false), { timeout: 20_000 });
    }
  }, 120_000);

  it("refuses Strict by name before Pi runs", async () => {
    const refused = await startAndStop({ mode: "code", executionPolicy: "approval-gated" });
    expect(Either.isLeft(refused)).toBe(true);
    if (Either.isLeft(refused)) expect(refused.left.message).toBe(WINDOWS_STRICT_REFUSAL);
  }, 60_000);
});

describe.runIf(process.platform === "win32" && fakeAcpAgent !== undefined)(
  "An ACP agent on a Windows host",
  () => {
    const startAndStop = async (level: {
      readonly mode: "chat" | "code";
      readonly executionPolicy: ProviderExecutionPolicy;
      readonly strict?: boolean;
    }) => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "octant-acp-windows-")));
      directories.push(base);
      return await Effect.runPromise(
        Effect.either(
          Effect.scoped(
            makeAcpProcessLive({ platform: "win32", startupTimeoutMs: 30_000 })
              .start({
                profile: acpProviderProfiles.kilo,
                binaryPath: fakeAcpAgent ?? "",
                root: base,
                managedHome: join(base, "managed-home"),
                ...level,
              })
              .pipe(Effect.map((connection) => connection.pid)),
          ),
        ),
      );
    };

    it("starts at Full access and below it outside Strict with no sandbox, answers initialize, and stops its whole tree", async () => {
      for (const level of [
        { mode: "code", executionPolicy: "full-access" },
        { mode: "code", executionPolicy: "approval-gated", strict: false },
      ] as const) {
        const started = await startAndStop(level);
        if (Either.isLeft(started)) throw new Error(started.left.message);
        await vi.waitFor(() => expect(running(started.right)).toBe(false), { timeout: 20_000 });
      }
    }, 120_000);

    it("refuses Strict, and a Chat thread its own tools would leave with a shell, by name before the agent runs", async () => {
      for (const [level, message] of [
        [{ mode: "code", executionPolicy: "approval-gated" }, WINDOWS_STRICT_REFUSAL],
        [
          { mode: "chat", executionPolicy: "approval-gated", strict: false },
          WINDOWS_CHAT_PROVIDER_REFUSAL,
        ],
      ] as const) {
        const refused = await startAndStop(level);
        expect(Either.isLeft(refused)).toBe(true);
        if (Either.isLeft(refused)) expect(refused.left.message).toBe(message);
      }
    }, 60_000);
  },
);
