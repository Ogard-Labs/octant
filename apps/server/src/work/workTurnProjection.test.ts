import { WORK_TURN_CAPABILITIES, decodeWorkTurnRequestId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  AGENT_RESULT_STEERED,
  AGENT_RESULT_STEERING_AGGREGATE_TYPE,
} from "../agentRun/agentResultSteeredRecord";
import { WorkTurnProjection, hydrateWorkTurnProjectionFromJournal } from "./workTurnProjection";

const ids = {
  request: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  turn: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  thread: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  project: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  binding: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  provider: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  session: "11111111-1111-4111-8111-111111111111",
  run: "22222222-2222-4222-8222-222222222222",
} as const;
const now = "2026-08-11T12:00:00.000Z";

const steered = {
  kind: "agent-result-steered",
  threadId: ids.thread,
  turnKey: ids.request,
  delivery: {
    kind: "agent-result",
    runId: ids.run,
    runIds: [ids.run],
    runGenerations: [{ runId: ids.run, generation: 1 }],
  },
  body: "A delegated subagent has finished.",
  steeredAt: now,
} as const;

const rows = [
  {
    globalSequence: 1,
    aggregateType: "work-turn",
    eventName: "work.turn-accepted@1",
    eventVersion: 1,
    payload: {
      kind: "turn-accepted",
      requestId: ids.request,
      threadId: ids.thread,
      turnId: ids.turn,
      projectId: ids.project,
      authority: {
        hostId: "local",
        projectId: ids.project,
        bindingRevisionId: ids.binding,
        workingDirectory: ".",
        confinementPosture: "project-root-confined",
        providerInstanceId: ids.provider,
        modelId: "gpt-5",
      },
      providerSessionId: ids.session,
      prompt: "Delegate the review",
      capabilities: WORK_TURN_CAPABILITIES,
      acceptedAt: now,
    },
  },
  {
    globalSequence: 2,
    aggregateType: AGENT_RESULT_STEERING_AGGREGATE_TYPE,
    eventName: AGENT_RESULT_STEERED,
    eventVersion: 1,
    payload: steered,
  },
  // The turn ends after the result entered it; the card stays.
  {
    globalSequence: 3,
    aggregateType: "work-turn",
    eventName: "work.turn-updated@1",
    eventVersion: 1,
    payload: {
      kind: "turn-updated",
      requestId: ids.request,
      threadId: ids.thread,
      turnId: ids.turn,
      status: "completed",
      response: "Done.",
      updatedAt: now,
    },
  },
  // The same delivery read again shows once.
  {
    globalSequence: 4,
    aggregateType: AGENT_RESULT_STEERING_AGGREGATE_TYPE,
    eventName: AGENT_RESULT_STEERED,
    eventVersion: 1,
    payload: steered,
  },
];

describe("a Work turn's steered child results", () => {
  it("rebuild onto the turn they entered from the journal, once each", () => {
    const projection = new WorkTurnProjection();
    expect(
      hydrateWorkTurnProjectionFromJournal({
        replay: (cursor) =>
          rows.filter(
            (row) =>
              row.globalSequence > cursor.afterSequence &&
              (cursor.aggregateType === undefined || row.aggregateType === cursor.aggregateType),
          ),
        projection,
      }),
    ).toBe("ok");

    const turn = projection.lookup(decodeWorkTurnRequestId(ids.request));
    expect(turn?.status).toBe("completed");
    expect(turn?.steeredResults).toEqual([
      { delivery: steered.delivery, body: steered.body, steeredAt: now },
    ]);
  });
});
