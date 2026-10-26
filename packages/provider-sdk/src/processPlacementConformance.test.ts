import type {
  CorrelationId,
  ProviderCapabilities,
  ProviderInstanceId,
  ProviderModelId,
  ProviderRuntimeEvent,
  ProviderSessionId,
  UtcTimestamp,
} from "@octant/contracts";
import { Cause, Deferred, Effect, Exit, Option, Queue, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  acquireProviderConnection,
  runRemotePlacementConformance,
  type ProviderConnection,
  type ProviderDriver,
  type ProviderPlacedProcess,
  type ProviderPlacedProcessEnd,
  type ProviderRemotePlacementConformanceFixture,
  type ProviderRemotePlacementSupport,
  type ProviderRemoteProcessPlacement,
} from "./index";

const instanceId = "10000000-0000-4000-8000-000000000061" as ProviderInstanceId;
const sessionId = "20000000-0000-4000-8000-000000000062" as ProviderSessionId;
const modelId = "octant-placed-model" as ProviderModelId;
const correlationId = "30000000-0000-4000-8000-000000000063" as CorrelationId;
const occurredAt = "2026-10-26T10:00:00.000Z" as UtcTimestamp;
const remoteRoot = "/home/build/app";

const capabilities: ProviderCapabilities = {
  streaming: "supported",
  resume: "unsupported",
  interruption: "unsupported",
  approvals: "unsupported",
  userQuestions: "unsupported",
  reasoning: "unsupported",
  usage: "unsupported",
  toolActivity: "unsupported",
  fileChanges: "unsupported",
  diffs: "unsupported",
  taskProgress: "unsupported",
  nativeChildAgents: "unsupported",
  harnessAutoReview: "unsupported",
  nativeAttachments: "unsupported",
  nativeWebResearch: "unsupported",
  appManagedTools: "unsupported",
  citations: "unsupported",
};

const declared: ProviderRemotePlacementSupport = {
  postures: ["plan", "approval-gated", "auto-accept-edits"],
  appToolTransport: "stdio",
};

/** How the stand-in driver treats the placement it is handed. */
type Placing =
  /** Starts its runtime through the placement, in the connection's scope. */
  | "places"
  /** Ignores the placement and starts its runtime on this host. */
  | "runs-locally"
  /** Starts through the placement, and on this host when the target refuses. */
  | "falls-back-locally"
  /** Starts through the placement in a scope it never closes. */
  | "leaks-process";

/**
 * A stand-in target whose runtime answers each line it reads with `reply:`
 * and the line, so a turn's reply shows it crossed the placed process.
 */
function echoTarget(): ProviderRemoteProcessPlacement {
  return {
    kind: "remote",
    launch: () =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const output = yield* Queue.unbounded<Uint8Array>();
          const ended = yield* Deferred.make<ProviderPlacedProcessEnd>();
          const process: ProviderPlacedProcess = {
            output: Stream.fromQueue(output),
            write: (bytes) =>
              Queue.offer(
                output,
                new TextEncoder().encode(`reply:${new TextDecoder().decode(bytes)}`),
              ).pipe(Effect.asVoid),
            ended: Deferred.await(ended),
          };
          return { process, output, ended };
        }),
        ({ output, ended }) =>
          Effect.zipRight(
            Deferred.succeed(ended, { kind: "exited", code: 0 }),
            Queue.shutdown(output),
          ),
      ).pipe(Effect.map(({ process }) => process)),
  };
}

