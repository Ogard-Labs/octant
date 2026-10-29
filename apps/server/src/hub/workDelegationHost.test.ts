import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  AgentProfileId,
  BindingRevisionId,
  DelegationRequestId,
  ProjectId,
  UtcTimestamp,
  WorkThreadId,
  decodeWindowId,
  decodeWorkTurnId,
  decodeWorkTurnRequestId,
  type DelegatedAuthority,
} from "@octant/contracts";
import {
  createWorkDelegationHost,
  type DelegationProjectFacts,
  type DelegationTurnFacts,
  type WorkDelegationServices,
} from "./workDelegationHost";
import type { PeerDelegationHost } from "./peerDelegationService";

const decodeProjectId = Schema.decodeUnknownSync(ProjectId);
const decodeRevisionId = Schema.decodeUnknownSync(BindingRevisionId);
const decodeThreadId = Schema.decodeUnknownSync(WorkThreadId);
const decodeRequestId = Schema.decodeUnknownSync(DelegationRequestId);
const decodeProfileId = Schema.decodeUnknownSync(AgentProfileId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const PROJECT = decodeProjectId("11111111-1111-4111-8111-111111111111");
const SCOPE = decodeWindowId("55555555-5555-4555-8555-555555555555");
const THREAD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function project(
  type: DelegationProjectFacts["type"],
  lifecycle: DelegationProjectFacts["lifecycle"] = "active",
): DelegationProjectFacts {
  return {
    type,
    lifecycle,
    bindingHistory: [{ revisionId: decodeRevisionId("66666666-6666-4666-8666-666666666666") }],
  };
}

const DELEGATED_TURN = "99999999-9999-4999-8999-999999999999";
const FOLLOW_UP_TURN = "12121212-1212-4212-8212-121212121212";

function turn(
  status: DelegationTurnFacts["status"],
  response?: string,
  turnId: string = DELEGATED_TURN,
): DelegationTurnFacts {
  return {
    requestId: decodeWorkTurnRequestId(
      turnId === DELEGATED_TURN
        ? "77777777-7777-4777-8777-777777777777"
        : "13131313-1313-4313-8313-131313131313",
    ),
    threadId: decodeThreadId("88888888-8888-4888-8888-888888888888"),
    turnId: decodeWorkTurnId(turnId),
    status,
    updatedAt: decodeTimestamp("2026-10-29T08:00:00.000Z"),
    ...(response === undefined ? {} : { response }),
  };
}

function services(overrides: Partial<WorkDelegationServices> = {}) {
  const executed: unknown[] = [];
  const firstTurns: Array<{ command: unknown; options: unknown }> = [];
  const cancelled: unknown[] = [];
  const ids = [
    THREAD,
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  ];
  const base: WorkDelegationServices = {
    readProject: () => project("work"),
    isWorkEnabled: () => true,
    threads: {
      execute: async (_scope, command) => {
        executed.push(command);
        return { kind: "thread-created", thread: { id: THREAD } };
      },
      bootstrap: async () => ({
        settings: {
          defaultProviderInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          defaultModelId: "model-a",
        },
      }),
    },
    turns: {
      startFirstTurn: async (_scope, command, options) => {
        firstTurns.push({ command, options });
        return { kind: "accepted" };
      },
      turns: async () => [turn("running")],
      cancelFirstTurn: async (_scope, command) => {
        cancelled.push(command);
        return { kind: "turn-cancelled" };
      },
    },
    scope: SCOPE,
    uuid: () => ids.shift() ?? "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    ...overrides,
  };
  return { host: createWorkDelegationHost(base), executed, firstTurns, cancelled };
}

const authority: DelegatedAuthority = { mode: "work", posture: "approval-gated" };
const input: Parameters<PeerDelegationHost["startThread"]>[0] = {
  requestId: decodeRequestId("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
  senderName: "Laptop A",
  projectId: PROJECT,
  task: "Summarize the notes.\nThen list the open questions.",
  authority,
};

describe("the Work thread a delegation becomes on the receiving spoke", () => {
  it("creates an ordinary Work thread in the Project and asks before every edit", async () => {
    const { host, executed, firstTurns } = services();

    const started = await host.startThread(input);

    expect(started).toEqual({
      status: "started",
      threadId: THREAD,
      turnId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    expect(firstTurns[0]?.command).toMatchObject({
      turnId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    expect(executed[0]).toMatchObject({
      kind: "create-work-thread",
      projectId: PROJECT,
      title: "Laptop A: Summarize the notes.",
      providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      modelId: "model-a",
      workingDirectory: ".",
    });
    expect(firstTurns[0]?.command).toMatchObject({
      kind: "start-work-thread-turn",
      prompt: input.task,
      authority: { confinementPosture: "project-root-confined", workingDirectory: "." },
    });
    expect(firstTurns[0]?.options).toEqual({ holdAskFirst: true });
  });

  it("offers a Work Project only Work, and a Code Project no mode, so the clamp refuses Code", () => {
    expect(services().host.projectAuthority(PROJECT)).toEqual({
      projectId: PROJECT,
      modes: ["work"],
      ceiling: "approval-gated",
    });
    expect(
      services({ readProject: () => project("code") }).host.projectAuthority(PROJECT),
    ).toMatchObject({ modes: [] });
    expect(
      services({ readProject: () => project("chat") }).host.projectAuthority(PROJECT),
    ).toBeUndefined();
    expect(
      services({ readProject: () => project("work", "archived") }).host.projectAuthority(PROJECT),
    ).toBeUndefined();
  });

  it("refuses what Work cannot run: a read-only posture, a named profile, a Code request, or no default provider", async () => {
    const { host, executed } = services();

    expect(
      await host.startThread({ ...input, authority: { mode: "work", posture: "plan" } }),
    ).toEqual({ status: "refused", kind: "posture-unavailable" });
    expect(
      await host.startThread({
        ...input,
        authority: {
          mode: "work",
          posture: "approval-gated",
          profileId: decodeProfileId("ffffffff-ffff-4fff-8fff-ffffffffffff"),
        },
      }),
    ).toEqual({ status: "refused", kind: "provider-unavailable" });
    expect(
      await host.startThread({ ...input, authority: { mode: "code", posture: "approval-gated" } }),
    ).toEqual({ status: "refused", kind: "mode-unavailable" });
    const noDefault = services({
      threads: { execute: async () => ({}), bootstrap: async () => ({ settings: undefined }) },
    });
    expect(await noDefault.host.startThread(input)).toEqual({
      status: "refused",
      kind: "provider-unavailable",
    });
    expect(executed).toEqual([]);
    expect(noDefault.executed).toEqual([]);
  });

  it("refuses a delegation and starts nothing while Work is turned off on this host", async () => {
    let workOn = false;
    const { host, executed, firstTurns } = services({ isWorkEnabled: () => workOn });

    expect(host.projectAuthority(PROJECT)).toBeUndefined();
    expect(await host.startThread(input)).toEqual({ status: "refused", kind: "mode-unavailable" });
    expect(executed).toEqual([]);
    expect(firstTurns).toEqual([]);

    workOn = true;
    expect(host.projectAuthority(PROJECT)).toMatchObject({ modes: ["work"] });
    expect(await host.startThread(input)).toMatchObject({ status: "started" });
  });

  it("starts no turn when Work is turned off after the thread was created", async () => {
    let workOn = true;
    const created: unknown[] = [];
    const { host, firstTurns } = services({
      isWorkEnabled: () => workOn,
      threads: {
        execute: async (_scope, command) => {
          created.push(command);
          workOn = false;
          return { kind: "thread-created", thread: { id: THREAD } };
        },
        bootstrap: async () => ({
          settings: {
            defaultProviderInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            defaultModelId: "model-a",
          },
        }),
      },
    });

    expect(await host.startThread(input)).toEqual({ status: "refused", kind: "mode-unavailable" });
    expect(created).toHaveLength(1);
    expect(firstTurns).toEqual([]);
  });

  it("reports the child's state and final message as its turn has them, and interrupts only a turn still going", async () => {
    const running = services();
    expect(await running.host.readThread(THREAD, DELEGATED_TURN)).toMatchObject({
      state: "running",
      artifacts: [],
    });
    expect(await running.host.interrupt(THREAD, DELEGATED_TURN)).toBe("interrupted");
    expect(running.cancelled).toHaveLength(1);

    const waiting = services({
      turns: { ...baseTurns(), turns: async () => [turn("waiting")] },
    });
    expect(await waiting.host.readThread(THREAD, DELEGATED_TURN)).toMatchObject({
      state: "waiting-for-approval",
    });

    const finished = services({
      turns: { ...baseTurns(), turns: async () => [turn("completed", "All done.")] },
    });
    expect(await finished.host.readThread(THREAD, DELEGATED_TURN)).toMatchObject({
      state: "completed",
      finalMessage: "All done.",
    });
    expect(await finished.host.interrupt(THREAD, DELEGATED_TURN)).toBe("already-finished");
  });

  it("keeps reporting the delegated turn's own outcome after a person continues the thread", async () => {
    const { host } = services({
      turns: {
        ...baseTurns(),
        turns: async () => [
          turn("completed", "All done."),
          turn("running", "Working on the follow-up.", FOLLOW_UP_TURN),
        ],
      },
    });

    expect(await host.readThread(THREAD, DELEGATED_TURN)).toMatchObject({
      state: "completed",
      finalMessage: "All done.",
    });
  });

  it("never interrupts a person's follow-up turn when the delegated turn already finished", async () => {
    const cancelled: unknown[] = [];
    const { host } = services({
      turns: recordingTurns(
        [turn("completed", "All done."), turn("running", undefined, FOLLOW_UP_TURN)],
        cancelled,
      ),
    });

    expect(await host.interrupt(THREAD, DELEGATED_TURN)).toBe("already-finished");
    expect(cancelled).toEqual([]);
  });

  it("interrupts the delegated turn itself while a follow-up waits behind it", async () => {
    const cancelled: unknown[] = [];
    const { host } = services({
      turns: recordingTurns(
        [turn("running"), turn("accepted", undefined, FOLLOW_UP_TURN)],
        cancelled,
      ),
    });

    expect(await host.interrupt(THREAD, DELEGATED_TURN)).toBe("interrupted");
    expect(cancelled).toEqual([expect.objectContaining({ turnId: DELEGATED_TURN })]);
  });

  it("reports a delegated turn that is no longer on the thread as unavailable", async () => {
    const { host } = services({
      turns: { ...baseTurns(), turns: async () => [turn("running", undefined, FOLLOW_UP_TURN)] },
    });

    expect(await host.readThread(THREAD, DELEGATED_TURN)).toBeUndefined();
    expect(await host.interrupt(THREAD, DELEGATED_TURN)).toBe("unavailable");
  });
});

/** The thread's turns as given, with every cancel the host sends kept in `cancelled`. */
function recordingTurns(
  turns: ReadonlyArray<DelegationTurnFacts>,
  cancelled: unknown[],
): WorkDelegationServices["turns"] {
  return {
    ...baseTurns(),
    turns: async () => turns,
    cancelFirstTurn: async (_scope, command) => {
      cancelled.push(command);
      return { kind: "turn-cancelled" };
    },
  };
}

function baseTurns(): WorkDelegationServices["turns"] {
  return {
    startFirstTurn: async () => ({ kind: "accepted" }),
    turns: async () => [],
    cancelFirstTurn: async () => ({ kind: "turn-cancelled" }),
  };
}
