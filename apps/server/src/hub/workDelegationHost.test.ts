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

function turn(status: DelegationTurnFacts["status"], response?: string): DelegationTurnFacts {
  return {
    requestId: decodeWorkTurnRequestId("77777777-7777-4777-8777-777777777777"),
    threadId: decodeThreadId("88888888-8888-4888-8888-888888888888"),
    turnId: decodeWorkTurnId("99999999-9999-4999-8999-999999999999"),
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

    expect(started).toEqual({ status: "started", threadId: THREAD });
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

  it("reports the child's state and final message as its turn has them, and interrupts only a turn still going", async () => {
    const running = services();
    expect(await running.host.readThread(THREAD)).toMatchObject({
      state: "running",
      artifacts: [],
    });
    expect(await running.host.interrupt(THREAD)).toBe("interrupted");
    expect(running.cancelled).toHaveLength(1);

    const waiting = services({
      turns: { ...baseTurns(), turns: async () => [turn("waiting")] },
    });
    expect(await waiting.host.readThread(THREAD)).toMatchObject({ state: "waiting-for-approval" });

    const finished = services({
      turns: { ...baseTurns(), turns: async () => [turn("completed", "All done.")] },
    });
    expect(await finished.host.readThread(THREAD)).toMatchObject({
      state: "completed",
      finalMessage: "All done.",
    });
    expect(await finished.host.interrupt(THREAD)).toBe("already-finished");
  });
});

function baseTurns(): WorkDelegationServices["turns"] {
  return {
    startFirstTurn: async () => ({ kind: "accepted" }),
    turns: async () => [],
    cancelFirstTurn: async () => ({ kind: "turn-cancelled" }),
  };
}
