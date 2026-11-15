import { describe, expect, it, vi } from "vitest";
import { Effect, Exit, Scope, Stream } from "effect";
import {
  decodeProviderModelId,
  decodeProviderSessionId,
  type ProviderSessionId,
} from "@octant/contracts";
import type {
  ProviderBackgroundWork,
  ProviderConnection,
  ProviderSessionStart,
} from "@octant/provider-sdk/driver";
import { OutlivingSessions } from "./outlivingSessions";

const sessionId = decodeProviderSessionId("94000000-0000-4000-8000-000000000001");
const otherSessionId = decodeProviderSessionId("94000000-0000-4000-8000-000000000002");
const key = "code:94000000-0000-4000-8000-000000000003";

function start(overrides: Partial<ProviderSessionStart> = {}): ProviderSessionStart {
  return {
    sessionId,
    modelId: decodeProviderModelId("sonnet"),
    executionPolicy: "approval-gated",
    tools: [],
    ...overrides,
  };
}

/** A connection whose one session reports background work as a test drives it. */
function fakeRuntime() {
  let work: ProviderBackgroundWork = {
    tasks: [],
    turnRunning: false,
    runtimeTurnWaiting: false,
    ended: false,
  };
  const listeners = new Set<(work: ProviderBackgroundWork) => void>();
  const stopped: Array<ProviderSessionId> = [];
  const started: Array<ProviderSessionStart> = [];
  let connectionsOpened = 0;
  let connectionsClosed = 0;
  const report = (next: Partial<ProviderBackgroundWork>) => {
    work = { ...work, ...next };
    for (const listener of [...listeners]) listener(work);
  };
  const connection: ProviderConnection = {
    subscribe: Effect.succeed(Stream.empty),
    start: (input) =>
      Effect.sync(() => {
        started.push(input);
        work = { tasks: [], turnRunning: false, runtimeTurnWaiting: false, ended: false };
        return { sessionId: input.sessionId };
      }),
    resume: (input) => Effect.succeed({ sessionId: input.sessionId }),
    send: () => Effect.void,
    interrupt: () => Effect.void,
    stop: (id) =>
      Effect.sync(() => {
        stopped.push(id);
        report({ ended: true, tasks: [] });
        listeners.clear();
      }),
    answerApproval: () => Effect.void,
    answerUserInput: () => Effect.void,
    answerTool: () => Effect.void,
    backgroundWork: () => ({
      current: () => work,
      watch: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
  };
  const open = Effect.acquireRelease(
    Effect.sync(() => {
      connectionsOpened += 1;
      return connection;
    }),
    () =>
      Effect.sync(() => {
        connectionsClosed += 1;
      }),
  );
  return {
    open,
    report,
    stopped,
    started,
    counts: () => ({ opened: connectionsOpened, closed: connectionsClosed }),
  };
}

/** Runs one turn: acquire, start, let `during` act, then the runner's own stop. */
async function turn(
  keeper: OutlivingSessions,
  runtime: ReturnType<typeof fakeRuntime>,
  during: (connection: ProviderConnection) => void = () => undefined,
  input: ProviderSessionStart = start(),
  terms?: string,
) {
  const scope = Effect.runSync(Scope.make());
  const connection = await Effect.runPromise(
    Scope.extend(keeper.acquire(key, "same-folder", runtime.open, terms), scope),
  );
  await Effect.runPromise(connection.start(input));
  during(connection);
  await Effect.runPromise(connection.stop(input.sessionId));
  await Effect.runPromise(Scope.close(scope, Exit.void));
  return connection;
}

function keeperFor(options: Partial<ConstructorParameters<typeof OutlivingSessions>[0]> = {}) {
  return new OutlivingSessions({
    idleLimitMs: () => null,
    startRuntimeTurn: async () => ({ status: "started" }),
    ...options,
  });
}

describe("OutlivingSessions", () => {
  it("keeps a session running a background task after its turn and stops it once the task ends with no turn running", async () => {
    const runtime = fakeRuntime();
    const keeper = keeperFor({ taskEndGraceMs: 10 });
    await turn(keeper, runtime, () =>
      runtime.report({ tasks: [{ taskId: "dev", description: "bun run dev" }] }),
    );
    expect(runtime.stopped).toEqual([]);
    expect(keeper.liveTasks(key)).toEqual({
      tasks: [{ taskId: "dev", description: "bun run dev" }],
      turnRunning: false,
    });
    runtime.report({ tasks: [] });
    await vi.waitFor(() => expect(runtime.stopped).toEqual([sessionId]));
    await vi.waitFor(() => expect(runtime.counts()).toEqual({ opened: 1, closed: 1 }));
    expect(keeper.liveTasks(key)).toBeUndefined();
  });

  it("stops a session with no background work when its turn ends, as before", async () => {
    const runtime = fakeRuntime();
    const keeper = keeperFor();
    await turn(keeper, runtime);
    expect(runtime.stopped).toEqual([sessionId]);
    expect(runtime.counts()).toEqual({ opened: 1, closed: 1 });
  });

  it("stops the kept session and every task in it when the person stops the thread", async () => {
    const runtime = fakeRuntime();
    const keeper = keeperFor();
    await turn(keeper, runtime, () => runtime.report({ tasks: [{ taskId: "dev" }] }));
    expect(await keeper.stopThread(key)).toBe(true);
    expect(runtime.stopped).toEqual([sessionId]);
    expect(runtime.counts().closed).toBe(1);
    expect(await keeper.stopThread(key)).toBe(false);
  });

  it("opens a runtime-started turn when the runtime starts one by itself while the thread is idle", async () => {
    const runtime = fakeRuntime();
    const startRuntimeTurn = vi.fn(async () => ({ status: "started" as const }));
    const keeper = keeperFor({ startRuntimeTurn });
    await turn(keeper, runtime, () => runtime.report({ tasks: [{ taskId: "dev" }] }));
    runtime.report({ tasks: [], turnRunning: true, runtimeTurnWaiting: true });
    await vi.waitFor(() => expect(startRuntimeTurn).toHaveBeenCalledWith(key));
    expect(runtime.stopped).toEqual([]);
    // The runtime's turn reattaches to the same session rather than opening one.
    await turn(keeper, runtime, () =>
      runtime.report({ turnRunning: false, runtimeTurnWaiting: false }),
    );
    expect(runtime.started).toHaveLength(1);
    expect(runtime.counts()).toEqual({ opened: 1, closed: 1 });
  });

  it("stops the session when the host cannot open a turn for the runtime's own", async () => {
    const runtime = fakeRuntime();
    const keeper = keeperFor({
      startRuntimeTurn: async () => ({ status: "refused", message: "The thread was archived." }),
    });
    await turn(keeper, runtime, () => runtime.report({ tasks: [{ taskId: "dev" }] }));
    runtime.report({ turnRunning: true, runtimeTurnWaiting: true });
    await vi.waitFor(() => expect(runtime.stopped).toEqual([sessionId]));
  });

  it("stops a session left only with background work once the idle limit passes", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      const keeper = keeperFor({ idleLimitMs: () => 60_000 });
      await turn(keeper, runtime, () => runtime.report({ tasks: [{ taskId: "watch" }] }));
      await vi.advanceTimersByTimeAsync(59_000);
      expect(runtime.stopped).toEqual([]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(runtime.stopped).toEqual([sessionId]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the kept session before a turn that needs another level starts its own", async () => {
    const runtime = fakeRuntime();
    const keeper = keeperFor();
    await turn(keeper, runtime, () => runtime.report({ tasks: [{ taskId: "dev" }] }));
    await turn(keeper, runtime, () => undefined, start({ executionPolicy: "plan" }));
    expect(runtime.stopped[0]).toBe(sessionId);
    expect(runtime.started.map((input) => input.executionPolicy)).toEqual([
      "approval-gated",
      "plan",
    ]);
    expect(runtime.started.every((input) => input.outlivesTurn === true)).toBe(true);
  });

  it("waits for the runtime's own turn after the last task ends before stopping the session", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      const startRuntimeTurn = vi.fn(async () => ({ status: "started" as const }));
      const keeper = keeperFor({ startRuntimeTurn, taskEndGraceMs: 5_000 });
      await turn(keeper, runtime, () => runtime.report({ tasks: [{ taskId: "dev" }] }));
      // The task's end arrives before the runtime reports the turn it starts.
      runtime.report({ tasks: [] });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runtime.stopped).toEqual([]);
      runtime.report({ turnRunning: true, runtimeTurnWaiting: true });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(startRuntimeTurn).toHaveBeenCalledWith(key);
      expect(runtime.stopped).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a session whose last task ended once the grace passes with no turn of the runtime's", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      const keeper = keeperFor({ taskEndGraceMs: 5_000 });
      await turn(keeper, runtime, () => runtime.report({ tasks: [{ taskId: "dev" }] }));
      runtime.report({ tasks: [] });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(runtime.stopped).toEqual([]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(runtime.stopped).toEqual([sessionId]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the session when the runtime turn the host opened never takes it up, even with no idle limit", async () => {
    vi.useFakeTimers();
    try {
      const runtime = fakeRuntime();
      const keeper = keeperFor({ leaseDeadlineMs: 30_000 });
      await turn(keeper, runtime, () => runtime.report({ tasks: [{ taskId: "dev" }] }));
      runtime.report({ turnRunning: true, runtimeTurnWaiting: true });
      await vi.advanceTimersByTimeAsync(29_000);
      expect(runtime.stopped).toEqual([]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(runtime.stopped).toEqual([sessionId]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the kept session when the person lowers the thread's level after its turn", async () => {
    const runtime = fakeRuntime();
    let terms = "full-access";
    const keeper = keeperFor({ currentTerms: () => terms });
    await turn(
      keeper,
      runtime,
      () => runtime.report({ tasks: [{ taskId: "dev" }] }),
      start(),
      terms,
    );
    expect(await keeper.stopThreadIfChanged(key)).toBe(false);
    expect(runtime.stopped).toEqual([]);
    terms = "approval-gated";
    expect(await keeper.stopThreadIfChanged(key)).toBe(true);
    expect(runtime.stopped).toEqual([sessionId]);
    expect(keeper.liveTasks(key)).toBeUndefined();
  });

  it("does not keep a session past a turn during which the thread's level changed", async () => {
    const runtime = fakeRuntime();
    let terms: string | undefined = "full-access";
    const keeper = keeperFor({ currentTerms: () => terms });
    await turn(
      keeper,
      runtime,
      () => {
        runtime.report({ tasks: [{ taskId: "dev" }] });
        // Archived while the turn ran: the thread can run no turn now.
        terms = undefined;
      },
      start(),
      "full-access",
    );
    expect(runtime.stopped).toEqual([sessionId]);
  });

  it("refuses a second turn while another holds the thread's session", async () => {
    const runtime = fakeRuntime();
    const keeper = keeperFor();
    const scope = Effect.runSync(Scope.make());
    await Effect.runPromise(Scope.extend(keeper.acquire(key, "same-folder", runtime.open), scope));
    const second = await Effect.runPromiseExit(
      Effect.scoped(keeper.acquire(key, "same-folder", runtime.open)),
    );
    expect(Exit.isFailure(second)).toBe(true);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    // The turn that held it closed without a stop, so nothing stays running.
    expect(runtime.counts()).toEqual({ opened: 1, closed: 1 });
  });

  it("keeps a session that is still stopping in the way of the next turn and of another stop until it has stopped", async () => {
    let stopped = false;
    let finishStop: (() => void) | undefined;
    let opened = 0;
    const work: ProviderBackgroundWork = {
      tasks: [{ taskId: "dev" }],
      turnRunning: false,
      runtimeTurnWaiting: false,
      ended: false,
    };
    const connection: ProviderConnection = {
      subscribe: Effect.succeed(Stream.empty),
      start: (input) => Effect.succeed({ sessionId: input.sessionId }),
      resume: (input) => Effect.succeed({ sessionId: input.sessionId }),
      send: () => Effect.void,
      interrupt: () => Effect.void,
      // The runtime and its tasks take a while to shut down.
      stop: () =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              finishStop = () => {
                stopped = true;
                resolve();
              };
            }),
        ),
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      answerTool: () => Effect.void,
      backgroundWork: () => ({ current: () => work, watch: () => () => undefined }),
    };
    const open = Effect.sync(() => {
      opened += 1;
      return connection;
    });
    const keeper = keeperFor();
    const first = Effect.runSync(Scope.make());
    const held = await Effect.runPromise(
      Scope.extend(keeper.acquire(key, "same-folder", open), first),
    );
    await Effect.runPromise(held.start(start()));
    await Effect.runPromise(held.stop(sessionId));
    await Effect.runPromise(Scope.close(first, Exit.void));
    expect(keeper.liveTasks(key)?.tasks).toHaveLength(1);

    const stopping = keeper.stopThread(key);
    await vi.waitFor(() => expect(finishStop).toBeDefined());
    // A Stop pressed again, and a turn sent meanwhile, both wait for it.
    let secondStop: boolean | undefined;
    const again = keeper.stopThread(key).then((answer) => {
      secondStop = answer;
    });
    const next = Effect.runSync(Scope.make());
    let acquired = false;
    const acquiring = Effect.runPromise(
      Scope.extend(keeper.acquire(key, "same-folder", open), next),
    ).then(() => {
      acquired = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(acquired).toBe(false);
    expect(secondStop).toBeUndefined();
    expect(opened).toBe(1);

    finishStop?.();
    await Promise.all([stopping, again, acquiring]);
    expect(stopped).toBe(true);
    expect(secondStop).toBe(true);
    // The next turn opens its connection only once the old one has stopped.
    expect(opened).toBe(2);
    await Effect.runPromise(Scope.close(next, Exit.void));
    await keeper.close();
  });

  it("waits at shutdown for a session that was already stopping", async () => {
    let finishStop: (() => void) | undefined;
    const work: ProviderBackgroundWork = {
      tasks: [{ taskId: "dev" }],
      turnRunning: false,
      runtimeTurnWaiting: false,
      ended: false,
    };
    const connection: ProviderConnection = {
      subscribe: Effect.succeed(Stream.empty),
      start: (input) => Effect.succeed({ sessionId: input.sessionId }),
      resume: (input) => Effect.succeed({ sessionId: input.sessionId }),
      send: () => Effect.void,
      interrupt: () => Effect.void,
      stop: () =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              finishStop = resolve;
            }),
        ),
      answerApproval: () => Effect.void,
      answerUserInput: () => Effect.void,
      answerTool: () => Effect.void,
      backgroundWork: () => ({ current: () => work, watch: () => () => undefined }),
    };
    const keeper = keeperFor();
    const scope = Effect.runSync(Scope.make());
    const held = await Effect.runPromise(
      Scope.extend(keeper.acquire(key, "same-folder", Effect.succeed(connection)), scope),
    );
    await Effect.runPromise(held.start(start()));
    await Effect.runPromise(held.stop(sessionId));
    await Effect.runPromise(Scope.close(scope, Exit.void));

    const stopping = keeper.stopThread(key);
    await vi.waitFor(() => expect(finishStop).toBeDefined());
    let closed = false;
    const closing = keeper.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Shutdown is not done while that runtime and its tasks are still going.
    expect(closed).toBe(false);
    finishStop?.();
    await Promise.all([stopping, closing]);
    expect(closed).toBe(true);
  });

  it("stops every kept session at shutdown", async () => {
    const runtime = fakeRuntime();
    const keeper = keeperFor();
    await turn(
      keeper,
      runtime,
      () => runtime.report({ tasks: [{ taskId: "dev" }] }),
      start({ sessionId: otherSessionId }),
    );
    await keeper.close();
    expect(runtime.stopped).toEqual([otherSessionId]);
    expect(runtime.counts().closed).toBe(1);
  });
});