function placedDriverFixture(options: {
  readonly placing: Placing;
  readonly remotePlacement?: ProviderRemotePlacementSupport;
}): ProviderRemotePlacementConformanceFixture {
  let localLaunches = 0;
  let acquired = 0;
  let released = 0;
  let sequence = 0;
  const event = (
    fields:
      | Pick<ProviderRuntimeEvent & { kind: "text-delta" }, "kind" | "text">
      | {
          readonly kind: "completed";
        },
  ): ProviderRuntimeEvent => ({
    ...fields,
    instanceId,
    sessionId,
    sequence: (sequence += 1),
    correlationId,
    occurredAt,
  });
  const runtime = (placement: ProviderRemoteProcessPlacement | undefined) =>
    Effect.gen(function* () {
      const launch = { executable: "/opt/stub/bin/runtime", args: ["--stdio"] } as const;
      const local = Effect.sync((): ProviderPlacedProcess | undefined => {
        localLaunches += 1;
        return undefined;
      });
      if (placement === undefined || options.placing === "runs-locally") return yield* local;
      if (options.placing === "leaks-process") {
        const detached = yield* Scope.make();
        return yield* Scope.extend(placement.launch(launch), detached);
      }
      if (options.placing === "falls-back-locally") {
        return yield* placement.launch(launch).pipe(Effect.catchAll(() => local));
      }
      return yield* placement.launch(launch);
    });
  const driver: ProviderDriver = {
    kind: "opencode",
    ...(options.remotePlacement === undefined ? {} : { remotePlacement: options.remotePlacement }),
    probe: () =>
      Effect.succeed({
        instanceId,
        readiness: "ready",
        processState: "running",
        detectedVersion: "1.0.0",
        models: [],
        capabilities,
        observedAt: occurredAt,
      }),
    acquire: (input) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          acquired += 1;
          const process = yield* runtime(input.placement);
          const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
          const reply = (prompt: string) =>
            process === undefined
              ? Effect.succeed(`local:${prompt}`)
              : Effect.gen(function* () {
                  yield* process.write(new TextEncoder().encode(prompt));
                  const answered = yield* Stream.runHead(process.output);
                  return Option.match(answered, {
                    onNone: () => "",
                    onSome: (bytes) => new TextDecoder().decode(bytes),
                  });
                });
          const connection: ProviderConnection = {
            subscribe: Effect.succeed(Stream.fromQueue(events)),
            start: () => Effect.succeed({ sessionId }),
            resume: () => Effect.fail({ category: "unsupported", message: "No resume." }),
            send: (turn) =>
              Effect.gen(function* () {
                const text = yield* reply(turn.prompt);
                yield* Queue.offer(events, event({ kind: "text-delta", text }));
                yield* Queue.offer(events, event({ kind: "completed" }));
              }),
            interrupt: () => Effect.fail({ category: "unsupported", message: "No interrupt." }),
            stop: () => Effect.void,
            answerApproval: () =>
              Effect.fail({ category: "unsupported", message: "No approvals." }),
            answerUserInput: () =>
              Effect.fail({ category: "unsupported", message: "No questions." }),
            answerTool: () => Effect.fail({ category: "unsupported", message: "No tools." }),
          };
          return connection;
        }),
        () =>
          Effect.sync(() => {
            released += 1;
          }),
      ),
  };
  return {
    driver,
    acquireInput: { instanceId, projectRoot: remoteRoot, mode: "code" },
    sessionStart: { sessionId, modelId, executionPolicy: "approval-gated" },
    turn: { sessionId, prompt: "hello", attachments: [], tools: [] },
    target: echoTarget(),
    localLaunches: () => localLaunches,
    isReleased: () => acquired === released,
  };
}

describe("remote placement conformance", () => {
  it("passes a driver whose runtime runs its turn on the target and stops with its scope", async () => {
    await expect(
      runRemotePlacementConformance(
        placedDriverFixture({ placing: "places", remotePlacement: declared }),
      ),
    ).resolves.toEqual({
      claim: "supported",
      refusedBeforeAnyLaunch: false,
      ranOnTarget: true,
      refusedWithoutLocalFallback: true,
      placedProcessesStopped: true,
    });
  });

  it("refuses a driver that declares no remote placement before anything launches, here or on the target", async () => {
    // The driver would ignore the placement and run here; the seam must not let it try.
    await expect(
      runRemotePlacementConformance(placedDriverFixture({ placing: "runs-locally" })),
    ).resolves.toEqual({
      claim: "unsupported",
      refusedBeforeAnyLaunch: true,
      ranOnTarget: false,
      refusedWithoutLocalFallback: false,
      placedProcessesStopped: true,
    });
  });

  it("fails a driver that declares remote placement and starts its runtime on this host", async () => {
    await expect(
      runRemotePlacementConformance(
        placedDriverFixture({ placing: "runs-locally", remotePlacement: declared }),
      ),
    ).rejects.toThrow("the driver started its runtime on this host");
  });

  it("fails a driver that runs on this host when the target refuses the launch", async () => {
    await expect(
      runRemotePlacementConformance(
        placedDriverFixture({ placing: "falls-back-locally", remotePlacement: declared }),
      ),
    ).rejects.toThrow("the driver ran its runtime on this host when the target refused");
  });

  it("fails a driver that leaves a placed process running past its scope", async () => {
    await expect(
      runRemotePlacementConformance(
        placedDriverFixture({ placing: "leaks-process", remotePlacement: declared }),
      ),
    ).rejects.toThrow("a process placed on the target outlived its scope");
  });

  it("fails a declaration that names no posture", async () => {
    await expect(
      runRemotePlacementConformance(
        placedDriverFixture({
          placing: "places",
          remotePlacement: { postures: [], appToolTransport: "stdio" },
        }),
      ),
    ).rejects.toThrow("remote placement is declared in no posture");
  });
});

describe("acquiring with a remote placement", () => {
  it("refuses a Chat or Work acquisition on a target even from a driver that declares placement", async () => {
    const fixture = placedDriverFixture({ placing: "places", remotePlacement: declared });
    for (const mode of ["chat", "work", undefined] as const) {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          acquireProviderConnection(fixture.driver, {
            instanceId,
            projectRoot: remoteRoot,
            ...(mode === undefined ? {} : { mode }),
            placement: fixture.target,
          }),
        ),
      );
      expect(Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none()).toEqual(
        Option.some({
          category: "unsupported",
          message: "Only Code threads run on a remote target.",
        }),
      );
    }
    expect(fixture.localLaunches()).toBe(0);
  });

  it("hands an acquisition without a placement to any driver unchanged", async () => {
    const fixture = placedDriverFixture({ placing: "runs-locally" });
    await Effect.runPromise(
      Effect.scoped(
        acquireProviderConnection(fixture.driver, {
          instanceId,
          projectRoot: "/tmp",
          mode: "chat",
        }),
      ),
    );
    expect(fixture.localLaunches()).toBe(1);
  });
});
