import { describe, expect, it, vi } from "vitest";
import {
  decodeWorkTurnAccepted,
  decodeWorkTurnState,
  decodeWorkThreadId,
  decodeWorkTurnId,
  decodeWorkTurnRequestId,
  WORK_TURN_CAPABILITIES,
  type WorkTurnState,
} from "@octant/contracts";
import { WorkTurnProjection } from "../work/workTurnProjection";
import { workExternalInputReceipt } from "../work/workExternalInput";
import { automationFileContext, automationDispatchPromptText } from "./automationFileContext";
import { automationPromptDigest } from "./automationAuthorityRevalidation";
import {
  initialAutomationFileCheckpoint,
  automationSourceSnapshotDigest,
} from "./automationFileSourceState";
import { automationDefinitionFixture, AUTOMATION_TEST_IDS } from "./automationTestFixtures";
import {
  buildAutomationRunForOccurrence,
  deterministicAutomationUuid,
} from "./automationRunIdentity";
import {
  createAutomationWorkDispatchPort,
  type CreateAutomationWorkDispatchPortOptions,
} from "./automationWorkDispatchPort";
import { ROUTINE_HOST_SCOPE_ID } from "../routineHostScope";

function fixture() {
  const definition = automationDefinitionFixture({
    trigger: {
      kind: "file-arrival",
      directory: "Inbox",
      includeExtensions: [],
      excludeDirectories: [],
      settleSeconds: 2,
      automaticStartLimit: 8,
    },
    nextDueAt: null,
  });
  if (definition.binding.kind !== "work") throw new Error("Expected Work binding");
  const baseline = [{ path: "report.txt", digest: "b".repeat(64), size: 4 }];
  const checkpoint = {
    ...initialAutomationFileCheckpoint("a".repeat(64), definition.createdAt),
    baselineReady: true,
    baseline,
    baselineDigest: automationSourceSnapshotDigest(baseline),
    automaticStarts: 1,
    phase: "watching" as const,
  };
  const run = buildAutomationRunForOccurrence({
    definition,
    now: definition.createdAt,
    occurrence: {
      kind: "file-arrival",
      automationId: definition.id,
      definitionRevision: definition.definitionRevision,
      source: { checkpoint, files: ["report.txt"], automaticStartOrdinal: 1 },
    },
  });
  const context = automationFileContext(run);
  if (context === undefined) throw new Error("Expected file context");
  const threadId = decodeWorkThreadId("aa000000-0000-4000-8000-0000000000d0");
  const projection = new WorkTurnProjection();
  projection.apply(
    decodeWorkTurnAccepted({
      kind: "turn-accepted",
      requestId: run.firstTurnRequestId,
      providerSessionId: run.firstTurnRequestId,
      threadId,
      turnId: decodeWorkTurnId(
        deterministicAutomationUuid(`automation-work-turn:${run.occurrenceKey}`),
      ),
      projectId: definition.projectId,
      authority: {
        hostId: "local",
        projectId: definition.projectId,
        bindingRevisionId: definition.binding.bindingRevisionId,
        workingDirectory: ".",
        confinementPosture: "project-root-confined",
        providerInstanceId: definition.executionProfile.providerInstanceId,
        modelId: definition.executionProfile.modelId,
      },
      prompt: definition.taskPrompt,
      externalInput: workExternalInputReceipt(context),
      capabilities: WORK_TURN_CAPABILITIES,
      acceptedAt: definition.createdAt,
    }),
  );
  const turn = projection.lookup(decodeWorkTurnRequestId(run.firstTurnRequestId));
  if (turn === undefined) throw new Error("Expected acceptance");
  const prepare = vi.fn(async () => () => true);
  const mark = vi.fn(() => true);
  const start = vi.fn<CreateAutomationWorkDispatchPortOptions["turns"]["startFirstTurn"]>();
  const options: CreateAutomationWorkDispatchPortOptions = {
    threads: {
      bootstrap: async () => ({ threads: [] }),
      execute: async () => ({ kind: "unused" }),
    },
    turns: { startFirstTurn: start },
    clock: () => definition.updatedAt,
    uuid: () => AUTOMATION_TEST_IDS.run,
    readTurn: () => turn,
    prepareFileInput: prepare,
    markFileInput: mark,
  };
  const input = {
    run,
    threadId,
    firstTurnRequestId: run.firstTurnRequestId,
    promptDigest: automationPromptDigest(automationDispatchPromptText(run)),
    scopeId: ROUTINE_HOST_SCOPE_ID,
  };
  return { options, input, turn, prepare, mark, start };
}

const changed = (turn: WorkTurnState, patch: Readonly<Record<string, unknown>>) =>
  decodeWorkTurnState({ ...turn, ...patch });

