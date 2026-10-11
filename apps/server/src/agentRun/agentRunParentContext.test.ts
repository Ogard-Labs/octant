import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeEvidenceStore } from "../code/codeEvidenceStore";
import {
  CODE_OPERATION_EVENT_RECORDED,
  CodeOperationEventStore,
} from "../code/codeOperationEventStore";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { CodeProjection, readCodeThreadActivity } from "../persistence/codeProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import {
  ActorId,
  CodeOperationEventFrame,
  decodeAgentRunAdmittedContext,
  decodeCodeConversationTurn,
  decodeCodeEvidenceReference,
  decodeCodeOperationEvent,
  decodeCodeOperationId,
  decodeCodeThreadId,
  decodeProjectId,
  decodeWorkThreadId,
  decodeWorkTurnState,
  MAX_AGENT_RUN_ADMITTED_CONTEXT_BLOCKS,
  type CodeConversationPage,
  type CodeEvidenceReference,
  type WorkTurnState,
} from "@octant/contracts";
import {
  admittedParentCodeContext,
  admittedParentWorkContext,
  MAX_PARENT_CONTEXT_SOURCE_BYTES,
  MAX_PARENT_CONTEXT_CODE_PAGES,
} from "./agentRunParentContext";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = decodeProjectId(id(1));
const workThreadId = decodeWorkThreadId(id(2));
const codeThreadId = decodeCodeThreadId(id(3));
const at = "2026-10-03T10:00:00.000Z";
const workThread = {
  id: workThreadId,
  projectId,
  version: 1 as never,
  lifecycle: "active" as const,
};
const codeThread = {
  id: codeThreadId,
  projectId,
  version: 1 as never,
  lifecycle: "active" as const,
};

function workTurn(n: number, status: WorkTurnState["status"] = "completed") {
  return decodeWorkTurnState({
    requestId: id(100 + n),
    turnId: id(200 + n),
    threadId: workThreadId,
    projectId,
    authority: {
      hostId: "local",
      projectId,
      bindingRevisionId: id(4),
      workingDirectory: ".",
      confinementPosture: "project-root-confined",
      providerInstanceId: id(5),
      modelId: "model",
    },
    status,
    prompt: `question ${n}`,
    response: `answer ${n}`,
    transcript: [
      { role: "user", text: `question ${n}` },
      { role: "assistant", text: `answer ${n}`, status },
    ],
    capabilities: {
      workspace: "project-backed",
      confinement: "project-root-confined",
      shell: "denied",
      git: "denied",
      worktree: "denied",
      pullRequest: "denied",
      code: "denied",
    },
    version: 2,
    acceptedAt: at,
    updatedAt: at,
  });
}
function evidence(n: number, overrides: Partial<CodeEvidenceReference> = {}) {
  return decodeCodeEvidenceReference({
    contentId: id(n),
    digest: "a".repeat(64),
    byteLength: 20,
    ...overrides,
  });
}
function codeTurn(n: number, status = "completed") {
  return decodeCodeConversationTurn({
    operationId: id(300 + n),
    providerInstanceId: id(5),
    modelId: "model",
    sessionId: id(6),
    prompt: evidence(400 + n),
    assistant: [evidence(500 + n)],
    steps: [{ kind: "reasoning", content: evidence(600 + n) }],
    status,
    startedAt: at,
    updatedAt: at,
  });
}
function codeInput(turns = [codeTurn(1), codeTurn(2, "incomplete")]) {
  return {
    threadId: codeThreadId,
    externalContentIngested: false,
    readThread: () => codeThread,
    readActivity: () => ({ threadId: codeThreadId, lastSequence: 20 as never }),
    conversation: (): CodeConversationPage => ({
      version: 3,
      threadId: codeThreadId,
      turns,
      nextCursor: 10,
      hasMore: false,
    }),
    readEvidence: vi.fn(
      (reference: CodeEvidenceReference): string | undefined => `body ${reference.contentId}`,
    ),
  };
}

