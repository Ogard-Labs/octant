import {
  decodeCodeEvidenceReference,
  decodeCodeOperationEventFrame,
  decodeCodeRuntimeWork,
  decodeCodeThread,
  decodeWindowId,
  type CodeEvidenceReference,
  type CodeOperationEventFrame,
  type CodeThread,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ProjectedCodeRuntimeWork } from "../persistence/codeProjection";
import { CodeTurnDecisions } from "./codeTurnDecisions";

const now = "2026-10-09T09:00:00.000Z";
const ended = "2026-10-09T09:05:00.000Z";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000a01");
const threadId = "00000000-0000-4000-8000-000000000a02";
const checkoutId = "00000000-0000-4000-8000-000000000a03";
const asking = "00000000-0000-4000-8000-000000000a04";
const decisionBlock =
  '```octant-decision\n{"ask":"Merge it now?","options":[{"label":"Merge it","recommended":true},{"label":"Hold"}]}\n```';

describe("Code turn decisions", () => {
  it("lists the ask a finished turn's message content closes with", async () => {
    const { decisions } = fixture({ message: [`Checks are green.\n\n`, decisionBlock] });
    expect(await decisions.listForWindow(windowId)).toEqual([
      {
        mode: "code",
        kind: "decision",
        projectId: thread().projectId,
        threadId,
        threadTitle: "Parser fix",
        requestedAt: ended,
        text: "Merge it now?",
        options: [
          { label: "Merge it", recommended: true },
          { label: "Hold", recommended: false },
        ],
        answer: { threadId, checkoutId, operationId: asking },
      },
    ]);
  });

  it("raises nothing from reasoning or any content outside the reply", async () => {
    const { decisions } = fixture({
      message: ["Done, nothing needs you."],
      reasoning: decisionBlock,
    });
    expect(await decisions.listForWindow(windowId)).toEqual([]);
  });

  it("lists nothing for a thread that is archived, completed, or snoozed", async () => {
    for (const rest of [
      { lifecycle: "archived" as const },
      { completedAt: now },
      { snooze: { until: "2026-10-10T09:00:00.000Z", at: now } },
    ]) {
      const { decisions } = fixture({ message: [decisionBlock], thread: rest });
      expect(await decisions.listForWindow(windowId)).toEqual([]);
    }
  });

  it("lists nothing on a thread whose next turn this window's send command would refuse", async () => {
    const { decisions, sources } = fixture({ message: [decisionBlock], admitted: false });
    expect(await decisions.listForWindow(windowId)).toEqual([]);
    expect(sources.admitsTurn).toHaveBeenCalledWith(
      windowId,
      expect.objectContaining({ id: threadId }),
    );
  });

  it("lists nothing once a newer turn has started", async () => {
    const { decisions } = fixture({ message: [decisionBlock], newerTurn: "running" });
    expect(await decisions.listForWindow(windowId)).toEqual([]);
  });

  it("reads a finished reply once and reads again after a reply it could not read", async () => {
    const { decisions, sources } = fixture({ message: [decisionBlock] });
    await decisions.listForWindow(windowId);
    await decisions.listForWindow(windowId);
    expect(sources.replay).toHaveBeenCalledOnce();

    const unreadable = fixture({ message: [decisionBlock], unreadable: true });
    expect(await unreadable.decisions.listForWindow(windowId)).toEqual([]);
    await unreadable.decisions.listForWindow(windowId);
    expect(unreadable.sources.replay).toHaveBeenCalledTimes(2);
  });
});

function thread(overrides: Partial<Record<string, unknown>> = {}): CodeThread {
  return decodeCodeThread({
    id: threadId,
    projectId: "00000000-0000-4000-8000-000000000a05",
    bindingRevisionId: "00000000-0000-4000-8000-000000000a06",
    repositoryId: `repo_${"a".repeat(64)}`,
    checkoutId,
    title: "Parser fix",
    lifecycle: "active",
    providerInstanceId: "00000000-0000-4000-8000-000000000a07",
    modelId: "model-a",
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/parser",
      remoteName: "origin",
      proposedBaseRepository: "octant/octant",
      proposedBaseBranch: "main",
      outcomeKind: "opened-pr",
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function fixture(options: {
  readonly message: ReadonlyArray<string>;
  readonly reasoning?: string;
  readonly thread?: Partial<Record<string, unknown>>;
  readonly newerTurn?: "running";
  readonly unreadable?: boolean;
  readonly admitted?: boolean;
}) {
  const texts = new Map<string, string>();
  let contentCounter = 0;
  const reference = (text: string): CodeEvidenceReference => {
    const contentId = `00000000-0000-4000-8000-${String(++contentCounter).padStart(12, "0")}`;
    texts.set(contentId, text);
    return decodeCodeEvidenceReference({
      contentId,
      digest: "0".repeat(64),
      byteLength: text.length,
    });
  };
  const events = [
    ...(options.reasoning === undefined
      ? []
      : [
          { kind: "provider-content", channel: "reasoning", content: reference(options.reasoning) },
        ]),
    ...options.message.map((text) => ({
      kind: "provider-content",
      channel: "message",
      content: reference(text),
    })),
    { kind: "operation-state", state: "completed" },
  ];
  const frames: ReadonlyArray<CodeOperationEventFrame> = events.map((event, index) =>
    decodeCodeOperationEventFrame({
      threadId,
      operationId: asking,
      cursor: index + 1,
      occurredAt: ended,
      event,
    }),
  );
  const works: ReadonlyArray<ProjectedCodeRuntimeWork> = [
    {
      work: decodeCodeRuntimeWork({
        id: asking,
        threadId,
        kind: "provider-turn",
        state: "completed",
        updatedAt: ended,
      }),
      firstSequence: 10,
    },
    ...(options.newerTurn === undefined
      ? []
      : [
          {
            work: decodeCodeRuntimeWork({
              id: "00000000-0000-4000-8000-000000000a08",
              threadId,
              kind: "provider-turn",
              state: options.newerTurn,
              updatedAt: ended,
            }),
            firstSequence: 20,
          },
        ]),
  ];
  const sources = {
    threads: vi.fn(async () => [thread(options.thread)]),
    admitsTurn: vi.fn(async () => options.admitted ?? true),
    runtimeWorks: vi.fn(() => works),
    replay: vi.fn((input: { readonly afterCursor: number }) =>
      frames.filter((frame) => frame.cursor > input.afterCursor),
    ),
    readEvidence: vi.fn((content: CodeEvidenceReference) =>
      options.unreadable === true ? undefined : texts.get(String(content.contentId)),
    ),
  };
  return { decisions: new CodeTurnDecisions(sources), sources };
}
