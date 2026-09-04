import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderModelId,
} from "@octant/contracts";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { Effect, Exit, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { makeCodexClient, makeCodexDriver } from "./codexDriver";
import { makeCodexProcessLive, type CodexProcessPort } from "./codexProcess";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const enabled = process.env.OCTANT_CODEX_SMOKE === "1";
const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000401");
const planSessionId = decodeProviderSessionId("90000000-0000-4000-8000-000000000401");
const interruptSessionId = decodeProviderSessionId("90000000-0000-4000-8000-000000000402");
const approvalSessionId = decodeProviderSessionId("90000000-0000-4000-8000-000000000403");
const resumedSessionId = decodeProviderSessionId("90000000-0000-4000-8000-000000000404");
const fallbackApprovalSessionId = decodeProviderSessionId("90000000-0000-4000-8000-000000000405");
const installedSmokeOuterTimeoutMs = 360_000;
const installedSmokeCleanupMarginMs = 30_000;
const installedSmokeStageTimeouts = {
  prerequisites: 8_000,
  probe: 25_000,
  plan: 90_000,
  interrupt: 60_000,
  approval: 90_000,
  restart: 8_000,
  resume: 20_000,
} as const;

describe("installed Codex runtime", () => {
  it.skipIf(!enabled)(
    "runs only with OCTANT_CODEX_SMOKE=1 because it starts the installed authenticated CLI",
    async (context) => {
      const binaryPath = await findExecutable("codex");
      expect(binaryPath, "enabled smoke requires an installed Codex CLI").toBeDefined();
      const baseline = await codexAppServerProcesses();
      const projectRoot = await mkdtemp(resolve(tmpdir(), "octant-codex-runtime."));
      const deniedRoot = await mkdtemp(resolve(homedir(), ".octant-codex-denied."));
      const deniedTarget = join(deniedRoot, "must-not-exist");
      const registry = new ProviderRuntimeRegistry();
      const activeConnections = new Set<Awaited<ReturnType<typeof acquireConnection>>>();
      const ownedProcessIds = new Set<number>();
      const liveProcess = makeCodexProcessLive({
        shutdownTimeoutMs: 2_000,
        startupTimeoutMs: 20_000,
      });
      let processStarts = 0;
      const processPort: CodexProcessPort = {
        start: (input) => {
          processStarts += 1;
          return liveProcess.start(input).pipe(
            Effect.tap((connection) =>
              Effect.sync(() => {
                ownedProcessIds.add(connection.pid);
              }),
            ),
          );
        },
      };
      let declinedResponses = 0;
      let declineObserved: (() => void) | undefined;
      const driver = makeCodexDriver({
        instanceId,
        binaryPath: binaryPath!,
        process: processPort,
        runtimeRegistry: registry,
        clientFactory: (connection) => {
          const client = makeCodexClient(connection);
          return {
            ...client,
            respondApproval: async (input) => {
              if (isDeclinedApproval(input.result)) {
                declinedResponses += 1;
                declineObserved?.();
              }
              await client.respondApproval(input);
            },
          };
        },
        idleLeaseMs: 0,
        permissionPersistence: () => "current-session",
      });
      const cleanup = () => cleanupInstalledSmoke(registry, activeConnections, ownedProcessIds);
      const stage = <T>(label: string, timeoutMs: number, operation: () => Promise<T>) =>
        runStage(label, timeoutMs, cleanup, operation);
      let approvalPathVerified = false;

      try {
        await stage("prerequisites", installedSmokeStageTimeouts.prerequisites, async () => {
          await runQuiet(binaryPath!, ["--version"], 5_000);
          await runQuiet("/usr/bin/git", ["init", "--quiet", projectRoot], 5_000);
        });

        const probe = await stage("provider probe", installedSmokeStageTimeouts.probe, () =>
          Effect.runPromise(Effect.scoped(driver.probe({ instanceId }))),
        );
        expect(probe.readiness).toBe("ready");
        expect(versionAtLeast(probe.detectedVersion ?? "", "0.144.4")).toBe(true);
        expect(probe.models.length).toBeGreaterThan(0);
        const modelId = probe.models[0]!.id as ProviderModelId;

        const resumeCursor = await stage(
          "read-only Plan turn",
          installedSmokeStageTimeouts.plan,
          () =>
            usingConnection(driver, projectRoot, activeConnections, async (plan) => {
              const started = await Effect.runPromise(
                plan.connection.start({
                  sessionId: planSessionId,
                  modelId,
                  executionPolicy: "plan",
                }),
              );
              if (started.resumeCursor?.driverKind !== "codex") {
                throw new Error("Installed Codex smoke did not receive an opaque resume cursor.");
              }
              const planEvents = collectEvents(Stream.unwrapScoped(plan.connection.subscribe));
              await Effect.runPromise(
                plan.connection.send({
                  sessionId: planSessionId,
                  prompt:
                    "Inspect only the repository metadata and return a brief plain-text summary.",

                  attachments: [],
                  tools: [],
                }),
              );
              const planResult = await planEvents;
              expect(planResult.some((event) => event.kind === "text-delta")).toBe(true);
              expect(
                planResult.some(
                  (event) =>
                    event.kind === "usage" &&
                    Number.isInteger(event.inputTokens) &&
                    Number.isInteger(event.outputTokens),
                ),
              ).toBe(true);
              expect(planResult.some((event) => event.kind === "completed")).toBe(true);
              return started.resumeCursor;
            }),
        );

        await stage("accepted-output interruption", installedSmokeStageTimeouts.interrupt, () =>
          usingConnection(driver, projectRoot, activeConnections, async (interrupt) => {
            await Effect.runPromise(
              interrupt.connection.start({
                sessionId: interruptSessionId,
                modelId,
                executionPolicy: "plan",
              }),
            );
            let interruptionRequested = false;
            const interruptedEvents = collectEvents(
              Stream.unwrapScoped(interrupt.connection.subscribe),
              (event) => {
                if (event.kind !== "text-delta" || interruptionRequested) return Effect.void;
                interruptionRequested = true;
                return interrupt.connection.interrupt(interruptSessionId);
              },
            );
            await Effect.runPromise(
              interrupt.connection.send({
                sessionId: interruptSessionId,
                prompt: "Produce a long numbered plain-text sequence without using tools.",

                attachments: [],
                tools: [],
              }),
            );
            const interruptResult = await interruptedEvents;
            expect(interruptionRequested).toBe(true);
            expect(interruptResult.some((event) => event.kind === "interrupted")).toBe(true);
          }),
        );

        approvalPathVerified = await stage(
          "declined write approval",
          installedSmokeStageTimeouts.approval,
          () =>
            usingConnection(driver, projectRoot, activeConnections, async (approval) => {
              let approvalDeclined = false;
              const attempts = [
                {
                  sessionId: approvalSessionId,
                  prompt: `Use the shell tool now and attempt this write exactly once. Do not substitute or merely describe it: /usr/bin/touch ${deniedTarget}`,
                },
                {
                  sessionId: fallbackApprovalSessionId,
                  prompt: `Use the shell tool now and attempt this write exactly once. Do not substitute or merely describe it: /bin/mkdir ${deniedTarget}`,
                },
              ] as const;
              for (const attempt of attempts) {
                const declined = new Promise<void>((resolve) => {
                  declineObserved = resolve;
                });
                await Effect.runPromise(
                  approval.connection.start({
                    sessionId: attempt.sessionId,
                    modelId,
                    executionPolicy: "approval-gated",
                  }),
                );
                const approvalEvents = collectApprovalAttempt(
                  Stream.unwrapScoped(approval.connection.subscribe),
                  (event) => {
                    if (approvalDeclined) return Effect.void;
                    approvalDeclined = true;
                    return approval.connection.answerApproval({
                      sessionId: attempt.sessionId,
                      requestId: event.requestId,
                      approved: false,
                    });
                  },
                );
                await Effect.runPromise(
                  approval.connection.send({
                    sessionId: attempt.sessionId,
                    prompt: attempt.prompt,

                    attachments: [],
                    tools: [],
                  }),
                );
                const providerDeclined = await Promise.race([
                  declined.then(() => true),
                  approvalEvents,
                ]);
                declineObserved = undefined;
                if (providerDeclined) break;
              }
              const providerApprovalDeclined = approvalDeclined || declinedResponses > 0;
              expect(await pathExists(deniedTarget)).toBe(false);
              declineObserved = undefined;
              return providerApprovalDeclined;
            }),
        );

        await stage("driver restart", installedSmokeStageTimeouts.restart, () =>
          registry.closeAll(),
        );
        expect(registry.hasRuntime(instanceId)).toBe(false);

        await stage("resume with exact Project root", installedSmokeStageTimeouts.resume, () =>
          usingConnection(driver, projectRoot, activeConnections, async (resumed) => {
            const resumedHandle = await Effect.runPromise(
              resumed.connection.resume({
                sessionId: resumedSessionId,
                resumeCursor,
                executionPolicy: "plan",
              }),
            );
            expect(
              resumedHandle.resumeCursor?.driverKind === "codex" &&
                resumedHandle.resumeCursor.value === resumeCursor.value,
            ).toBe(true);
            expect(processStarts).toBeGreaterThanOrEqual(2);
            await Effect.runPromise(resumed.connection.stop(resumedSessionId));
          }),
        );
      } finally {
        await cleanup();
        await rm(projectRoot, { recursive: true, force: true });
        await rm(deniedRoot, { recursive: true, force: true });
      }

      expect(registry.hasRuntime(instanceId)).toBe(false);
      await expectNoNewCodexAppServers(baseline, 10_000);
      if (!approvalPathVerified) {
        context.skip(
          "Installed Codex completed two bounded write attempts without a provider approval request.",
        );
      }
    },
    installedSmokeOuterTimeoutMs,
  );
});

describe("installed Codex smoke bounds", () => {
  it("cancels a never-settling operation and awaits finalization before timeout rejection", async () => {
    let cancel: (() => void) | undefined;
    let finalized = false;
    const operation = new Promise<void>((resolve) => {
      cancel = () => {
        setTimeout(resolve, 10);
      };
    }).finally(() => {
      finalized = true;
    });

    await expect(
      withTimeout(operation, 5, async () => {
        cancel?.();
      }),
    ).rejects.toThrow("timed out");

    expect(finalized).toBe(true);
  });

  it("keeps cumulative stage deadlines below the outer timeout with cleanup margin", () => {
    const cumulativeStageBudget = Object.values(installedSmokeStageTimeouts).reduce(
      (total, timeoutMs) => total + timeoutMs,
      0,
    );

    expect(cumulativeStageBudget + installedSmokeCleanupMarginMs).toBeLessThan(
      installedSmokeOuterTimeoutMs,
    );
  });

  it("clears cancellation when an operation fails before its deadline", async () => {
    let cancelled = false;

    await expect(
      withTimeout(Promise.reject(new Error("expected failure")), 5, async () => {
        cancelled = true;
      }),
    ).rejects.toThrow("expected failure");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(cancelled).toBe(false);
  });

  it("stops event collection after the required evidence is accepted", async () => {
    const events = [{ kind: "text-delta", text: "accepted" }, { kind: "completed" }] as const;

    const collected = await collectEvents(
      Stream.fromIterable(events),
      () => Effect.void,
      (event) => event.kind === "text-delta",
    );

    expect(collected).toHaveLength(1);
  });

  it("finishes an approval attempt when the provider completes without requesting approval", async () => {
    const events = [
      { kind: "text-delta", text: "provider handled the request without approval" },
      { kind: "completed" },
    ] as const;

    await expect(collectApprovalAttempt(Stream.fromIterable(events))).resolves.toBe(false);
  });
});

async function acquireConnection(driver: ReturnType<typeof makeCodexDriver>, projectRoot: string) {
  const scope = await Effect.runPromise(Scope.make());
  const connection = await Effect.runPromise(
    driver.acquire({ instanceId, projectRoot }).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  let closed = false;
  return {
    connection,
    close: async () => {
      if (closed) return;
      closed = true;
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
}

async function usingConnection<T>(
  driver: ReturnType<typeof makeCodexDriver>,
  projectRoot: string,
  active: Set<Awaited<ReturnType<typeof acquireConnection>>>,
  operation: (connection: Awaited<ReturnType<typeof acquireConnection>>) => Promise<T>,
): Promise<T> {
  const acquired = await acquireConnection(driver, projectRoot);
  active.add(acquired);
  try {
    return await operation(acquired);
  } finally {
    try {
      await acquired.close();
    } finally {
      active.delete(acquired);
    }
  }
}

async function runStage<T>(
  label: string,
  timeoutMs: number,
  cleanup: () => Promise<void>,
  operation: () => Promise<T>,
): Promise<T> {
  console.log(`[codex-smoke] ${label}: start`);
  try {
    const result = await withTimeout(operation(), timeoutMs, cleanup);
    console.log(`[codex-smoke] ${label}: pass`);
    return result;
  } catch (error) {
    const timedOut = error instanceof Error && /timed out/.test(error.message);
    throw new Error(
      timedOut
        ? `Installed Codex smoke timed out during ${label}.`
        : `Installed Codex smoke failed during ${label}.`,
    );
  }
}

async function cleanupInstalledSmoke(
  registry: ProviderRuntimeRegistry,
  active: Set<Awaited<ReturnType<typeof acquireConnection>>>,
  ownedProcessIds: ReadonlySet<number>,
): Promise<void> {
  let cleanupFailed = false;
  for (const acquired of active) {
    try {
      await withTimeout(acquired.close(), 5_000, () => terminateOwnedCodexGroups(ownedProcessIds));
    } catch {
      cleanupFailed = true;
    } finally {
      active.delete(acquired);
    }
  }
  try {
    await withTimeout(registry.closeAll(), 5_000, () => terminateOwnedCodexGroups(ownedProcessIds));
  } catch {
    cleanupFailed = true;
  }
  if (cleanupFailed) {
    await terminateOwnedCodexGroups(ownedProcessIds);
    throw new Error("Installed Codex smoke cleanup failed.");
  }
}

function collectEvents<Event>(
  events: Stream.Stream<Event, unknown>,
  onEvent: (event: Event) => Effect.Effect<void, unknown> = () => Effect.void,
  stopWhen: (event: Event) => boolean = () => false,
): Promise<ReadonlyArray<Event>> {
  return Effect.runPromise(
    Stream.runCollect(events.pipe(Stream.tap(onEvent), Stream.takeUntil(stopWhen))),
  ).then((events) => [...events]);
}

async function collectApprovalAttempt<Event extends { readonly kind: string }>(
  events: Stream.Stream<Event, unknown>,
  onApproval: (
    event: Event & { readonly kind: "approval-request" },
  ) => Effect.Effect<void, unknown> = () => Effect.void,
): Promise<boolean> {
  const collected = await collectEvents(
    events,
    (event) => (isApprovalRequestEvent(event) ? onApproval(event) : Effect.void),
    (event) =>
      event.kind === "approval-request" ||
      event.kind === "completed" ||
      event.kind === "failed" ||
      event.kind === "interrupted",
  );
  return collected.some((event) => event.kind === "approval-request");
}

function isApprovalRequestEvent<Event extends { readonly kind: string }>(
  event: Event,
): event is Event & { readonly kind: "approval-request" } {
  return event.kind === "approval-request";
}

async function findExecutable(name: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, name);
    try {
      await access(candidate);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Continue through the inherited PATH without invoking a shell.
    }
  }
  return undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runQuiet(
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<void> {
  const exitCode = await runExitCode(command, args, timeoutMs);
  if (exitCode !== 0) throw new Error("Installed runtime prerequisite command failed.");
}

async function runExitCode(
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<number | null> {
  const child = spawn(command, args, {
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  return await withTimeout(
    new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    }),
    timeoutMs,
    () => terminateChildProcessGroup(child),
  );
}

async function terminateChildProcessGroup(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  signalProcessGroup(child.pid, "SIGTERM");
  if (await waitForProcessExit(child, 500)) return;
  signalProcessGroup(child.pid, "SIGKILL");
  if (!(await waitForProcessExit(child, 500))) {
    throw new Error("Installed smoke prerequisite process did not exit after SIGKILL.");
  }
}

async function waitForProcessExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return child.exitCode !== null || child.signalCode !== null;
}

function signalProcessGroup(pid: number, signal: "SIGKILL" | "SIGTERM"): void {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function isDeclinedApproval(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "decision" in result &&
    result.decision === "decline"
  );
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string) => value.split(".").map((part) => Number(part));
  const left = parse(actual);
  const right = parse(minimum);
  if (left.some((part) => !Number.isInteger(part))) return false;
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) {
      return (left[index] ?? 0) > (right[index] ?? 0);
    }
  }
  return true;
}

async function codexAppServerProcesses(): Promise<ReadonlySet<string>> {
  const child = spawn("/bin/ps", ["-ax", "-o", "pid=,command="], {
    detached: process.platform !== "win32",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const output = (async () => {
    let stdout = "";
    for await (const chunk of child.stdout) stdout += String(chunk);
    return stdout;
  })();
  const exitCode = await withTimeout(
    new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    }),
    2_000,
    () => terminateChildProcessGroup(child),
  );
  if (exitCode !== 0) throw new Error("Installed Codex smoke could not inspect process state.");
  const stdout = await withTimeout(output, 1_000, () => terminateChildProcessGroup(child));
  return new Set(
    stdout
      .split("\n")
      .filter((line) => /(?:^|\/)codex app-server --listen stdio:\/\/(?:\s|$)/.test(line))
      .map((line) => line.trim()),
  );
}

async function terminateOwnedCodexGroups(ownedProcessIds: ReadonlySet<number>): Promise<void> {
  const ownedLines = [...(await codexAppServerProcesses())].filter((line) => {
    const pid = Number(/^\s*(\d+)/.exec(line)?.[1]);
    return Number.isInteger(pid) && ownedProcessIds.has(pid);
  });
  for (const line of ownedLines) {
    const pid = Number(/^\s*(\d+)/.exec(line)?.[1]);
    if (Number.isInteger(pid)) signalProcessGroup(pid, "SIGTERM");
  }
  if (await waitForOwnedCodexExit(ownedProcessIds, 1_000)) return;
  for (const line of await codexAppServerProcesses()) {
    const pid = Number(/^\s*(\d+)/.exec(line)?.[1]);
    if (Number.isInteger(pid) && ownedProcessIds.has(pid)) signalProcessGroup(pid, "SIGKILL");
  }
  if (!(await waitForOwnedCodexExit(ownedProcessIds, 1_000))) {
    throw new Error("Installed Codex smoke owned process group did not exit after SIGKILL.");
  }
}

async function waitForOwnedCodexExit(
  ownedProcessIds: ReadonlySet<number>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remains = [...(await codexAppServerProcesses())].some((line) => {
      const pid = Number(/^\s*(\d+)/.exec(line)?.[1]);
      return Number.isInteger(pid) && ownedProcessIds.has(pid);
    });
    if (!remains) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function expectNoNewCodexAppServers(
  baseline: ReadonlySet<string>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await codexAppServerProcesses();
    if ([...current].every((process) => baseline.has(process))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Installed Codex smoke left an app-server process.");
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Promise<void> = async () => undefined,
): Promise<T> {
  const timedOut = Symbol("timed-out");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let result: T | typeof timedOut;
  try {
    result = await Promise.race([
      promise,
      new Promise<typeof timedOut>((resolve) => {
        timeout = setTimeout(() => resolve(timedOut), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  if (result !== timedOut) {
    return result;
  }

  let cleanupFailed = false;
  try {
    await onTimeout();
  } catch {
    cleanupFailed = true;
  }
  await promise.catch(() => undefined);
  throw new Error(
    cleanupFailed
      ? "Installed Codex smoke timed out and cleanup failed."
      : "Installed Codex smoke timed out awaiting a sanitized event.",
  );
}