describe("admitted parent context", () => {
  it("includes accepted Work prompts and completed replies with durable source attribution", () => {
    const turns = [workTurn(1), workTurn(2, "failed"), workTurn(3, "running")];
    const result = admittedParentWorkContext({
      threadId: workThreadId,
      externalContentIngested: true,
      readThread: () => workThread,
      readTurns: () => turns,
    });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.blocks.map((block) => block.kind)).toEqual([
      "conversation-summary",
      "user-message",
      "assistant-message",
      "user-message",
      "user-message",
    ]);
    expect(result.blocks[1]?.text).toContain(id(201));
    expect(result.blocks[1]?.text).toContain("question 1");
    expect(JSON.stringify(result.blocks)).not.toContain("answer 2");
    expect(JSON.stringify(result.blocks)).not.toContain("answer 3");
    expect(result.source).toMatchObject({
      mode: "work",
      threadId: workThreadId,
      projectId,
      externalContentIngested: true,
    });
    expect(result.omissions.unfinishedReplies).toBe(2);
    expect(result.blocks[0]?.text).toContain(
      "Native provider sessions and hidden reasoning are not transferred",
    );
    expect(decodeAgentRunAdmittedContext(result.blocks)).toEqual(result.blocks);
  });
  it("reads only Code prompts and completed message evidence, never reasoning or partial replies", () => {
    const input = codeInput();
    const result = admittedParentCodeContext(input);
    expect(result.status).toBe("available");
    expect(input.readEvidence.mock.calls.map(([ref]) => ref.contentId)).toEqual([
      id(401),
      id(501),
      id(402),
    ]);
    if (result.status !== "available") return;
    expect(result.source).toMatchObject({
      mode: "code",
      threadId: codeThreadId,
      projectId,
      point: { lastSequence: 20, conversationCursor: 10 },
    });
    expect(result.blocks[1]?.text).toContain(id(401));
    expect(result.blocks[1]?.text).toContain(id(301));
    expect(result.omissions.unfinishedReplies).toBe(1);
  });
  it("refuses foreign threads, Projects and pages before reading source bodies", () => {
    const input = codeInput();
    const foreign = decodeCodeThreadId(id(99));
    expect(
      admittedParentCodeContext({ ...input, readThread: () => ({ ...codeThread, id: foreign }) }),
    ).toMatchObject({ status: "unavailable", reason: "foreign-thread" });
    expect(
      admittedParentCodeContext({
        ...input,
        conversation: () => ({ ...input.conversation(), threadId: foreign }),
      }),
    ).toMatchObject({ status: "unavailable", reason: "foreign-thread" });
    expect(input.readEvidence).not.toHaveBeenCalled();
    const readTurns = vi.fn(() => [workTurn(1)]);
    expect(
      admittedParentWorkContext({
        threadId: workThreadId,
        externalContentIngested: false,
        readThread: () => undefined,
        readTurns,
      }),
    ).toMatchObject({ status: "unavailable", reason: "thread-unavailable" });
    expect(readTurns).not.toHaveBeenCalled();
    expect(
      admittedParentWorkContext({
        threadId: workThreadId,
        externalContentIngested: false,
        readThread: () => workThread,
        readTurns: () => [{ ...workTurn(1), projectId: decodeProjectId(id(98)) }],
      }),
    ).toMatchObject({ status: "unavailable", reason: "foreign-project" });
  });
  it("keeps the recent window within both contract bounds and discloses lost text", () => {
    const turns = Array.from({ length: 20 }, (_, n) => ({
      ...workTurn(n),
      prompt: "😀".repeat(4_000),
    }));
    const result = admittedParentWorkContext({
      threadId: workThreadId,
      externalContentIngested: false,
      readThread: () => workThread,
      readTurns: () => turns,
    });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.blocks).toHaveLength(24);
    expect(
      result.blocks.every((block) => block.text.length <= 4_000 && block.text.isWellFormed()),
    ).toBe(true);
    expect(result.omissions.earlierMessages).toBe(17);
    expect(result.omissions.truncatedMessages).toBeGreaterThan(0);
    expect(result.omissions.truncatedCharacters).toBeGreaterThan(0);
    expect(result.blocks.some((block) => block.text.includes("characters omitted"))).toBe(true);
    expect(result.blocks.at(-1)?.text).toContain("answer 19");
    expect(decodeAgentRunAdmittedContext(result.blocks)).toEqual(result.blocks);
  });
  it("discloses missing, oversized and already-truncated Code bodies without reading oversized evidence", () => {
    const turn = codeTurn(1);
    const oversized = evidence(502, { byteLength: MAX_PARENT_CONTEXT_SOURCE_BYTES + 1 });
    const input = codeInput([
      {
        ...turn,
        prompt: { ...turn.prompt, truncated: true },
        assistant: [evidence(501), oversized],
      },
    ]);
    input.readEvidence.mockImplementation((ref) =>
      ref.contentId === turn.prompt.contentId ? "readable prompt" : undefined,
    );
    const result = admittedParentCodeContext(input);
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.omissions).toMatchObject({
      missingBodies: 1,
      oversizedBodies: 1,
      sourceTruncatedMessages: 1,
    });
    expect(result.blocks[0]?.text).toContain('"missingBodies":1');
    expect(result.blocks[1]?.text).toContain("source body was already truncated");
    expect(
      input.readEvidence.mock.calls.some(([ref]) => ref.contentId === oversized.contentId),
    ).toBe(false);
  });
  it("refuses unstable snapshots and a Code page sequence that stops advancing", () => {
    const input = codeInput();
    let reads = 0;
    expect(
      admittedParentCodeContext({
        ...input,
        readActivity: () => ({ threadId: codeThreadId, lastSequence: (++reads + 20) as never }),
      }),
    ).toMatchObject({ status: "unavailable", reason: "source-changed" });
    expect(
      admittedParentCodeContext({
        ...input,
        conversation: () => ({ ...input.conversation(), hasMore: true, nextCursor: 0 }),
      }),
    ).toMatchObject({ status: "unavailable", reason: "invalid-page" });
    let workReads = 0;
    expect(
      admittedParentWorkContext({
        threadId: workThreadId,
        externalContentIngested: false,
        readThread: () => workThread,
        readTurns: () => [{ ...workTurn(1), version: ++workReads as never }],
      }),
    ).toMatchObject({ status: "unavailable", reason: "source-changed" });
  });
  it("selects the newest Code page with source references intact and skips failed Work entries inside a completed turn", () => {
    const input = codeInput();
    const calls: number[] = [];
    const result = admittedParentCodeContext({
      ...input,
      conversation: ({ afterCursor }) => {
        calls.push(afterCursor);
        return {
          version: 3,
          threadId: codeThreadId,
          turns: afterCursor === 0 ? [codeTurn(1)] : [codeTurn(2)],
          nextCursor: afterCursor === 0 ? 10 : 20,
          hasMore: afterCursor === 0,
        };
      },
    });
    expect(calls).toEqual([0, 10]);
    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.blocks.at(-1)?.text).toContain(id(502));
      expect(result.source.point).toMatchObject({ conversationCursor: 20 });
    }
    const turn = workTurn(1);
    const selected = admittedParentWorkContext({
      threadId: workThreadId,
      externalContentIngested: false,
      readThread: () => workThread,
      readTurns: () => [
        {
          ...turn,
          transcript: [
            { role: "assistant", text: "abandoned", status: "failed" },
            { role: "assistant", text: "accepted", status: "completed" },
          ],
        },
      ],
    });
    expect(selected.status).toBe("available");
    if (selected.status === "available") {
      expect(JSON.stringify(selected.blocks)).not.toContain("abandoned");
      expect(selected.blocks.at(-1)?.text).toContain("accepted");
      expect(selected.omissions.unfinishedReplies).toBe(1);
    }
  });

  it("refuses histories beyond its bounded Code scan instead of mislabelling old turns as recent", () => {
    const input = codeInput();
    let pages = 0;
    const result = admittedParentCodeContext({
      ...input,
      conversation: () => ({
        version: 3,
        threadId: codeThreadId,
        turns: [codeTurn(++pages)],
        nextCursor: pages,
        hasMore: true,
      }),
    });
    expect(result).toMatchObject({ status: "unavailable", reason: "history-window-exceeded" });
    expect(pages).toBe(MAX_PARENT_CONTEXT_CODE_PAGES);
    expect(input.readEvidence).not.toHaveBeenCalled();
  });
  it("is deterministic for the same source and refuses when every body is purged", () => {
    const input = codeInput();
    expect(admittedParentCodeContext(input)).toEqual(admittedParentCodeContext(input));
    input.readEvidence.mockReturnValue(undefined);
    expect(admittedParentCodeContext(input)).toMatchObject({
      status: "unavailable",
      reason: "source-empty",
    });
    expect(admittedParentCodeContext({ ...input, readActivity: () => undefined })).toMatchObject({
      status: "unavailable",
      reason: "source-point-unavailable",
    });
  });
});

