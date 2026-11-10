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
import { describe, expect, it } from "vitest";
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

interface Harness {
  readonly service: CoordinatorService;
  readonly threads: Map<string, CodeThread>;
  readonly states: Map<string, "working" | "waiting-for-person" | "idle">;
  readonly marked: Set<string>;
  readonly executed: Array<{ readonly command: CodeCommand; readonly context: unknown }>;
  readonly hostTurns: Array<{ readonly threadId: string; readonly prompt: string }>;
  readonly proposals: Array<{ readonly coordinator: string; readonly title: string }>;
  settings: CodeSettings | undefined;
  clock: number;
}

function harness(): Harness {
  const threads = new Map<string, CodeThread>([
    [COORDINATOR, codeThread(COORDINATOR, { coordinator: true, messageWake: true })],
  ]);
  const states = new Map<string, "working" | "waiting-for-person" | "idle">();
  const marked = new Set<string>();
  const executed: Harness["executed"] = [];
  const hostTurns: Harness["hostTurns"] = [];
  const proposals: Harness["proposals"] = [];
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
    isMarked: (id) => marked.has(id),
    threadState: (id) => states.get(id) ?? "idle",
    latestTurnId: (id) => hostTurns.findLast((turn) => turn.threadId === id) && `turn-${id}`,
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
    propose: (coordinator, draft) => {
      proposals.push({ coordinator: String(coordinator), title: draft.title });
      return { status: "proposed", proposalId: `proposal-${String(turnCount)}` };
    },
    uuid: () => NEW_WORKER,
    now: () => self.clock,
  };
  const service = new CoordinatorService(ports);
  return Object.assign(self, {
    service,
    threads,
    states,
    marked,
    executed,
    hostTurns,
    proposals,
  });
}

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

  it("proposes instead of creating when a person chose Propose for approval for the Project", async () => {
    const h = harness();
    h.settings = {
      coordinatorStartingByProject: { [PROJECT]: "propose-for-approval" },
    } as unknown as CodeSettings;
    const answer = await h.service.start(startCall({}));
    expect(answer.isError).toBe(false);
    expect(answer.result).toMatchObject({ status: "proposed" });
    expect(h.proposals).toEqual([{ coordinator: COORDINATOR, title: "Fix the flaky test" }]);
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

  it("stops a coordinator and a worker waking each other after three rounds", async () => {
    const h = harness();
    h.threads.set(WORKER, codeThread(WORKER, { coordinatorThreadId: COORDINATOR }));
    // Each reply comes from the turn the previous message woke.
    for (let round = 0; round < 4; round += 1) {
      const [sender, recipient] = round % 2 === 0 ? [COORDINATOR, WORKER] : [WORKER, COORDINATOR];
      h.service.onCommittedEvents([sent(sender, recipient)]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(h.hostTurns).toHaveLength(3);
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
