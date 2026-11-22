import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeProviderInstanceId, type ProviderFailure } from "@octant/contracts";
import {
  WINDOWS_KEPT_SANDBOX_REFUSAL,
  WINDOWS_STRICT_REFUSAL,
  WINDOWS_STRICT_SHIM_REFUSAL,
} from "@octant/domain/guardrail-policy";
import { Effect, Either } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePackagedWindowsConfineLauncher } from "../process/windowsConfinement";
import { WindowsConfinementLeaseStore } from "../process/windowsConfinementRecovery";
import { makeCodexDriver } from "./codexDriver";
import { makeCodexProcessLive, type CodexLaunchAuthority } from "./codexProcess";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

/**
 * The fake Codex app-server compiled to a Windows program (`bun build
 * --compile fixtures/fakeCodexCli.ts`), which the Windows CI job builds and
 * names here. Without it the real Windows checks do not run.
 */
const fakeCodex = process.env.OCTANT_FAKE_CODEX_EXE;
const windowsConfineLauncher = process.env.OCTANT_WINDOWS_CONFINE_EXE;
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

    it("refuses lower levels under Strict and the retired legacy sandbox setting by name before Codex runs", async () => {
      const root = mkdtempSync(join(tmpdir(), "octant-codex-windows-"));
      directories.push(root);
      const legacyRefused = await startAndStop(fakeCodex ?? "", {
        kind: "thread",
        root,
        mode: "code",
        executionPolicy: "full-access",
        fullAccessSandbox: true,
      });
      expect(legacyRefused).toEqual(
        Either.left({ category: "incompatible", message: WINDOWS_KEPT_SANDBOX_REFUSAL }),
      );
      const strictGuardedRefused = await startAndStop(fakeCodex ?? "", {
        kind: "thread",
        root,
        mode: "code",
        executionPolicy: "approval-gated",
        strict: true,
      });
      expect(strictGuardedRefused).toEqual(
        Either.left({ category: "incompatible", message: WINDOWS_STRICT_REFUSAL }),
      );
    }, 60_000);

    it.runIf(windowsConfineLauncher !== undefined)(
      "starts native Codex at Full access under Windows Strict as its own process with Codex's sandbox named, keeps the catalog read in the AppContainer, and refuses .cmd shims",
      async () => {
        const root = realpathSync.native(mkdtempSync(join(tmpdir(), "octant-codex-strict-win-")));
        const leaseDir = realpathSync.native(mkdtempSync(join(tmpdir(), "octant-codex-leases-")));
        const codexHome = realpathSync.native(mkdtempSync(join(tmpdir(), "octant-codex-home-")));
        const bundleRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "octant-win-bundle-")));
        directories.push(root, leaseDir, codexHome, bundleRoot);
        // Verify packaged launcher discovery from the real desktop bundle layout
        // (`resources/app/apps/server/dist/server.mjs` -> `resources/native/octant-windows-confine.exe`).
        const bundledServerEntry = join(
          bundleRoot,
          "resources",
          "app",
          "apps",
          "server",
          "dist",
          "server.mjs",
        );
        const bundledLauncher = join(
          bundleRoot,
          "resources",
          "native",
          "octant-windows-confine.exe",
        );
        mkdirSync(dirname(bundledServerEntry), { recursive: true });
        mkdirSync(dirname(bundledLauncher), { recursive: true });
        writeFileSync(bundledServerEntry, "");
        copyFileSync(realpathSync.native(windowsConfineLauncher ?? ""), bundledLauncher);
        const discoveredLauncher = resolvePackagedWindowsConfineLauncher(
          pathToFileURL(bundledServerEntry),
          "win32",
        );
        expect(discoveredLauncher).toBe(realpathSync.native(bundledLauncher));
        const leaseStore = new WindowsConfinementLeaseStore({ leaseDirectory: leaseDir });
        const confinedPort = makeCodexProcessLive({
          platform: "win32",
          octantVersion: "0.1.0-test",
          startupTimeoutMs: 20_000,
          shutdownTimeoutMs: 2_000,
          windowsCatalogUnconfined: () => false,
          windowsConfinement: {
            launcherPath: discoveredLauncher ?? realpathSync.native(windowsConfineLauncher ?? ""),
            leaseStore,
          },
        });
        // Seed shared startup config, archived history, and the rollout-persistence
        // marker inside CODEX_HOME. The thread's process keeps its own home, so
        // its rollout persists across fresh Windows Strict processes; Codex's own
        // sandbox, not this process, is what keeps commands out of that home.
        writeFileSync(join(codexHome, ".persist-rollout"), "1\n");
        writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.4"\n');
        mkdirSync(join(codexHome, "archived_sessions"), { recursive: true });
        writeFileSync(
          join(codexHome, "archived_sessions", "archived.jsonl"),
          '{"archived":true}\n',
        );
        const canonicalRoot = realpathSync.native(root);
        const started = await Effect.runPromise(
          Effect.either(
            Effect.scoped(
              confinedPort
                .start({
                  binaryPath: realpathSync.native(fakeCodex ?? ""),
                  authority: {
                    kind: "thread",
                    root,
                    mode: "code",
                    executionPolicy: "full-access",
                    strict: true,
                  },
                  environment: {
                    ...process.env,
                    CODEX_HOME: codexHome,
                  },
                })
                .pipe(
                  Effect.flatMap((connection) =>
                    Effect.promise(async () => {
                      const created = await connection.rpc.request(
                        "thread/start",
                        { cwd: canonicalRoot, model: "gpt-5.4" },
                        (value) =>
                          value as {
                            readonly thread: { readonly id: string };
                            readonly cwd: string;
                          },
                      );
                      return {
                        version: connection.version,
                        pid: connection.pid,
                        threadId: created.thread.id,
                        cwd: created.cwd,
                      };
                    }),
                  ),
                ),
            ),
          ),
        );
        if (Either.isLeft(started)) throw new Error(started.left.message);
        expect(started.right.version).toBe("0.144.4");
        expect(started.right.threadId).toBe("thread-1");
        expect(started.right.cwd).toBe(canonicalRoot);
        expect(running(started.right.pid)).toBe(false);
        expect(readdirSync(leaseDir)).toEqual([]);
        expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe('model = "gpt-5.4"\n');
        expect(readFileSync(join(codexHome, "archived_sessions", "archived.jsonl"), "utf8")).toBe(
          '{"archived":true}\n',
        );

        // A fresh follow-up process resumes the saved rollout written by Turn 1
        // and appends its own follow-up record.
        const resumed = await Effect.runPromise(
          Effect.either(
            Effect.scoped(
              confinedPort
                .start({
                  binaryPath: realpathSync.native(fakeCodex ?? ""),
                  authority: {
                    kind: "thread",
                    root,
                    mode: "code",
                    executionPolicy: "full-access",
                    strict: true,
                  },
                  environment: {
                    ...process.env,
                    CODEX_HOME: codexHome,
                  },
                })
                .pipe(
                  Effect.flatMap((connection) =>
                    Effect.promise(async () => {
                      const loaded = await connection.rpc.request(
                        "thread/resume",
                        { threadId: started.right.threadId },
                        (value) =>
                          value as {
                            readonly thread: { readonly id: string };
                            readonly cwd: string;
                          },
                      );
                      return {
                        pid: connection.pid,
                        threadId: loaded.thread.id,
                        cwd: loaded.cwd,
                      };
                    }),
                  ),
                ),
            ),
          ),
        );
        if (Either.isLeft(resumed)) throw new Error(resumed.left.message);
        expect(resumed.right.threadId).toBe("thread-1");
        expect(resumed.right.cwd).toBe(canonicalRoot);
        expect(running(resumed.right.pid)).toBe(false);
        expect(readdirSync(leaseDir)).toEqual([]);
        const savedRollout = readFileSync(
          join(codexHome, "sessions", "rollout-thread-1.jsonl"),
          "utf8",
        );
        expect(savedRollout).toContain('"turns":1');
        expect(savedRollout).toContain('"resumed":true');

        const shimPath = join(root, "codex.cmd");
        writeFileSync(shimPath, "@ECHO off\r\necho should-not-run\r\n");
        const shimRefused = await Effect.runPromise(
          Effect.either(
            Effect.scoped(
              confinedPort.start({
                binaryPath: shimPath,
                authority: {
                  kind: "thread",
                  root,
                  mode: "code",
                  executionPolicy: "full-access",
                  strict: true,
                },
              }),
            ),
          ),
        );
        expect(shimRefused).toEqual(
          Either.left({ category: "incompatible", message: WINDOWS_STRICT_SHIM_REFUSAL }),
        );

        // Confined catalog probe succeeds even when host defaults disallow unconfined catalog reads,
        // and answers `model/list` over stdio with model metadata and options.
        const catalogProbed = await Effect.runPromise(
          Effect.either(
            Effect.scoped(
              confinedPort
                .start({
                  binaryPath: realpathSync.native(fakeCodex ?? ""),
                  authority: { kind: "catalog" },
                  environment: { ...process.env, CODEX_HOME: codexHome },
                })
                .pipe(
                  Effect.flatMap((connection) =>
                    Effect.promise(async () => {
                      const models = await connection.rpc.request(
                        "model/list",
                        {},
                        (value) =>
                          value as {
                            readonly data?: ReadonlyArray<{
                              readonly id?: string;
                              readonly defaultReasoningEffort?: string;
                            }>;
                          },
                      );
                      return {
                        version: connection.version,
                        pid: connection.pid,
                        models: models.data ?? [],
                      };
                    }),
                  ),
                ),
            ),
          ),
        );
        if (Either.isLeft(catalogProbed)) throw new Error(catalogProbed.left.message);
        expect(catalogProbed.right.version).toBe("0.144.4");
        expect(catalogProbed.right.models).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "gpt-5.4", defaultReasoningEffort: "medium" }),
          ]),
        );
        expect(running(catalogProbed.right.pid)).toBe(false);
        expect(readdirSync(leaseDir)).toEqual([]);
      },
      60_000,
    );

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
      expect(Either.isLeft(refused)).toBe(true);
      if (Either.isLeft(refused))
        expect(refused.left.message).toMatch(/Octant's sandbox, which Windows does not/);
      const read = await startAndStop(fakeCodex ?? "", { kind: "catalog" }, true);
      if (Either.isLeft(read)) throw new Error(read.left.message);
      expect(read.right.version).toBe("0.144.4");
    }, 60_000);
  },
);