const journalDirectories: string[] = [];
afterEach(() => {
  for (const directory of journalDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("a Code parent's context during its own turn", () => {
  it("resolves the conversation the parent has journaled while its turn is still running", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-parent-context-"));
    journalDirectories.push(directory);
    const connection = openSqlite(join(directory, "events.sqlite3"));
    const occurredAt = "2026-10-05T17:35:00.000Z";
    applyMigrations(connection, MIGRATIONS, () => occurredAt);
    const journal = new Journal({
      connection,
      registry: new EventRegistry().register(
        CODE_OPERATION_EVENT_RECORDED,
        1,
        CodeOperationEventFrame,
      ),
      projections: new ProjectionRegistry()
        .register(new AggregateHeadsProjection())
        .register(new CodeProjection()),
      clock: () => occurredAt,
    });
    let counter = 0;
    const store = new CodeOperationEventStore({
      journal,
      actor: {
        kind: "system",
        actorId: Schema.decodeUnknownSync(ActorId)(id(900)),
      },
      clock: () => occurredAt,
      uuid: () => id(1_000 + counter++),
    });
    const evidence = new CodeEvidenceStore({ connection });
    const operationId = decodeCodeOperationId(id(10));
    let cursor = 0;
    const append = (event: Record<string, unknown>) =>
      store.append({
        threadId: codeThreadId,
        operationId,
        expectedCursor: cursor++,
        event: decodeCodeOperationEvent(event),
      });
    append({
      kind: "conversation-turn-started",
      providerInstanceId: id(40),
      modelId: "gpt-6-astra",
      sessionId: id(50),
      prompt: evidence.put("Delegate a short plan to a helper."),
    });
    append({
      kind: "provider-content",
      channel: "message",
      content: evidence.put("I will ask a helper."),
    });
    // The delegation itself is a tool call the parent has started and not yet
    // finished, so its own turn is exactly what the child must read.
    append({
      kind: "tool-activity",
      toolCallId: id(60),
      toolName: "octant_agents",
      state: "started",
    });
    append({
      kind: "tool-activity",
      toolCallId: id(60),
      toolName: "octant_agents",
      state: "running",
      summary: "delegate",
    });

    const selection = admittedParentCodeContext({
      threadId: codeThreadId,
      externalContentIngested: false,
      readThread: () => codeThread,
      readActivity: (threadId) =>
        readCodeThreadActivity(connection).find(
          (activity) => String(activity.threadId) === String(threadId),
        ),
      conversation: (input) => store.conversation(input),
      readEvidence: (reference) => evidence.read(reference),
    });

    expect(selection.status).toBe("available");
    if (selection.status !== "available") return;
    expect(selection.blocks.map((block) => block.kind)).toEqual([
      "conversation-summary",
      "user-message",
    ]);
    expect(selection.blocks[1]?.text).toContain("Delegate a short plan to a helper.");
    // The unfinished reply is disclosed as omitted, never handed over as if the
    // parent had accepted it.
    expect(selection.omissions.unfinishedReplies).toBe(1);
    connection.close();
  });
});

describe("a provider switch reading its own thread's conversation", () => {
  it("frames the excerpts as this thread's history and leaves out the switching turn", () => {
    const switching = codeTurn(3, "incomplete");
    const oversized = evidence(502, { byteLength: MAX_PARENT_CONTEXT_SOURCE_BYTES + 1 });
    const input = codeInput([codeTurn(1), { ...codeTurn(2), assistant: [oversized] }, switching]);
    const result = admittedParentCodeContext({
      ...input,
      purpose: "provider-switch",
      excludeOperationId: String(switching.operationId),
    });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.blocks[0]?.text).toContain("this thread's earlier conversation");
    expect(result.blocks[0]?.text).not.toContain("parent conversation");
    expect(
      result.blocks
        .slice(1)
        .every((block) => block.text.startsWith("Earlier conversation source:")),
    ).toBe(true);
    // The switching turn's prompt goes to the provider as the prompt; its
    // unfinished reply is not history either, so neither is counted.
    expect(
      input.readEvidence.mock.calls.some(([ref]) => ref.contentId === switching.prompt.contentId),
    ).toBe(false);
    expect(result.omissions).toMatchObject({ oversizedBodies: 1, unfinishedReplies: 0 });
    expect(result.blocks).toHaveLength(4);
  });
});

describe("a fork reading the thread it was forked from", () => {
  it("selects only through the reply the fork was made at", () => {
    const later = codeTurn(3);
    const input = codeInput([codeTurn(1), codeTurn(2), later]);
    const result = admittedParentCodeContext({
      ...input,
      purpose: "fork",
      throughOperationId: String(codeTurn(2).operationId),
    });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.blocks[0]?.text).toContain("forked from, through the reply it was forked at");
    expect(
      result.blocks.slice(1).every((block) => block.text.startsWith("Forked conversation source:")),
    ).toBe(true);
    // A later turn of the source is a direction the fork did not take.
    expect(
      input.readEvidence.mock.calls.some(
        ([ref]) =>
          ref.contentId === later.prompt.contentId ||
          ref.contentId === later.assistant[0]?.contentId,
      ),
    ).toBe(false);
    expect(result.blocks).toHaveLength(5);
    expect(result.source.point).toMatchObject({
      throughOperationId: String(codeTurn(2).operationId),
    });
  });

  it("refuses a fork point the source no longer holds rather than handing over a different window", () => {
    const result = admittedParentCodeContext({
      ...codeInput([codeTurn(1), codeTurn(2)]),
      purpose: "fork",
      throughOperationId: id(399),
    });
    expect(result).toEqual({ status: "unavailable", reason: "source-point-unavailable" });
  });

  it("keeps a read through the fork point while the source runs a later turn", () => {
    let sequence = 20;
    const input = {
      ...codeInput([codeTurn(1), codeTurn(2, "incomplete")]),
      readActivity: () => ({ threadId: codeThreadId, lastSequence: sequence++ as never }),
    };
    expect(
      admittedParentCodeContext({ ...input, throughOperationId: String(codeTurn(1).operationId) })
        .status,
    ).toBe("available");
    // The same moving source refuses a whole-thread read.
    expect(admittedParentCodeContext(input)).toEqual({
      status: "unavailable",
      reason: "source-changed",
    });
  });
});

