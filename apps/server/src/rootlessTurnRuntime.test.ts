import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ROOTLESS_TURN_FAILURE_BYTES,
  MAX_ROOTLESS_TURN_RESPONSE_BYTES,
  decodeProviderSessionId,
  decodeStartRootlessThreadTurnCommand,
} from "@octant/contracts";
import type { ProviderAcquireInput, ProviderDriver } from "@octant/provider-sdk/driver";
import { Effect, Queue, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RootlessTurnRuntime } from "./rootlessTurnRuntime";
import { RootlessScratchStore } from "./rootlessScratchStore";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("RootlessTurnRuntime", () => {
  it("launches Work in a fresh owned scratch root with no root-backed tools", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "octant-rootless-runtime-"));
    directories.push(dataDirectory);
    const sessionId = decodeProviderSessionId("00000000-0000-4000-8000-000000000730");
    const queue = Effect.runSync(Queue.unbounded<never>());
    const acquireInputs: ProviderAcquireInput[] = [];
    const send = vi.fn((input: { readonly tools: ReadonlyArray<unknown> }) =>
      Effect.gen(function* () {
        expect(input.tools).toEqual([]);
        yield* Queue.offer(queue, { kind: "text-delta", sessionId, text: "Launch brief" } as never);
        yield* Queue.offer(queue, { kind: "completed", sessionId } as never);
      }),
    );
    const driver = {
      acquire: (input: ProviderAcquireInput) => {
        acquireInputs.push(input);
        return Effect.succeed({
          events: Stream.fromQueue(queue),
          start: () => Effect.succeed({ sessionId }),
          send,
          interrupt: () => Effect.void,
          stop: () => Effect.void,
        });
      },
    } as unknown as ProviderDriver;
    const command = decodeStartRootlessThreadTurnCommand({
      kind: "start-rootless-thread-turn",
      requestId: "00000000-0000-4000-8000-000000000720",
      threadId: "00000000-0000-4000-8000-000000000721",
      turnId: "00000000-0000-4000-8000-000000000722",
      title: "Unfiled brief",
      prompt: "Draft a launch brief",
      context: {
        hostId: "local",
        mode: "work",
        providerInstanceId: "00000000-0000-4000-8000-000000000703",
        modelId: "model-a",
        workspace: { kind: "rootless" },
      },
    });
    const runtime = new RootlessTurnRuntime({ dataDirectory });

    await expect(
      runtime.run({
        command,
        providerSessionId: sessionId,
        driver,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: "completed", response: "Launch brief" });
    expect(acquireInputs).toHaveLength(1);
    expect(acquireInputs[0]).toMatchObject({ mode: "work", workspace: { kind: "rootless" } });
    expect(acquireInputs[0]!.projectRoot).toContain(join(dataDirectory, "rootless-scratch"));
    await expect(access(acquireInputs[0]!.projectRoot)).rejects.toThrow();
  });

  it("fails closed when a completed rootless turn has no visible reply", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "octant-rootless-empty-"));
    directories.push(dataDirectory);
    const sessionId = decodeProviderSessionId("00000000-0000-4000-8000-000000000731");
    const queue = Effect.runSync(Queue.unbounded<never>());
    const driver = {
      acquire: () =>
        Effect.succeed({
          events: Stream.fromQueue(queue),
          start: () => Effect.succeed({ sessionId }),
          send: () =>
            Effect.gen(function* () {
              yield* Queue.offer(queue, { kind: "text-delta", sessionId, text: " \n " } as never);
              yield* Queue.offer(queue, { kind: "completed", sessionId } as never);
            }),
          interrupt: () => Effect.void,
          stop: () => Effect.void,
        }),
    } as unknown as ProviderDriver;

    await expect(
      new RootlessTurnRuntime({ dataDirectory }).run({
        command: commandFixture("code"),
        providerSessionId: sessionId,
        driver,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      kind: "failed",
      failure: { category: "failed", message: "The provider completed without a visible reply." },
    });
  });

  it("returns an ambiguous waiting outcome when the provider stream disappears", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "octant-rootless-loss-"));
    directories.push(dataDirectory);
    const sessionId = decodeProviderSessionId("00000000-0000-4000-8000-000000000750");
    const driver = {
      acquire: () =>
        Effect.succeed({
          events: Stream.empty,
          start: () => Effect.succeed({ sessionId }),
          send: () => Effect.void,
          interrupt: () => Effect.void,
          stop: () => Effect.void,
        }),
    } as unknown as ProviderDriver;
    const runtime = new RootlessTurnRuntime({ dataDirectory });

    await expect(
      runtime.run({
        command: commandFixture("code"),
        providerSessionId: sessionId,
        driver,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      kind: "waiting",
      failure: { category: "interrupted" },
    });
  });

  it("interrupts a cancelled turn and reports cancellation deterministically", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "octant-rootless-cancel-"));
    directories.push(dataDirectory);
    const sessionId = decodeProviderSessionId("00000000-0000-4000-8000-000000000760");
    const controller = new AbortController();
    const interrupt = vi.fn(() => Effect.void);
    const driver = {
      acquire: () =>
        Effect.succeed({
          events: Stream.never,
          start: () => Effect.succeed({ sessionId }),
          send: () => Effect.sync(() => controller.abort()),
          interrupt,
          stop: () => Effect.void,
        }),
    } as unknown as ProviderDriver;
    const runtime = new RootlessTurnRuntime({ dataDirectory });

    await expect(
      runtime.run({
        command: commandFixture("work"),
        providerSessionId: sessionId,
        driver,
        signal: controller.signal,
      }),
    ).resolves.toEqual({ kind: "cancelled" });
    expect(interrupt).toHaveBeenCalledWith(sessionId);
  });

  it("maps an unsupported provider failure without retrying", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "octant-rootless-unsupported-"));
    directories.push(dataDirectory);
    const driver = {
      acquire: () =>
        Effect.fail({ category: "unsupported", message: "Mode is unsupported." } as const),
    } as unknown as ProviderDriver;
    const runtime = new RootlessTurnRuntime({ dataDirectory });

    await expect(
      runtime.run({
        command: commandFixture("code"),
        providerSessionId: decodeProviderSessionId("00000000-0000-4000-8000-000000000770"),
        driver,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: "failed",
      failure: {
        category: "unsupported",
        code: "unsupported",
        message: "Mode is unsupported.",
      },
    });
  });

  it.each(["timeout", "cancel"] as const)(
    "%ss while scratch acquisition is pending and purges a late-created root",
    async (boundary) => {
      const dataDirectory = await mkdtemp(join(tmpdir(), `octant-rootless-scratch-${boundary}-`));
      directories.push(dataDirectory);
      const command = commandFixture("work");
      const scratchPath = join(dataDirectory, "rootless-scratch", String(command.turnId));
      let releaseAcquire!: () => void;
      const acquireGate = new Promise<void>((resolve) => {
        releaseAcquire = resolve;
      });
      const originalAcquire = RootlessScratchStore.prototype.acquire;
      const acquire = vi
        .spyOn(RootlessScratchStore.prototype, "acquire")
        .mockImplementationOnce(async function (this: RootlessScratchStore, turnId) {
          await acquireGate;
          return await originalAcquire.call(this, turnId);
        });
      const providerAcquire = vi.fn(() => Effect.never);
      const controller = new AbortController();
      const run = new RootlessTurnRuntime({
        dataDirectory,
        timeoutMs: boundary === "timeout" ? 20 : 1_000,
      }).run({
        command,
        providerSessionId: decodeProviderSessionId(
          boundary === "timeout"
            ? "00000000-0000-4000-8000-000000000775"
            : "00000000-0000-4000-8000-000000000776",
        ),
        driver: { acquire: providerAcquire } as unknown as ProviderDriver,
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
      if (boundary === "cancel") controller.abort();

      let outcome;
      try {
        outcome = await settlesWithin(run);
      } finally {
        releaseAcquire();
      }

      expect(outcome).toMatchObject(
        boundary === "cancel"
          ? { kind: "cancelled" }
          : { kind: "waiting", failure: { category: "interrupted" } },
      );
      expect(providerAcquire).not.toHaveBeenCalled();
      await vi.waitFor(
        async () => {
          await expect(access(scratchPath)).rejects.toThrow();
        },
        { timeout: 1_000 },
      );
      expect(providerAcquire).not.toHaveBeenCalled();
    },
  );

  it("bounds and redacts oversized provider output before returning it for persistence", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "octant-rootless-bounded-"));
    directories.push(dataDirectory);
    const sessionId = decodeProviderSessionId("00000000-0000-4000-8000-000000000771");
    const queue = Effect.runSync(Queue.unbounded<never>());
    let scratchRoot = "";
    const driver = {
      acquire: (input: ProviderAcquireInput) => {
        scratchRoot = input.projectRoot;
        return Effect.succeed({
          events: Stream.fromQueue(queue),
          start: () => Effect.succeed({ sessionId }),
          send: () =>
            Effect.gen(function* () {
              yield* Queue.offer(queue, {
                kind: "text-delta",
                sessionId,
                text: `${scratchRoot}:${"🪐".repeat(20_000)}`,
              } as never);
              yield* Queue.offer(queue, { kind: "completed", sessionId } as never);
            }),
          interrupt: () => Effect.void,
          stop: () => Effect.void,
        });
      },
    } as unknown as ProviderDriver;

    const outcome = await new RootlessTurnRuntime({ dataDirectory }).run({
      command: commandFixture("work"),
      providerSessionId: sessionId,
      driver,
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("completed outcome required");
    expect(new TextEncoder().encode(outcome.response).byteLength).toBeLessThanOrEqual(
      MAX_ROOTLESS_TURN_RESPONSE_BYTES,
    );
    expect(outcome.response).toContain("[Output truncated by Octant.]");
    expect(outcome.response).not.toContain(scratchRoot);
  });

  it("bounds and redacts oversized provider failure messages", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "octant-rootless-failure-"));
    directories.push(dataDirectory);
    let scratchRoot = "";
    const driver = {
      acquire: (input: ProviderAcquireInput) => {
        scratchRoot = input.projectRoot;
        return Effect.fail({
          category: "unsupported",
          message: `${scratchRoot}:${"x".repeat(9 * 1024)}`,
        } as const);
      },
    } as unknown as ProviderDriver;

    const outcome = await new RootlessTurnRuntime({ dataDirectory }).run({
      command: commandFixture("code"),
      providerSessionId: decodeProviderSessionId("00000000-0000-4000-8000-000000000772"),
      driver,
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("failed outcome required");
    expect(new TextEncoder().encode(outcome.failure.message).byteLength).toBeLessThanOrEqual(
      MAX_ROOTLESS_TURN_FAILURE_BYTES,
    );
    expect(outcome.failure.message).toContain("[Message truncated by Octant.]");
    expect(outcome.failure.message).not.toContain(scratchRoot);
  });

  it.each(["acquire", "start", "send", "events"] as const)(
    "times out a hung provider %s stage and purges scratch",
    async (stage) => {
      const dataDirectory = await mkdtemp(join(tmpdir(), `octant-rootless-${stage}-timeout-`));
      directories.push(dataDirectory);
      const sessionId = decodeProviderSessionId("00000000-0000-4000-8000-000000000773");
      const interrupt = vi.fn(() => Effect.void);
      const stop = vi.fn(() => Effect.void);
      let scratchRoot = "";
      const driver = {
        acquire: (input: ProviderAcquireInput) => {
          scratchRoot = input.projectRoot;
          if (stage === "acquire") return Effect.never;
          return Effect.succeed({
            events: Stream.never,
            start: () => (stage === "start" ? Effect.never : Effect.succeed({ sessionId })),
            send: () => (stage === "send" ? Effect.never : Effect.void),
            interrupt,
            stop,
          });
        },
      } as unknown as ProviderDriver;

      const outcome = await settlesWithin(
        new RootlessTurnRuntime({ dataDirectory, timeoutMs: 20 }).run({
          command: commandFixture("work"),
          providerSessionId: sessionId,
          driver,
          signal: new AbortController().signal,
        }),
      );

      expect(outcome).toMatchObject({ kind: "waiting", failure: { category: "interrupted" } });
      await expect(access(scratchRoot)).rejects.toThrow();
      if (stage !== "acquire") {
        expect(interrupt).toHaveBeenCalledWith(sessionId);
        expect(stop).toHaveBeenCalledWith(sessionId);
      }
    },
  );

  it.each(["acquire", "start", "send", "events"] as const)(
    "cancels during provider %s and purges scratch",
    async (stage) => {
      const dataDirectory = await mkdtemp(join(tmpdir(), `octant-rootless-${stage}-cancel-`));
      directories.push(dataDirectory);
      const sessionId = decodeProviderSessionId("00000000-0000-4000-8000-000000000774");
      const controller = new AbortController();
      const interrupt = vi.fn(() => Effect.void);
      const stop = vi.fn(() => Effect.void);
      let scratchRoot = "";
      const hangAfterAbort = Effect.sync(() => controller.abort()).pipe(
        Effect.zipRight(Effect.never),
      );
      const driver = {
        acquire: (input: ProviderAcquireInput) => {
          scratchRoot = input.projectRoot;
          if (stage === "acquire") return hangAfterAbort;
          return Effect.succeed({
            events: Stream.never,
            start: () => (stage === "start" ? hangAfterAbort : Effect.succeed({ sessionId })),
            send: () =>
              stage === "send"
                ? hangAfterAbort
                : stage === "events"
                  ? Effect.sync(() => {
                      setTimeout(() => controller.abort(), 0);
                    })
                  : Effect.void,
            interrupt,
            stop,
          });
        },
      } as unknown as ProviderDriver;

      const outcome = await settlesWithin(
        new RootlessTurnRuntime({ dataDirectory, timeoutMs: 50 }).run({
          command: commandFixture("code"),
          providerSessionId: sessionId,
          driver,
          signal: controller.signal,
        }),
      );

      expect(outcome).toEqual({ kind: "cancelled" });
      await expect(access(scratchRoot)).rejects.toThrow();
      if (stage !== "acquire") {
        expect(interrupt).toHaveBeenCalledWith(sessionId);
        expect(stop).toHaveBeenCalledWith(sessionId);
      }
    },
  );
});

async function settlesWithin<T>(promise: Promise<T>): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Rootless provider lifecycle did not settle.")), 250),
    ),
  ]);
}

function commandFixture(mode: "work" | "code") {
  return decodeStartRootlessThreadTurnCommand({
    kind: "start-rootless-thread-turn",
    requestId:
      mode === "work"
        ? "00000000-0000-4000-8000-000000000780"
        : "00000000-0000-4000-8000-000000000781",
    threadId:
      mode === "work"
        ? "00000000-0000-4000-8000-000000000782"
        : "00000000-0000-4000-8000-000000000783",
    turnId:
      mode === "work"
        ? "00000000-0000-4000-8000-000000000784"
        : "00000000-0000-4000-8000-000000000785",
    title: "Unfiled brief",
    prompt: "Draft a launch brief",
    context: {
      hostId: "local",
      mode,
      providerInstanceId: "00000000-0000-4000-8000-000000000703",
      modelId: "model-a",
      workspace: { kind: "rootless" },
    },
  });
}
