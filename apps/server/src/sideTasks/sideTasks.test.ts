import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  EventActor,
  MAX_CODE_PLANNER_PROPOSAL_INTENT_LENGTH,
  MAX_OPEN_SIDE_TASKS,
  type WindowId,
} from "@octant/contracts";
import type { CodePlannerToolPort } from "../code/codePlannerTools";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  continueSideTaskHere,
  dismissSideTask,
  startSideTask,
  type SideTaskStartDependencies,
} from "./sideTaskStart";
import { registerSideTaskEvents, SideTaskStore } from "./sideTaskStore";
import { createSideTaskRouteHandler } from "./sideTaskRoutes";
import {
  continueInThread,
  forkThroughOfferingTurn,
  offeringTurnStanding,
  type SideTaskForkPorts,
} from "./sideTaskThreads";
import { createSideTaskTools } from "./sideTaskTools";
import { WindowAuthorityStore } from "../windowAuthorityStore";

const directories: string[] = [];
const now = "2026-09-26T12:00:00.000Z";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "77777777-7777-4777-8777-777777777777",
});
const threadId = "00000000-0000-4000-8000-000000000020";
const projectId = "00000000-0000-4000-8000-0000000000bb";
const windowId = "00000000-0000-4000-8000-0000000000f0";
const offeringTurnId = "00000000-0000-4000-8000-0000000000c1";
const claude = { providerInstanceId: "00000000-0000-4000-8000-000000000001", modelId: "sonnet" };

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-side-tasks-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function uuidFactory() {
  let counter = 0;
  return () => `aaaaaaaa-aaaa-4aaa-8aaa-${(++counter).toString(16).padStart(12, "0")}`;
}