describe("a fork's conversation merged back into the thread it was forked from", () => {
  it("selects only the fork's turns after its previous merge, through the named turn", () => {
    const input = codeInput([codeTurn(1), codeTurn(2), codeTurn(3), codeTurn(4)]);
    const result = admittedParentCodeContext({
      ...input,
      purpose: "fork-merge-back",
      afterOperationId: String(codeTurn(1).operationId),
      throughOperationId: String(codeTurn(3).operationId),
    });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.blocks[0]?.text).toContain("merged back here because the person asked");
    expect(result.blocks[0]?.text).toContain("unless they were merged through Git review");
    expect(
      result.blocks
        .slice(1)
        .every((block) => block.text.startsWith("Merged fork conversation source:")),
    ).toBe(true);
    const read = input.readEvidence.mock.calls.map(([reference]) => reference.contentId);
    expect(read).toEqual([
      codeTurn(2).prompt.contentId,
      codeTurn(2).assistant[0]?.contentId,
      codeTurn(3).prompt.contentId,
      codeTurn(3).assistant[0]?.contentId,
    ]);
    // Already-merged turns are neither carried nor counted as left out.
    expect(result.omissions.earlierMessages).toBe(0);
  });

  it("finds nothing new when the end point is not after the previous merge", () => {
    const input = codeInput([codeTurn(1), codeTurn(2)]);
    expect(
      admittedParentCodeContext({
        ...input,
        purpose: "fork-merge-back",
        afterOperationId: String(codeTurn(2).operationId),
        throughOperationId: String(codeTurn(1).operationId),
      }),
    ).toEqual({ status: "unavailable", reason: "source-empty" });
    expect(input.readEvidence).not.toHaveBeenCalled();
  });

  it("refuses a previous merge point the fork no longer holds rather than repeating turns", () => {
    expect(
      admittedParentCodeContext({
        ...codeInput([codeTurn(1), codeTurn(2)]),
        purpose: "fork-merge-back",
        afterOperationId: id(399),
      }),
    ).toEqual({ status: "unavailable", reason: "source-point-unavailable" });
  });
});

