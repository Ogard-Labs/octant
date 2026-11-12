import {
  AGENT_MESSAGE_EVENT_NAMES,
  decodeCodeThread,
  decodeWindowId,
  type CodeCommand,
  type CodeSettings,
  type CodeThread,
  type EventEnvelope,
  type Project,
} from "@octant/contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../persistence/migrations";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { createCoordinatorCountStore } from "./coordinatorCountStore";
import { CoordinatorService, type CoordinatorServicePorts } from "./coordinatorService";

const now = "2026-11-10T12:00:00.000Z";
const PROJECT = "40000000-0000-4000-8000-000000000001";
const COORDINATOR = "20000000-0000-4000-8000-000000000001";
const WORKER = "20000000-0000-4000-8000-000000000002";
const OTHER = "20000000-0000-4000-8000-000000000003";
const NEW_WORKER = "20000000-0000-4000-8000-0000000000aa";
const windowId = decodeWindowId("10000000-0000-4000-8000-000000000001");

function codeThread(id: string, overrides: Record<string, unknown> = {}): CodeThread {
  return decodeCodeThread({
    id,
    projectId: PROJECT,
    bindingRevisionId: "70000000-0000-4000-8000-000000000001",
    repositoryId: `repo_${"a".repeat(64)}`,
    checkoutId: "30000000-0000-4000-8000-000000000001",
    title: "Thread title an agent may have written",
    lifecycle: "active",
    providerInstanceId: "60000000-0000-4000-8000-000000000001",
    modelId: "model-a",
    executionPolicy: "auto-accept-edits",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/coordinate",
      remoteName: "origin",
      proposedBaseRepository: "octant/octant",
      proposedBaseBranch: "main",
      outcomeKind: "local-implementation",
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

const temporaryDirectories: string[] = [];
const openConnections: SqliteConnection[] = [];

afterEach(() => {
  for (const connection of openConnections.splice(0)) connection.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/** A host store file holding only the coordinator count tables, opened as a new process would. */
function countStoreFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-coordinator-counts-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "octant.sqlite");
  const connection = openSqlite(path);
  const migration = MIGRATIONS.find((entry) => entry.name === "create_coordinator_count_store");
  if (migration === undefined) throw new Error("The coordinator count migration is missing.");
  connection.exec(migration.sql);
  connection.close();
  return path;
}

function openCountStore(path: string) {
  const connection = openSqlite(path);
  openConnections.push(connection);
  return createCoordinatorCountStore(connection);
}

interface Harness {
  readonly service: CoordinatorService;
  /** A new service over the same threads and host store, as after a restart. */
  readonly restart: () => CoordinatorService;
  readonly threads: Map<string, CodeThread>;
  readonly states: Map<string, "working" | "waiting-for-person" | "idle">;
  readonly marked: Set<string>;
  readonly executed: Array<{ readonly command: CodeCommand; readonly context: unknown }>;
  readonly hostTurns: Array<{ readonly threadId: string; readonly prompt: string }>;
  readonly planners: Set<string>;
  readonly proposals: Array<{
    readonly coordinator: string;
    readonly title: string;
    readonly level: string;
  }>;
  readonly turnIds: Map<string, string>;
  settings: CodeSettings | undefined;
  clock: number;
}

function harness(): Harness {
  const storePath = countStoreFile();
  const threads = new Map<string, CodeThread>([
    [COORDINATOR, codeThread(COORDINATOR, { coordinator: true, messageWake: true })],
  ]);
  const states = new Map<string, "working" | "waiting-for-person" | "idle">();
  const marked = new Set<string>();
  const executed: Harness["executed"] = [];
  const hostTurns: Harness["hostTurns"] = [];
  const proposals: Harness["proposals"] = [];
  const planners = new Set<string>();
  const turnIds = new Map<string, string>();
  let turnCount = 0;
  const self: { settings: CodeSettings | undefined; clock: number } = {
    settings: undefined,
    clock: Date.parse(now),
  };
  const ports: CoordinatorServicePorts = {
    readThread: (id) => threads.get(id),
    readThreads: () => [...threads.values()],
    readProject: () => ({ type: "code", lifecycle: "active" }) as unknown as Project,
    readSettings: () => self.settings,
    isDesignatedPlanner: (id) => planners.has(id),
    isMarked: (id) => marked.has(id),
    threadState: (id) => states.get(id) ?? "idle",
    latestTurnId: (id) =>
      turnIds.get(id) ?? (hostTurns.findLast((turn) => turn.threadId === id) && `turn-${id}`),
    providerKnown: (id) => id === "60000000-0000-4000-8000-000000000009",
    executeCode: async (_window, command, context) => {
      executed.push({ command, context });
      if (command.kind === "prepare-code-project-checkout") {
        return {
          kind: "checkout-prepared",
          bindingRevisionId: "70000000-0000-4000-8000-000000000001",
        } as never;
      }
      if (command.kind === "create-managed-code-thread") {
        threads.set(
          String(command.threadId),
          codeThread(String(command.threadId), {
            coordinatorThreadId: COORDINATOR,
            executionPolicy: command.executionPolicy,
          }),
        );
        return { kind: "managed-thread-created" } as never;
      }
      throw new Error("unexpected command");
    },
    startHostTurn: async (threadId, prompt) => {
      turnCount += 1;
      hostTurns.push({ threadId: String(threadId), prompt });
      return { status: "started", operationId: `turn-${String(threadId)}` };
    },
    propose: (coordinator, draft, workerOptions) => {
      proposals.push({
        coordinator: String(coordinator),
        title: draft.title,
        level: workerOptions.executionPolicy,
      });
      return { status: "proposed", proposalId: `proposal-${String(turnCount)}` };
    },
    counts: openCountStore(storePath),
    uuid: () => NEW_WORKER,
    now: () => self.clock,
  };
  const service = new CoordinatorService(ports);
  return Object.assign(self, {
    service,
    restart: () => {
      service.stop();
      return new CoordinatorService({ ...ports, counts: openCountStore(storePath) });
    },
    threads,
    states,
    marked,
    executed,
    hostTurns,
    proposals,
    planners,
    turnIds,
  });
}

const coordinatorWithBounds = (coordinatorBounds: Record<string, number>): CodeThread =>
  codeThread(COORDINATOR, { coordinator: true, messageWake: true, coordinatorBounds });

const startCall = (fields: Record<string, unknown>) => ({
  callerThreadId: COORDINATOR,
  windowId,
  fields: {
    operation: "start",
    title: "Fix the flaky test",
    prompt: "Find and fix it.",
    ...fields,
  },
  profileAllowsStart: true,
});

function sent(sender: string, recipient: string): EventEnvelope {
  return {
    eventName: AGENT_MESSAGE_EVENT_NAMES.sent,
    payload: {
      kind: "message-sent",
      messageId: "50000000-0000-4000-8000-000000000001",
      correlationId: "50000000-0000-4000-8000-000000000002",
      senderThreadId: sender,
      recipientThreadId: recipient,
      bodyReference: {
        contentReference: "agent-message-body-1",
        byteLength: 5,
      },
      occurredAt: now,
    },
  } as unknown as EventEnvelope;
}

describe("starting workers", () => {
  it("creates a worker on its own worktree as the coordinator's, then starts its first message as a host turn", async () => {
    const h = harness();
    const answer = await h.service.start(startCall({}));
    expect(answer).toEqual({
      result: {
        status: "started",
        reference: `${NEW_WORKER}@${PROJECT}`,
        firstTurn: "started",
      },
      isError: false,
    });
    const creation = h.executed.find(
      (entry) => entry.command.kind === "create-managed-code-thread",
    );
    expect(creation?.command).toMatchObject({
      projectId: PROJECT,
      executionPolicy: "auto-accept-edits",
      sourceBranch: "main",
    });
    expect(creation?.context).toEqual({ coordinatorThreadId: COORDINATOR });
    expect(h.hostTurns).toEqual([{ threadId: NEW_WORKER, prompt: "Find and fix it." }]);
  });

  it("starts a marked coordinator's worker marked and never at Full access", async () => {
    const h = harness();
    h.threads.set(
      COORDINATOR,
      codeThread(COORDINATOR, { coordinator: true, executionPolicy: "full-access" }),
    );
    h.marked.add(COORDINATOR);
    await h.service.start(startCall({}));
    const creation = h.executed.find(
      (entry) => entry.command.kind === "create-managed-code-thread",
    );
    expect(creation?.command).toMatchObject({ executionPolicy: "auto-accept-edits" });
    expect(creation?.context).toEqual({
      coordinatorThreadId: COORDINATOR,
      inheritedMark: {
        sourceLabel: "coordinator-start",
        contentReference: `coordinator-start-${COORDINATOR}-${NEW_WORKER}`,
      },
    });
  });

  it("starts a marked coordinator's worker at the level the person fixed, Full access included", async () => {
    const h = harness();
    h.threads.set(
      COORDINATOR,
      codeThread(COORDINATOR, { coordinator: true, coordinatorWorkerLevel: "full-access" }),
    );
    h.marked.add(COORDINATOR);
    await h.service.start(startCall({ level: "approval-gated" }));
    const creation = h.executed.find(
      (entry) => entry.command.kind === "create-managed-code-thread",
    );
    expect(creation?.command).toMatchObject({ executionPolicy: "full-access" });
    // The worker still starts marked: the fixed level lifts the cap, not the mark.
    expect(creation?.context).toMatchObject({
      inheritedMark: { sourceLabel: "coordinator-start" },
    });
  });

  it("proposes instead of creating when a person chose Propose for approval for the Project", async () => {
    const h = harness();
    h.settings = {
      coordinatorStartingByProject: { [PROJECT]: "propose-for-approval" },
    } as unknown as CodeSettings;
    const answer = await h.service.start(startCall({}));
    expect(answer.isError).toBe(false);
    expect(answer.result).toMatchObject({ status: "proposed" });
    expect(h.proposals).toEqual([
      { coordinator: COORDINATOR, title: "Fix the flaky test", level: "auto-accept-edits" },
    ]);
    expect(h.executed).toEqual([]);
  });

  it("refuses a thread that is not a coordinator, an unknown provider, and an over-long title", async () => {
    const h = harness();
    h.threads.set(OTHER, codeThread(OTHER));
    expect(await h.service.start({ ...startCall({}), callerThreadId: OTHER })).toMatchObject({
      result: { status: "refused", reason: "unauthorized" },
      isError: true,
    });
    expect(
      await h.service.start(
        startCall({ providerInstanceId: "60000000-0000-4000-8000-00000000dead", modelId: "m" }),
      ),
    ).toMatchObject({ result: { reason: "provider-unavailable" } });
    expect(await h.service.start(startCall({ title: "x".repeat(81) }))).toMatchObject({
      result: { reason: "policy" },
    });
    expect(h.executed).toEqual([]);
  });

  it("refuses past the open-worker bound", async () => {
    const h = harness();
    for (let index = 0; index < 6; index += 1) {
      const id = `20000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`;
      h.threads.set(id, codeThread(id, { coordinatorThreadId: COORDINATOR }));
    }
    expect(await h.service.start(startCall({}))).toMatchObject({
      result: { reason: "limit-reached" },
    });
  });

  it("lets a coordinator journaled without bounds make sixty starts an hour, then refuses", async () => {
    const h = harness();
    h.settings = { coordinatorStarting: "propose-for-approval" } as unknown as CodeSettings;
    for (let index = 0; index < 60; index += 1) {
      expect(await h.service.start(startCall({}))).toMatchObject({
        result: { status: "proposed" },
      });
    }
    expect(await h.service.start(startCall({}))).toMatchObject({
      result: { status: "refused", reason: "rate-limited" },
    });
  });

  it("still counts an hour's earlier starts after the host restarts", async () => {
    const h = harness();
    h.settings = { coordinatorStarting: "propose-for-approval" } as unknown as CodeSettings;
    h.threads.set(
      COORDINATOR,
      codeThread(COORDINATOR, { coordinator: true, coordinatorBounds: { startsPerHour: 12 } }),
    );
    for (let index = 0; index < 12; index += 1) {
      expect(await h.service.start(startCall({}))).toMatchObject({
        result: { status: "proposed" },
      });
    }
    const restarted = h.restart();
    expect(await restarted.start(startCall({}))).toMatchObject({
      result: { status: "refused", reason: "rate-limited" },
    });
    h.clock += 60 * 60_000;
    expect(await restarted.start(startCall({}))).toMatchObject({
      result: { status: "proposed" },
    });
  });

  it("counts workers created in the last hour even when no start was recorded", async () => {
    const h = harness();
    h.settings = {
      coordinatorStarting: "propose-for-approval",
      coordinatorOpenWorkerLimit: 16,
    } as unknown as CodeSettings;
    h.threads.set(
      COORDINATOR,
      codeThread(COORDINATOR, { coordinator: true, coordinatorBounds: { startsPerHour: 12 } }),
    );
    for (let index = 0; index < 12; index += 1) {
      const id = `20000000-0000-4000-8000-0000000002${String(index).padStart(2, "0")}`;
      h.threads.set(id, codeThread(id, { coordinatorThreadId: COORDINATOR }));
    }
    expect(await h.service.start(startCall({}))).toMatchObject({
      result: { reason: "rate-limited" },
    });
    expect(h.proposals).toEqual([]);
  });
});

describe("the designated planner", () => {
  const PLANNER = OTHER;

  function plannerHarness(): Harness {
    const h = harness();
    h.threads.set(PLANNER, codeThread(PLANNER));
    h.planners.add(PLANNER);
    return h;
  }

  it("reads as a coordinator, so its turns take the coordinator's read-only gate and roster", () => {
    const h = plannerHarness();
    expect(h.service.isCoordinator(PLANNER)).toBe(true);
    expect(h.service.levelOf(PLANNER)).toBe("auto-accept-edits");
    expect(h.service.contextFor(PLANNER)).toContain("every start becomes a proposal");
    h.planners.delete(PLANNER);
    expect(h.service.isCoordinator(PLANNER)).toBe(false);
    expect(h.service.contextFor(PLANNER)).toBeUndefined();
  });

  it("proposes every start, even under Start without asking, and creates nothing", async () => {
    const h = plannerHarness();
    h.settings = { coordinatorStarting: "start-without-asking" } as unknown as CodeSettings;
    const answer = await h.service.start({ ...startCall({}), callerThreadId: PLANNER });
    expect(answer).toMatchObject({ result: { status: "proposed" }, isError: false });
    expect(h.proposals).toEqual([
      { coordinator: PLANNER, title: "Fix the flaky test", level: "auto-accept-edits" },
    ]);
    expect(h.executed).toEqual([]);
  });

  it("never makes a worker a coordinator, even one designated as planner", async () => {
    const h = plannerHarness();
    h.threads.set(PLANNER, codeThread(PLANNER, { coordinatorThreadId: COORDINATOR }));
    expect(h.service.isCoordinator(PLANNER)).toBe(false);
    expect(await h.service.start({ ...startCall({}), callerThreadId: PLANNER })).toMatchObject({
      result: { reason: "unauthorized" },
    });
    expect(h.proposals).toEqual([]);
  });
});

describe("waking for messages and worker state", () => {
  it("wakes an idle thread whose switch is on, and a worker for its own coordinator", async () => {
    const h = harness();
    h.threads.set(OTHER, codeThread(OTHER, { messageWake: true }));
    h.threads.set(WORKER, codeThread(WORKER, { coordinatorThreadId: COORDINATOR }));
    h.service.onCommittedEvents([sent(WORKER, OTHER), sent(COORDINATOR, WORKER)]);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.hostTurns.map((turn) => turn.threadId).toSorted()).toEqual([WORKER, OTHER].toSorted());
  });

  it("does not wake a thread with the switch off, or a busy one", async () => {
    const h = harness();
    h.threads.set(OTHER, codeThread(OTHER));
    h.threads.set(WORKER, codeThread(WORKER, { messageWake: true }));
    h.states.set(WORKER, "working");
    h.service.onCommittedEvents([sent(COORDINATOR, OTHER), sent(COORDINATOR, WORKER)]);
    await Promise.resolve();
    expect(h.hostTurns).toEqual([]);
  });

  it("lets a coordinator journaled without bounds and its worker wake each other for ten rounds", async () => {
    const h = harness();
    h.threads.set(WORKER, codeThread(WORKER, { coordinatorThreadId: COORDINATOR }));
    for (let round = 0; round < 11; round += 1) {
      const [sender, recipient] = round % 2 === 0 ? [COORDINATOR, WORKER] : [WORKER, COORDINATOR];
      h.service.onCommittedEvents([sent(sender, recipient)]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(h.hostTurns).toHaveLength(10);
  });

  it("stops a coordinator and a worker waking each other after the rounds a person set", async () => {
    const h = harness();
    h.threads.set(COORDINATOR, coordinatorWithBounds({ rounds: 3 }));
    h.threads.set(WORKER, codeThread(WORKER, { coordinatorThreadId: COORDINATOR }));
    // Each reply comes from the turn the previous message woke.
    for (let round = 0; round < 4; round += 1) {
      const [sender, recipient] = round % 2 === 0 ? [COORDINATOR, WORKER] : [WORKER, COORDINATOR];
      h.service.onCommittedEvents([sent(sender, recipient)]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(h.hostTurns).toHaveLength(3);
  });

  it("still refuses a fourth-round wake after the host restarts", async () => {
    const h = harness();
    h.threads.set(COORDINATOR, coordinatorWithBounds({ rounds: 3 }));
    h.threads.set(WORKER, codeThread(WORKER, { coordinatorThreadId: COORDINATOR }));
    for (let round = 0; round < 3; round += 1) {
      const [sender, recipient] = round % 2 === 0 ? [COORDINATOR, WORKER] : [WORKER, COORDINATOR];
      h.service.onCommittedEvents([sent(sender, recipient)]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(h.hostTurns).toHaveLength(3);
    const restarted = h.restart();
    // The worker's reply comes from the turn the third message woke.
    restarted.onCommittedEvents([sent(WORKER, COORDINATOR)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.hostTurns).toHaveLength(3);
  });

  it("keeps a coordinator's six wake turns an hour for its worker across a restart", async () => {
    const h = harness();
    h.threads.set(COORDINATOR, coordinatorWithBounds({ wakesPerHour: 6 }));
    h.threads.set(WORKER, codeThread(WORKER, { coordinatorThreadId: COORDINATOR }));
    const restarted = h.restart();
    for (let index = 0; index < 7; index += 1) {
      const service = index < 4 ? h.service : restarted;
      service.onCommittedEvents([sent(COORDINATOR, WORKER)]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(h.hostTurns.filter((turn) => turn.threadId === WORKER)).toHaveLength(6);
  });

  it("wakes a thread no coordinator directs thirty times an hour, and no more", async () => {
    const h = harness();
    h.threads.set(COORDINATOR, coordinatorWithBounds({ wakesPerHour: 2 }));
    h.threads.set(OTHER, codeThread(OTHER, { messageWake: true }));
    for (let index = 0; index < 32; index += 1) {
      h.service.onCommittedEvents([sent(COORDINATOR, OTHER)]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(h.hostTurns.filter((turn) => turn.threadId === OTHER)).toHaveLength(30);
  });

  it("tells an idle coordinator when a worker finishes, with a roster that names no titles", async () => {
    const h = harness();
    h.threads.set(WORKER, codeThread(WORKER, { coordinatorThreadId: COORDINATOR }));
    h.states.set(WORKER, "working");
    await h.service.sweep();
    expect(h.hostTurns).toEqual([]);
    h.states.set(WORKER, "idle");
    await h.service.sweep();
    expect(h.hostTurns.map((turn) => turn.threadId)).toEqual([COORDINATOR]);
    const roster = h.service.contextFor(COORDINATOR) ?? "";
    expect(roster).toContain(`${WORKER}@${PROJECT}: idle`);
    expect(roster).toContain(`${WORKER}@${PROJECT} became idle`);
    expect(roster).not.toContain("Thread title an agent may have written");
    // The notice is carried once.
    expect(h.service.contextFor(COORDINATOR)).not.toContain("became idle");
    expect(h.service.contextFor(WORKER)).toBeUndefined();
  });
});

describe("naming a coordinator's workers", () => {
  it("lists the workers a coordinator started, leaving out archived ones and other threads", () => {
    const h = harness();
    h.threads.set(WORKER, codeThread(WORKER, { coordinatorThreadId: COORDINATOR }));
    const elsewhere = "20000000-0000-4000-8000-0000000000bb";
    h.threads.set(
      elsewhere,
      codeThread(elsewhere, {
        coordinatorThreadId: COORDINATOR,
        projectId: "40000000-0000-4000-8000-000000000002",
      }),
    );
    h.threads.set(
      NEW_WORKER,
      codeThread(NEW_WORKER, { coordinatorThreadId: COORDINATOR, lifecycle: "archived" }),
    );
    h.threads.set(OTHER, codeThread(OTHER));

    expect(h.service.workersOf(COORDINATOR)).toEqual({ workers: [WORKER], truncated: false });
  });

  it("names nothing for a worker, an ordinary thread, or a thread that stopped coordinating", () => {
    const h = harness();
    h.threads.set(WORKER, codeThread(WORKER, { coordinatorThreadId: COORDINATOR }));
    h.threads.set(OTHER, codeThread(OTHER));

    expect(h.service.workersOf(WORKER)).toBeUndefined();
    expect(h.service.workersOf(OTHER)).toBeUndefined();
    expect(h.service.workersOf("20000000-0000-4000-8000-0000000000ff")).toBeUndefined();

    // The lineage stays on the worker as history, but the former coordinator
    // no longer reads through it.
    h.threads.set(COORDINATOR, codeThread(COORDINATOR));
    expect(h.service.workersOf(COORDINATOR)).toBeUndefined();
  });

  it("names the newest workers and says so when there are more than the roster holds", () => {
    const h = harness();
    for (let index = 0; index < 34; index += 1) {
      const id = `20000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`;
      h.threads.set(
        id,
        codeThread(id, {
          coordinatorThreadId: COORDINATOR,
          updatedAt: new Date(Date.parse(now) + index * 1_000).toISOString(),
        }),
      );
    }

    const roster = h.service.workersOf(COORDINATOR);
    expect(roster?.workers).toHaveLength(32);
    expect(roster?.truncated).toBe(true);
    expect(roster?.workers[0]).toBe("20000000-0000-4000-8000-000000000133");
  });
});

describe("after a coordinator stops coordinating", () => {
  it("no longer wakes its former workers without their own switch", async () => {
    const h = harness();
    h.threads.set(COORDINATOR, codeThread(COORDINATOR));
    h.threads.set(WORKER, codeThread(WORKER, { coordinatorThreadId: COORDINATOR }));
    h.service.onCommittedEvents([sent(COORDINATOR, WORKER)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.hostTurns).toEqual([]);
  });
});

describe("a worker turn that starts and finishes between sweeps", () => {
  it("still tells the coordinator the worker finished", async () => {
    const h = harness();
    h.threads.set(WORKER, codeThread(WORKER, { coordinatorThreadId: COORDINATOR }));
    h.turnIds.set(WORKER, "turn-a");
    await h.service.sweep();
    expect(h.hostTurns).toEqual([]);
    h.turnIds.set(WORKER, "turn-b");
    await h.service.sweep();
    expect(h.hostTurns.map((turn) => turn.threadId)).toEqual([COORDINATOR]);
    expect(h.service.contextFor(COORDINATOR)).toContain(`${WORKER}@${PROJECT} became idle`);
  });
});