describe("retained Work routine input evidence", () => {
  it.each([
    [
      "legacy acceptance",
      (turn: WorkTurnState) => {
        const { externalInput: _receipt, ...legacy } = turn;
        return decodeWorkTurnState(legacy);
      },
    ],
    [
      "different reference",
      (turn: WorkTurnState) =>
        changed(turn, { externalInput: { ...turn.externalInput, referenceId: "another-batch" } }),
    ],
    [
      "different frame",
      (turn: WorkTurnState) =>
        changed(turn, { externalInput: { ...turn.externalInput, digest: "c".repeat(64) } }),
    ],
    [
      "request",
      (turn: WorkTurnState) => changed(turn, { requestId: "aa000000-0000-4000-8000-000000000081" }),
    ],
    [
      "turn",
      (turn: WorkTurnState) => changed(turn, { turnId: "aa000000-0000-4000-8000-000000000082" }),
    ],
    [
      "thread",
      (turn: WorkTurnState) => changed(turn, { threadId: "aa000000-0000-4000-8000-000000000083" }),
    ],
    [
      "Project",
      (turn: WorkTurnState) => changed(turn, { projectId: "aa000000-0000-4000-8000-000000000084" }),
    ],
    ["fixed task", (turn: WorkTurnState) => changed(turn, { prompt: "Another task" })],
    ...[
      "hostId",
      "projectId",
      "bindingRevisionId",
      "workingDirectory",
      "providerInstanceId",
      "modelId",
    ].map(
      (field) =>
        [
          field,
          (turn: WorkTurnState) =>
            changed(turn, {
              authority: {
                ...turn.authority,
                [field]:
                  field === "workingDirectory"
                    ? "another-folder"
                    : ["projectId", "bindingRevisionId", "providerInstanceId"].includes(field)
                      ? "aa000000-0000-4000-8000-000000000085"
                      : "another-owner",
              },
            }),
        ] as const,
    ),
  ] as const)("does not adopt %s or prepare/deliver new input", async (_label, alter) => {
    const f = fixture();
    const port = createAutomationWorkDispatchPort({ ...f.options, readTurn: () => alter(f.turn) });
    expect(await port.startOrRecoverFirstTurn(f.input)).toMatchObject({
      kind: "failed",
      reason: "recovery-failed",
      message: expect.stringContaining("unconfirmed"),
    });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.mark).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });

  it("refuses absent host evidence capability and stale prompt evidence before any source access", async () => {
    const f = fixture();
    const { readTurn: _reader, ...withoutReader } = f.options;
    expect(
      await createAutomationWorkDispatchPort(withoutReader).startOrRecoverFirstTurn(f.input),
    ).toMatchObject({ kind: "failed", reason: "recovery-failed" });
    expect(
      await createAutomationWorkDispatchPort(f.options).startOrRecoverFirstTurn({
        ...f.input,
        promptDigest: automationPromptDigest("obsolete task"),
      }),
    ).toMatchObject({ kind: "failed", reason: "recovery-failed" });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });

  it.each(["accepted", "ambiguous"] as const)(
    "does not claim new %s input without a returned receipt",
    async (kind) => {
      const f = fixture();
      f.start.mockResolvedValue({ kind, turn: { requestId: f.input.firstTurnRequestId } });
      const outcome = await createAutomationWorkDispatchPort({
        ...f.options,
        readTurn: () => undefined,
      }).startOrRecoverFirstTurn(f.input);
      expect(outcome).toMatchObject({
        kind: "failed",
        reason: "recovery-failed",
        message: expect.stringContaining("unconfirmed"),
      });
      expect(f.start).toHaveBeenCalledOnce();
      expect(f.mark).toHaveBeenCalledOnce();
    },
  );
  it.each(["missing", "different authority"] as const)(
    "does not adopt a concurrent acceptance with %s persisted proof",
    async (change) => {
      const f = fixture();
      const read = vi
        .fn<(requestId: WorkTurnState["requestId"]) => WorkTurnState | undefined>()
        .mockReturnValueOnce(undefined)
        .mockReturnValue(
          change === "missing"
            ? undefined
            : changed(f.turn, { authority: { ...f.turn.authority, modelId: "another-model" } }),
        );
      f.start.mockResolvedValue({ kind: "accepted", turn: f.turn });
      expect(
        await createAutomationWorkDispatchPort({
          ...f.options,
          readTurn: read,
        }).startOrRecoverFirstTurn(f.input),
      ).toMatchObject({ kind: "failed", reason: "recovery-failed" });
      expect(f.start).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledTimes(2);
    },
  );
});