function storeOn(
  connection: SqliteConnection,
  beforeAppend?: (
    events: ReadonlyArray<{ readonly eventName: string; readonly payload: unknown }>,
  ) => void,
) {
  const journal = new Journal({
    connection,
    registry: registerSideTaskEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
  return new SideTaskStore({
    journal: {
      append: (input) => {
        if (beforeAppend !== undefined) {
          const request = Schema.decodeUnknownSync(
            Schema.Struct({
              events: Schema.Array(
                Schema.Struct({ eventName: Schema.String, payload: Schema.Unknown }),
              ),
            }),
          )(input);
          beforeAppend(request.events);
        }
        return journal.append(input);
      },
      replayAggregateType: journal.replayAggregateType.bind(journal),
    },
    uuid: uuidFactory(),
    actor,
    clock: () => now,
  });
}

function toolsFor(store: SideTaskStore, mode: "chat" | "work" | "code", uuid = uuidFactory()) {
  return createSideTaskTools({
    store,
    threadId,
    mode,
    projectId,
    turnId: offeringTurnId,
    suggestedBy: claude,
    uuid,
    clock: () => now,
  });
}

/** A host whose fork, turn reads, and here-delivery a test does not reach. */
function startDependencies(
  store: SideTaskStore,
  overrides: Partial<SideTaskStartDependencies> = {},
): SideTaskStartDependencies {
  return {
    store,
    create: async () => {
      throw new Error("This test creates no fresh thread.");
    },
    fork: async () => {
      throw new Error("This test forks nothing.");
    },
    offeringTurn: () => "settled",
    sendTurn: async () => true,
    continueHere: async () => {
      throw new Error("This test continues nothing here.");
    },
    clock: () => now,
    ...overrides,
  };
}

const offer = {
  title: "Fix stale install docs",
  reason: "The README still names the removed setup script.",
  prompt: "Update README.md so the install steps match scripts/setup.ts.",
};

describe("side tasks", () => {
  it("records a model's offer as a card that survives a restart, defaulting Code to a worktree", async () => {
    const connection = openConnection();
    const store = storeOn(connection);
    const answer = await toolsFor(store, "code").execute({
      name: "octant_offer_side_task",
      inputJson: JSON.stringify(offer),
    });
    expect(answer).toMatchObject({ result: { status: "offered" } });
    expect(storeOn(connection).read(threadId).tasks).toMatchObject([
      { status: "offered", offer: { ...offer, target: "new-worktree", mode: "code", projectId } },
    ]);
  });

  it("refuses a worktree outside Code and a model that keeps offering past the open limit", async () => {
    const store = storeOn(openConnection());
    const tools = toolsFor(store, "work");
    expect(tools.definitions[0]?.inputSchema).not.toHaveProperty("properties.target");
    const worktree = await tools.execute({
      name: "octant_offer_side_task",
      inputJson: JSON.stringify({ ...offer, target: "new-worktree" }),
    });
    expect(worktree).toMatchObject({ isError: true, result: { status: "refused" } });
    const notAnObject = await tools.execute({ name: "octant_offer_side_task", inputJson: '"x"' });
    expect(notAnObject).toMatchObject({
      isError: true,
      result: { message: expect.stringContaining("must be an object") },
    });

    for (let index = 0; index < MAX_OPEN_SIDE_TASKS; index += 1) {
      await tools.execute({ name: "octant_offer_side_task", inputJson: JSON.stringify(offer) });
    }
    const past = await tools.execute({
      name: "octant_offer_side_task",
      inputJson: JSON.stringify(offer),
    });
    expect(past).toMatchObject({ isError: true });
    expect(store.read(threadId).tasks).toHaveLength(MAX_OPEN_SIDE_TASKS);
  });

  it("starts a side task once: creates the thread on the offering model, sends the prompt, and refuses a second start", async () => {
    const store = storeOn(openConnection());
    await toolsFor(store, "code").execute({
      name: "octant_offer_side_task",
      inputJson: JSON.stringify(offer),
    });
    const sideTaskId = String(store.read(threadId).tasks[0]?.offer.id);
    const create = vi.fn(async () => ({
      kind: "created" as const,
      created: {
        kind: "new-worktree" as const,
        mode: "code" as const,
        projectId: projectId as never,
        title: offer.title,
        threadId: "00000000-0000-4000-8000-000000000099",
      },
      onSuggestingModel: true,
    }));
    const sendTurn = vi.fn(async () => true);
    const dependencies = startDependencies(store, { create, sendTurn });

    const started = await startSideTask(dependencies, { threadId, windowId, sideTaskId });
    expect(started).toMatchObject({
      kind: "side-task-started",
      mode: "code",
      threadId: "00000000-0000-4000-8000-000000000099",
      sent: true,
    });
    expect(create).toHaveBeenCalledWith({
      windowId,
      view: { threadId, mode: "code", projectId, suggestedBy: claude },
      creation: { kind: "new-worktree", mode: "code", projectId, title: offer.title },
    });
    expect(sendTurn).toHaveBeenCalledWith({
      windowId,
      mode: "code",
      threadId: "00000000-0000-4000-8000-000000000099",
      prompt: offer.prompt,
    });
    expect(store.read(threadId).tasks[0]).toMatchObject({
      status: "started",
      startedThreadId: "00000000-0000-4000-8000-000000000099",
    });
    expect(await startSideTask(dependencies, { threadId, windowId, sideTaskId })).toMatchObject({
      kind: "side-task-refused",
      reason: "already-settled",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("keeps a created thread started when its first message did not go out, and lets a person dismiss the rest", async () => {
    const store = storeOn(openConnection());
    const tools = toolsFor(store, "chat");
    await tools.execute({ name: "octant_offer_side_task", inputJson: JSON.stringify(offer) });
    await tools.execute({ name: "octant_offer_side_task", inputJson: JSON.stringify(offer) });
    const [first, second] = store.read(threadId).tasks;
    const result = await startSideTask(
      startDependencies(store, {
        create: async () => ({
          kind: "created",
          created: {
            kind: "new-thread",
            mode: "chat",
            title: offer.title,
            threadId: "00000000-0000-4000-8000-000000000098",
          },
          onSuggestingModel: true,
        }),
        sendTurn: async () => {
          throw new Error("provider unavailable");
        },
      }),
      { threadId, windowId, sideTaskId: String(first?.offer.id) },
    );
    expect(result).toMatchObject({ kind: "side-task-started", sent: false });
    expect(store.read(threadId).tasks[0]?.status).toBe("started");

    expect(
      dismissSideTask(
        { store, clock: () => now },
        { threadId, sideTaskId: String(second?.offer.id) },
      ),
    ).toMatchObject({ kind: "side-task-dismissed" });
    expect(store.read(threadId).tasks[1]?.status).toBe("dismissed");
  });

  it("opens the thread without sending when it could not keep the offering model", async () => {
    const store = storeOn(openConnection());
    await toolsFor(store, "chat").execute({
      name: "octant_offer_side_task",
      inputJson: JSON.stringify(offer),
    });
    const sendTurn = vi.fn(async () => true);
    const result = await startSideTask(
      startDependencies(store, {
        create: async () => ({
          kind: "created",
          created: {
            kind: "new-thread",
            mode: "chat",
            title: offer.title,
            threadId: "00000000-0000-4000-8000-000000000097",
          },
          onSuggestingModel: false,
        }),
        sendTurn,
      }),
      { threadId, windowId, sideTaskId: String(store.read(threadId).tasks[0]?.offer.id) },
    );
    expect(result).toMatchObject({ kind: "side-task-started", sent: false });
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it("refuses a dismissal while the same side task is being started", async () => {
    const store = storeOn(openConnection());
    await toolsFor(store, "chat").execute({
      name: "octant_offer_side_task",
      inputJson: JSON.stringify(offer),
    });
    const sideTaskId = String(store.read(threadId).tasks[0]?.offer.id);
    let dismissal: unknown;
    const result = await startSideTask(
      startDependencies(store, {
        create: async () => {
          dismissal = dismissSideTask({ store, clock: () => now }, { threadId, sideTaskId });
          return {
            kind: "created",
            created: {
              kind: "new-thread",
              mode: "chat",
              title: offer.title,
              threadId: "00000000-0000-4000-8000-000000000096",
            },
            onSuggestingModel: true,
          };
        },
        sendTurn: async () => true,
      }),
      { threadId, windowId, sideTaskId },
    );
    expect(dismissal).toMatchObject({ kind: "side-task-refused", reason: "already-settled" });
    expect(result).toMatchObject({ kind: "side-task-started", sent: true });
    expect(store.read(threadId).tasks[0]?.status).toBe("started");
  });

  it("stamps every offer with the turn that made it, and gives a Code fork its own worktree", async () => {
    const connection = openConnection();
    const store = storeOn(connection);
    await toolsFor(store, "chat").execute({
      name: "octant_offer_side_task",
      inputJson: JSON.stringify(offer),
    });
    await toolsFor(store, "code").execute({
      name: "octant_offer_side_task",
      inputJson: JSON.stringify({ ...offer, target: "new-thread", context: "fork" }),
    });
    const refusedContext = await toolsFor(store, "work").execute({
      name: "octant_offer_side_task",
      inputJson: JSON.stringify({ ...offer, context: "later" }),
    });

    expect(refusedContext).toMatchObject({ isError: true, result: { status: "refused" } });
    expect(
      storeOn(connection)
        .read(threadId)
        .tasks.map((task) => task.offer),
    ).toMatchObject([
      { mode: "chat", context: "fresh", turnId: offeringTurnId, target: "new-thread" },
      { mode: "code", context: "fork", turnId: offeringTurnId, target: "new-worktree" },
    ]);
  });

  it("replays offers and starts journaled before forks existed, and a continuation here", () => {
    const connection = openConnection();
    const store = storeOn(connection);
    const ids = ["bbbbbbbb-bbbb-4bbb-8bbb-000000000001", "bbbbbbbb-bbbb-4bbb-8bbb-000000000002"];
    for (const id of ids) {
      store.offer({
        id: id as never,
        threadId,
        mode: "chat",
        suggestedBy: claude as never,
        title: offer.title,
        reason: offer.reason,
        prompt: offer.prompt,
        target: "new-thread",
        offeredAt: now as never,
      });
    }
    store.settle(threadId, {
      kind: "started",
      payload: {
        sideTaskId: ids[0] as never,
        startedThreadId: "00000000-0000-4000-8000-000000000095",
        startedAt: now as never,
      },
    });
    store.settle(threadId, {
      kind: "continued-here",
      payload: { sideTaskId: ids[1] as never, delivery: "queued", continuedAt: now as never },
    });

    const [started, continued] = storeOn(connection).read(threadId).tasks;
    expect(started?.offer.context).toBeUndefined();
    expect(started?.offer.turnId).toBeUndefined();
    expect(started).toMatchObject({ status: "started", startedWith: "fresh" });
    expect(continued).toMatchObject({ status: "continued-here", continuedDelivery: "queued" });
  });

  describe("starting a side task as a fork of the offering thread", () => {
    const forkId = "00000000-0000-4000-8000-0000000000d1";
    const workRequestId = "00000000-0000-4000-8000-0000000000e1";

    function forkHost(options: { readonly running?: boolean } = {}) {
      const active = options.running === true;
      const chatExecute = vi.fn(async () => ({
        kind: "thread-created",
        thread: { id: forkId, ...claude },
      }));
      const workExecute = vi.fn(async () => ({
        kind: "thread-created" as const,
        thread: { id: forkId, ...claude } as never,
      }));
      const codeExecute = vi.fn(async () => ({
        kind: "managed-thread-created" as const,
        thread: { id: forkId, ...claude } as never,
        checkout: {} as never,
        provenance: {} as never,
      }));
      const ports: SideTaskForkPorts = {
        chatTurns: () => [
          {
            id: offeringTurnId,
            attempts: [{ outcome: active ? "streaming" : "completed" }],
          },
        ],
        workTurns: () => [
          {
            turnId: offeringTurnId,
            requestId: workRequestId,
            status: active ? "running" : "completed",
          },
        ],
        codeTurns: () => [
          { operationId: offeringTurnId, status: active ? "incomplete" : "completed" },
        ],
        chat: { readThread: () => ({ version: 7 }), execute: chatExecute },
        work: { execute: workExecute },
        code: { execute: codeExecute },
        uuid: () => forkId,
      };
      return { ports, chatExecute, workExecute, codeExecute };
    }

    async function offered(store: SideTaskStore, mode: "chat" | "work" | "code") {
      await toolsFor(store, mode).execute({
        name: "octant_offer_side_task",
        inputJson: JSON.stringify({ ...offer, context: "fork" }),
      });
      return String(store.read(threadId).tasks.at(-1)?.offer.id);
    }

    it.each([
      [
        "chat",
        "chatExecute",
        {
          kind: "branch-chat-thread",
          threadId,
          expectedVersion: 7,
          turnId: offeringTurnId,
          title: offer.title,
        },
      ],
      [
        "work",
        "workExecute",
        {
          kind: "fork-work-thread",
          sourceThreadId: threadId,
          throughRequestId: workRequestId,
          title: offer.title,
        },
      ],
      [
        "code",
        "codeExecute",
        {
          kind: "fork-code-thread",
          sourceThreadId: threadId,
          throughOperationId: offeringTurnId,
          title: offer.title,
        },
      ],
    ] as const)(
      "forks a %s thread through the offering turn with its own fork command, then sends the prompt there",
      async (mode, executor, command) => {
        const store = storeOn(openConnection());
        const sideTaskId = await offered(store, mode);
        const host = forkHost();
        const sendTurn = vi.fn(async () => true);
        const create = vi.fn();

        const result = await startSideTask(
          startDependencies(store, {
            create,
            fork: (input) => forkThroughOfferingTurn(host.ports, input),
            offeringTurn: (input) => offeringTurnStanding(host.ports, input),
            sendTurn,
          }),
          { threadId, windowId, sideTaskId },
        );

        expect(result).toMatchObject({
          kind: "side-task-started",
          mode,
          threadId: forkId,
          startedWith: "fork",
          sent: true,
        });
        const executed = host[executor].mock.calls[0] as ReadonlyArray<unknown> | undefined;
        expect(executed?.find((argument) => typeof argument === "object")).toMatchObject(command);
        expect(create).not.toHaveBeenCalled();
        expect(sendTurn).toHaveBeenCalledWith({
          windowId,
          mode,
          threadId: forkId,
          prompt: offer.prompt,
        });
        expect(store.read(threadId).tasks.at(-1)).toMatchObject({
          status: "started",
          startedWith: "fork",
          startedThreadId: forkId,
        });
      },
    );

    it.each(["chat", "work", "code"] as const)(
      "refuses a %s fork while the offering turn is still running, creating nothing",
      async (mode) => {
        const store = storeOn(openConnection());
        const sideTaskId = await offered(store, mode);
        const host = forkHost({ running: true });
        const fork = vi.fn((input: Parameters<SideTaskStartDependencies["fork"]>[0]) =>
          forkThroughOfferingTurn(host.ports, input),
        );

        const result = await startSideTask(
          startDependencies(store, {
            fork,
            offeringTurn: (input) => offeringTurnStanding(host.ports, input),
          }),
          { threadId, windowId, sideTaskId },
        );

        expect(result).toMatchObject({ kind: "side-task-refused", reason: "turn-running" });
        expect(fork).not.toHaveBeenCalled();
        expect(store.read(threadId).tasks.at(-1)?.status).toBe("offered");
      },
    );

    it("starts a suggested fork fresh when the person chooses so", async () => {
      const store = storeOn(openConnection());
      const sideTaskId = await offered(store, "chat");
      const fork = vi.fn();
      const create = vi.fn(async () => ({
        kind: "created" as const,
        created: {
          kind: "new-thread" as const,
          mode: "chat" as const,
          title: offer.title,
          threadId: "00000000-0000-4000-8000-000000000094",
        },
        onSuggestingModel: true,
      }));

      const result = await startSideTask(startDependencies(store, { create, fork }), {
        threadId,
        windowId,
        sideTaskId,
        context: "fresh",
      });

      expect(result).toMatchObject({ kind: "side-task-started", startedWith: "fresh" });
      expect(fork).not.toHaveBeenCalled();
    });

    it("refuses a fork of an offer that does not name its turn", async () => {
      const store = storeOn(openConnection());
      await createSideTaskTools({
        store,
        threadId,
        mode: "chat",
        suggestedBy: claude,
        uuid: uuidFactory(),
        clock: () => now,
      }).execute({
        name: "octant_offer_side_task",
        inputJson: JSON.stringify(offer),
      });
      const fork = vi.fn();

      const result = await startSideTask(startDependencies(store, { fork }), {
        threadId,
        windowId,
        sideTaskId: String(store.read(threadId).tasks[0]?.offer.id),
        context: "fork",
      });

      expect(result).toMatchObject({
        kind: "side-task-refused",
        reason: "target-unavailable",
        message: expect.stringContaining("start fresh"),
      });
      expect(fork).not.toHaveBeenCalled();
    });

    it("keeps the fork's own refusal and leaves the offer open", async () => {
      const store = storeOn(openConnection());
      const sideTaskId = await offered(store, "work");
      const host = forkHost();
      host.workExecute.mockRejectedValueOnce(
        new Error("That message is no longer part of this thread's conversation."),
      );

      const result = await startSideTask(
        startDependencies(store, {
          fork: (input) => forkThroughOfferingTurn(host.ports, input),
          offeringTurn: (input) => offeringTurnStanding(host.ports, input),
        }),
        { threadId, windowId, sideTaskId },
      );

      expect(result).toMatchObject({
        kind: "side-task-refused",
        reason: "target-unavailable",
        message: "That message is no longer part of this thread's conversation.",
      });
      expect(store.read(threadId).tasks.at(-1)?.status).toBe("offered");
    });
  });

  describe("doing a side task here", () => {
    it.each(["sent", "queued"] as const)(
      "never repeats a %s delivery whose receipt could not be journaled, including after restart",
      async (delivery) => {
        const connection = openConnection();
        const store = storeOn(connection, (events) => {
          if (
            events.some(
              (event) =>
                event.eventName === "side-task-continued-here@1" &&
                typeof event.payload === "object" &&
                event.payload !== null &&
                "delivery" in event.payload &&
                event.payload.delivery === delivery,
            )
          )
            throw new Error("Receipt journal unavailable");
        });
        const sideTaskId = await offeredHere(store);
        const continueHere = vi.fn(async () => ({ kind: delivery }));
        const input = { threadId, windowId, sideTaskId };

        expect(
          await continueSideTaskHere(startDependencies(store, { continueHere }), input),
        ).toMatchObject({ delivery: "unconfirmed" });
        expect(store.read(threadId).tasks[0]).toMatchObject({
          status: "continued-here",
          continuedDelivery: "unconfirmed",
        });
        await continueSideTaskHere(startDependencies(store, { continueHere }), input);
        const restarted = storeOn(connection);
        expect(restarted.read(threadId).tasks[0]).toMatchObject({
          status: "continued-here",
          continuedDelivery: "unconfirmed",
        });
        await continueSideTaskHere(startDependencies(restarted, { continueHere }), input);
        expect(continueHere).toHaveBeenCalledTimes(1);
      },
    );

    it("dispatches nothing unless it can durably claim the offer first", async () => {
      const store = storeOn(openConnection(), (events) => {
        if (events.some((event) => event.eventName === "side-task-continued-here@1"))
          throw new Error("Journal unavailable");
      });
      const sideTaskId = await offeredHere(store);
      const continueHere = vi.fn(async () => ({ kind: "sent" as const }));
      const result = await continueSideTaskHere(startDependencies(store, { continueHere }), {
        threadId,
        windowId,
        sideTaskId,
      });
      expect(result).toMatchObject({ kind: "side-task-refused" });
      expect(continueHere).not.toHaveBeenCalled();
      expect(store.read(threadId).tasks[0]?.status).toBe("offered");
    });

    it("keeps thrown delivery uncertain after restart instead of offering a retry", async () => {
      const connection = openConnection();
      const store = storeOn(connection);
      const sideTaskId = await offeredHere(store);
      const continueHere = vi.fn(async () => {
        throw new Error("Delivery response lost");
      });
      const input = { threadId, windowId, sideTaskId };
      expect(
        await continueSideTaskHere(startDependencies(store, { continueHere }), input),
      ).toMatchObject({ delivery: "unconfirmed" });
      await continueSideTaskHere(startDependencies(storeOn(connection), { continueHere }), input);
      expect(continueHere).toHaveBeenCalledTimes(1);
    });

    function queueFake(standing: "idle" | "active" | "unconfirmed" | "unavailable") {
      const snapshot = {
        scope: { mode: "chat", threadId },
        version: 3,
        paused: false,
        items: [],
      };
      return {
        withTurnStanding: vi.fn(
          async (_windowId, _scope, act, _intent?: "read" | "dispatch") => await act(standing),
        ),
        read: vi.fn(async () => ({ status: "ready" as const, snapshot }) as never),
        execute: vi.fn(
          async (_windowId, command: { readonly requestId: string }) =>
            ({ status: "applied", requestId: command.requestId, snapshot }) as never,
        ),
      };
    }

    async function offeredHere(store: SideTaskStore) {
      await toolsFor(store, "chat").execute({
        name: "octant_offer_side_task",
        inputJson: JSON.stringify(offer),
      });
      return String(store.read(threadId).tasks[0]?.offer.id);
    }

    it("sends the prompt as the idle thread's next turn and journals it as sent", async () => {
      const connection = openConnection();
      const store = storeOn(connection);
      const sideTaskId = await offeredHere(store);
      const queue = queueFake("idle");
      const sendTurn = vi.fn(async () => true);

      const result = await continueSideTaskHere(
        startDependencies(store, {
          continueHere: (input) =>
            continueInThread({ queue, sendTurn, uuid: uuidFactory() }, input),
        }),
        { threadId, windowId, sideTaskId },
      );

      expect(result).toEqual({
        kind: "side-task-continued-here",
        sideTaskId,
        threadId,
        delivery: "sent",
      });
      expect(sendTurn).toHaveBeenCalledWith({
        windowId,
        mode: "chat",
        threadId,
        prompt: offer.prompt,
      });
      expect(queue.execute).not.toHaveBeenCalled();
      // Asked as a sender, so a thread that takes no new message reads unavailable.
      expect(queue.withTurnStanding.mock.calls[0]?.[3]).toBe("dispatch");
      expect(storeOn(connection).read(threadId).tasks[0]).toMatchObject({
        status: "continued-here",
        continuedDelivery: "sent",
      });
    });

    it("queues the prompt behind a running turn and journals it as queued", async () => {
      const store = storeOn(openConnection());
      const sideTaskId = await offeredHere(store);
      const queue = queueFake("active");
      const sendTurn = vi.fn(async () => true);

      const result = await continueSideTaskHere(
        startDependencies(store, {
          continueHere: (input) =>
            continueInThread({ queue, sendTurn, uuid: uuidFactory() }, input),
        }),
        { threadId, windowId, sideTaskId },
      );

      expect(result).toMatchObject({ kind: "side-task-continued-here", delivery: "queued" });
      expect(sendTurn).not.toHaveBeenCalled();
      expect(queue.execute).toHaveBeenCalledWith(
        windowId,
        expect.objectContaining({
          kind: "enqueue",
          expectedVersion: 3,
          payload: { mode: "chat", prompt: offer.prompt },
        }),
      );
      expect(store.read(threadId).tasks[0]?.continuedDelivery).toBe("queued");
    });

    it("sends nothing to a thread whose last message may not have gone out, and keeps the card open", async () => {
      const connection = openConnection();
      const store = storeOn(connection);
      const sideTaskId = await offeredHere(store);
      const queue = queueFake("unconfirmed");
      const sendTurn = vi.fn(async () => true);

      const result = await continueSideTaskHere(
        startDependencies(store, {
          continueHere: (input) =>
            continueInThread({ queue, sendTurn, uuid: uuidFactory() }, input),
        }),
        { threadId, windowId, sideTaskId },
      );

      expect(result).toMatchObject({ kind: "side-task-refused", reason: "target-unavailable" });
      expect(sendTurn).not.toHaveBeenCalled();
      expect(queue.execute).not.toHaveBeenCalled();
      expect(store.read(threadId).tasks[0]?.status).toBe("offered");
      expect(storeOn(connection).read(threadId).tasks[0]?.status).toBe("offered");
    });

    it("does not offer another send when an idle-thread delivery returned no confirmation", async () => {
      const store = storeOn(openConnection());
      const sideTaskId = await offeredHere(store);
      const queue = queueFake("idle");
      const sendTurn = vi.fn(async () => false);
      const dependencies = startDependencies(store, {
        continueHere: (input) => continueInThread({ queue, sendTurn, uuid: uuidFactory() }, input),
      });
      const input = { threadId, windowId, sideTaskId };
      expect(await continueSideTaskHere(dependencies, input)).toMatchObject({
        delivery: "unconfirmed",
      });
      await continueSideTaskHere(dependencies, input);
      expect(sendTurn).toHaveBeenCalledTimes(1);
      expect(queue.execute).not.toHaveBeenCalled();
    });

    it("refuses a window the offering thread does not authorize before sending anything", async () => {
      const store = storeOn(openConnection());
      const sideTaskId = await offeredHere(store);
      const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const windowAuthorityStore = new WindowAuthorityStore();
      windowAuthorityStore.register({ windowId: windowId as WindowId, capability, now: 0 });
      const continueHere = vi.fn(async () => ({ kind: "sent" as const }));
      let authorized = false;
      const route = createSideTaskRouteHandler({
        ...startDependencies(store, { continueHere }),
        store,
        windowAuthorityStore,
        authorizeThread: () => authorized,
        now: () => 1,
      });
      const post = () =>
        route(
          new Request(`http://127.0.0.1/api/side-tasks/${threadId}/continue`, {
            method: "POST",
            headers: { "x-octant-window-capability": capability },
            body: JSON.stringify({ sideTaskId, confirmed: true }),
          }),
        );

      expect((await post())?.status).toBe(403);
      expect(continueHere).not.toHaveBeenCalled();

      authorized = true;
      const response = await post();
      expect(response?.status).toBe(200);
      expect(await response?.json()).toMatchObject({
        kind: "side-task-continued-here",
        delivery: "sent",
      });
    });
  });

  describe("the planner's offer to the Project board", () => {
    function plannerTools(
      options: {
        readonly designated?: boolean;
        readonly toolConstraints?: ReadonlyArray<string>;
        readonly propose?: CodePlannerToolPort["propose"];
      } = {},
    ) {
      const store = storeOn(openConnection());
      let designated = options.designated ?? true;
      const propose = vi.fn<CodePlannerToolPort["propose"]>(
        options.propose ??
          (async (_windowId, _threadId, draft) => ({
            status: "proposed",
            proposal: {
              id: "a0000000-0000-4000-8000-000000000001",
              title: draft.title,
              status: "pending",
            } as never,
          })),
      );
      const tools = createSideTaskTools({
        store,
        threadId,
        mode: "code",
        projectId,
        suggestedBy: claude,
        uuid: uuidFactory(),
        clock: () => now,
        planner: {
          port: {
            isPlannerThread: () => designated,
            board: async () => {
              throw new Error("A board offer never reads the board.");
            },
            propose,
          },
          windowId: windowId as WindowId,
        },
        toolConstraints: options.toolConstraints ?? [],
        profileDisplayName: "Planner",
      });
      const schema = tools.definitions[0]?.inputSchema as {
        readonly properties: Record<
          string,
          { readonly enum?: ReadonlyArray<string>; readonly maxLength?: number }
        >;
      };
      return {
        store,
        tools,
        schema,
        propose,
        undesignate: () => {
          designated = false;
        },
      };
    }
    const boardOffer = { ...offer, target: "board" };

    it("records a pending proposal the person confirms, not a side-task card", async () => {
      const { store, tools, schema, propose } = plannerTools();

      expect(schema.properties.target?.enum).toEqual(["new-worktree", "new-thread", "board"]);
      const answer = await tools.execute({
        name: "octant_offer_side_task",
        inputJson: JSON.stringify(boardOffer),
      });

      expect(answer).toMatchObject({
        result: {
          status: "pending-user-confirmation",
          proposalId: "a0000000-0000-4000-8000-000000000001",
        },
      });
      expect(propose).toHaveBeenCalledExactlyOnceWith(windowId, threadId, {
        title: offer.title,
        intent: offer.prompt,
        rationale: offer.reason,
      });
      expect(store.read(threadId).tasks).toEqual([]);
    });

    it("states the planner's tighter bounds in the schema and refuses an intent past them", async () => {
      const { tools, schema, propose } = plannerTools();

      expect(schema.properties.prompt?.maxLength).toBe(MAX_CODE_PLANNER_PROPOSAL_INTENT_LENGTH);
      const tooLong = await tools.execute({
        name: "octant_offer_side_task",
        inputJson: JSON.stringify({
          ...boardOffer,
          prompt: "x".repeat(MAX_CODE_PLANNER_PROPOSAL_INTENT_LENGTH + 1),
        }),
      });

      expect(tooLong).toMatchObject({ isError: true, result: { status: "refused" } });
      expect(propose).not.toHaveBeenCalled();
    });

    it("passes on the planner's own refusal, such as its cap on waiting proposals", async () => {
      const { tools } = plannerTools({
        propose: async () => ({
          status: "refused",
          reason: "too-many-pending-proposals",
          message: "This Project already has 10 proposals waiting for a person.",
        }),
      });

      expect(
        await tools.execute({
          name: "octant_offer_side_task",
          inputJson: JSON.stringify(boardOffer),
        }),
      ).toMatchObject({
        isError: true,
        result: { status: "refused", message: expect.stringContaining("10 proposals") },
      });
    });

    it("offers board only to the designated planner whose profile names it, and refuses once undesignated", async () => {
      expect(plannerTools({ designated: false }).schema.properties.target?.enum).toEqual([
        "new-worktree",
        "new-thread",
      ]);
      expect(
        plannerTools({ toolConstraints: ["octant_offer_side_task"] }).schema.properties.target
          ?.enum,
      ).not.toContain("board");
      const named = plannerTools({ toolConstraints: ["octant_offer_side_task.board"] });
      expect(named.schema.properties.target?.enum).toContain("board");

      named.undesignate();
      expect(
        await named.tools.execute({
          name: "octant_offer_side_task",
          inputJson: JSON.stringify(boardOffer),
        }),
      ).toMatchObject({ isError: true, result: { status: "refused" } });
      expect(named.propose).not.toHaveBeenCalled();
    });

    it("never offers board outside a Code planner", async () => {
      const tools = toolsFor(storeOn(openConnection()), "code");

      expect(
        (tools.definitions[0]?.inputSchema as { properties: { target: { enum: string[] } } })
          .properties.target.enum,
      ).toEqual(["new-worktree", "new-thread"]);
      expect(
        await tools.execute({
          name: "octant_offer_side_task",
          inputJson: JSON.stringify(boardOffer),
        }),
      ).toMatchObject({ isError: true, result: { status: "refused" } });
    });
  });
});