describe("a forked thread reading its conversation for a provider switch", () => {
  const sourceThreadId = decodeCodeThreadId(id(7));
  const sourceThread = { ...codeThread, id: sourceThreadId };

  function forkedInput(sourceTurns: ReturnType<typeof codeTurn>[], ownTurns = [codeTurn(21)]) {
    const turnsOf = (threadId: unknown) =>
      String(threadId) === String(sourceThreadId) ? sourceTurns : ownTurns;
    return {
      ...codeInput(ownTurns),
      purpose: "provider-switch" as const,
      readThread: (threadId: unknown) =>
        String(threadId) === String(sourceThreadId) ? sourceThread : codeThread,
      readActivity: (threadId: unknown) => ({
        threadId: String(threadId) === String(sourceThreadId) ? sourceThreadId : codeThreadId,
        lastSequence: 20 as never,
      }),
      conversation: (page: { readonly threadId: unknown }): CodeConversationPage => ({
        version: 3,
        threadId: String(page.threadId) === String(sourceThreadId) ? sourceThreadId : codeThreadId,
        turns: turnsOf(page.threadId),
        nextCursor: 10,
        hasMore: false,
      }),
    };
  }

  it("hands over the source's conversation through the fork point ahead of the fork's own turns", () => {
    const later = codeTurn(3);
    const switching = codeTurn(22, "incomplete");
    const result = admittedParentCodeContext({
      ...forkedInput([codeTurn(1), codeTurn(2), later], [codeTurn(21), switching]),
      excludeOperationId: String(switching.operationId),
      inherited: {
        threadId: sourceThreadId,
        throughOperationId: String(codeTurn(2).operationId),
        externalContentIngested: true,
      },
    });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    const messages = result.blocks.slice(1).map((block) => block.text);
    // Source turns 1 and 2, then the fork's own turn 21; never the source's
    // later turn 3 or the switching turn.
    expect(messages).toHaveLength(6);
    expect(
      messages.slice(0, 4).every((text) => text.startsWith("Forked conversation source:")),
    ).toBe(true);
    expect(messages[0]).toContain(`"threadId":"${String(sourceThreadId)}"`);
    expect(messages[0]).toContain(String(codeTurn(1).prompt.contentId));
    expect(messages.slice(4).every((text) => text.startsWith("Earlier conversation source:"))).toBe(
      true,
    );
    expect(messages[4]).toContain(String(codeTurn(21).prompt.contentId));
    expect(messages.some((text) => text.includes(String(later.prompt.contentId)))).toBe(false);
    expect(messages.some((text) => text.includes(String(switching.prompt.contentId)))).toBe(false);
    expect(result.blocks[0]?.text).toContain("This thread is a fork");
    expect(result.inherited).toMatchObject({
      messages: 4,
      source: {
        threadId: String(sourceThreadId),
        externalContentIngested: true,
        point: { throughOperationId: String(codeTurn(2).operationId) },
      },
    });
    expect(result.source).toMatchObject({
      threadId: String(codeThreadId),
      externalContentIngested: false,
    });
  });

  it("keeps the newest messages within the budget and discloses the inherited ones it left out", () => {
    const source = Array.from({ length: 15 }, (_, index) => codeTurn(index + 1));
    const own = [codeTurn(21), codeTurn(22), codeTurn(23)];
    const result = admittedParentCodeContext({
      ...forkedInput(source, own),
      inherited: {
        threadId: sourceThreadId,
        throughOperationId: String(codeTurn(15).operationId),
        externalContentIngested: false,
      },
    });
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    // 30 inherited and 6 own messages share one window of 23.
    expect(result.blocks).toHaveLength(MAX_AGENT_RUN_ADMITTED_CONTEXT_BLOCKS);
    expect(result.omissions.earlierMessages).toBe(13);
    expect(result.inherited?.messages).toBe(17);
    const messages = result.blocks.slice(1).map((block) => block.text);
    // Every one of the fork's own messages survives; the oldest inherited go first.
    expect(
      messages.slice(-6).every((text) => text.startsWith("Earlier conversation source:")),
    ).toBe(true);
    expect(messages[0]).toContain(String(codeTurn(7).assistant[0]?.contentId));
    expect(messages.some((text) => text.includes(String(codeTurn(6).prompt.contentId)))).toBe(
      false,
    );
    expect(result.blocks[0]?.text).toContain('"earlierMessages":13');
  });

  it("names the inherited source as the part it could not read", () => {
    const input = forkedInput([codeTurn(1)]);
    expect(
      admittedParentCodeContext({
        ...input,
        readThread: (threadId: unknown) =>
          String(threadId) === String(sourceThreadId) ? undefined : codeThread,
        inherited: {
          threadId: sourceThreadId,
          throughOperationId: String(codeTurn(1).operationId),
          externalContentIngested: false,
        },
      }),
    ).toEqual({ status: "unavailable", reason: "thread-unavailable", part: "inherited" });
    expect(
      admittedParentCodeContext({
        ...input,
        inherited: {
          threadId: sourceThreadId,
          throughOperationId: id(399),
          externalContentIngested: false,
        },
      }),
    ).toEqual({ status: "unavailable", reason: "source-point-unavailable", part: "inherited" });
  });

  it("refuses rather than hand over only the fork's own turns when no inherited message is readable", () => {
    const input = forkedInput([codeTurn(1)]);
    const result = admittedParentCodeContext({
      ...input,
      readEvidence: vi.fn((reference: CodeEvidenceReference) =>
        String(reference.contentId) === String(codeTurn(1).prompt.contentId) ||
        String(reference.contentId) === String(codeTurn(1).assistant[0]?.contentId)
          ? undefined
          : `body ${reference.contentId}`,
      ),
      inherited: {
        threadId: sourceThreadId,
        throughOperationId: String(codeTurn(1).operationId),
        externalContentIngested: false,
      },
    });
    expect(result).toEqual({ status: "unavailable", reason: "source-empty", part: "inherited" });
  });
});
