import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodeEvidenceStore } from "../code/codeEvidenceStore";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { rebuildProjection } from "./projection";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import { openSqlite } from "./sqlitePort";
import {
  MAX_THREAD_SEARCH_TOOL_TEXT,
  searchThreads,
  type ThreadSearchVisibleThread,
} from "./threadSearchProjection";

const directories: Array<string> = [];
const now = "2026-11-14T10:00:00.000Z";
const later = "2026-11-14T11:00:00.000Z";
const latest = "2026-11-14T12:00:00.000Z";
const ids = {
  actor: "85000000-0000-4000-8000-000000000001",
  correlation: "85000000-0000-4000-8000-000000000002",
  thread: "85000000-0000-4000-8000-000000000003",
  otherThread: "85000000-0000-4000-8000-000000000004",
  project: "85000000-0000-4000-8000-000000000005",
  binding: "85000000-0000-4000-8000-000000000006",
  checkout: "85000000-0000-4000-8000-000000000007",
  provider: "85000000-0000-4000-8000-000000000008",
  session: "85000000-0000-4000-8000-000000000009",
  terminal: "85000000-0000-4000-8000-00000000000a",
  workThread: "85000000-0000-4000-8000-00000000000b",
  workRequest: "85000000-0000-4000-8000-00000000000c",
  workTurn: "85000000-0000-4000-8000-00000000000d",
} as const;
const operation = (index: number) =>
  `85000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`;
const repositoryId = `repo_${"a".repeat(64)}`;
const code = (threadId: string, updatedAt = now): ThreadSearchVisibleThread => ({
  mode: "code",
  threadId,
  updatedAt,
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("search across modes", () => {
  it("finds every word of a search in any order, and a quoted phrase only as written", () => {
    const store = openStore();
    try {
      store.thread(ids.thread, "Release prep", now);
      store.turn(ids.thread, operation(1), "Why does the parser drop the last token?", []);
      store.turn(ids.thread, operation(2), "The token parser is fine", []);
      const visible = [code(ids.thread)];
      const anchors = (query: string) =>
        searchThreads(store.connection, query, visible, 50).matches.map((match) => match.anchorId);

      expect(anchors("token parser")).toEqual([operation(2), operation(1)]);
      expect(anchors('"token parser"')).toEqual([operation(2)]);
      expect(anchors("parser missing")).toEqual([]);
    } finally {
      store.connection.close();
    }
  });

  it("finds a word split across two streamed reply pieces, and a turn whose words sit in its prompt and its reply", () => {
    const store = openStore();
    try {
      store.thread(ids.thread, "Lexer", now);
      store.turn(ids.thread, operation(1), "Why is the build red?", [
        "The tokeni",
        "zer was wrong",
      ]);
      const visible = [code(ids.thread)];
      const found = (query: string) =>
        searchThreads(store.connection, query, visible, 50).matches.map((match) => [
          match.field,
          match.snippet,
        ]);

      expect(found("tokenizer")).toEqual([["reply", "The tokenizer was wrong"]]);
      expect(found("build tokenizer")).toEqual([["prompt", "Why is the build red?"]]);
      expect(found("build lexer")).toEqual([]);
    } finally {
      store.connection.close();
    }
  });

  it("matches thread titles first, then messages, then what tools did", () => {
    const store = openStore();
    try {
      store.thread(ids.thread, "Flaky checkout test", now);
      store.thread(ids.otherThread, "Unrelated", later);
      store.turn(ids.otherThread, operation(1), "Look at the checkout page", []);
      store.turn(ids.otherThread, operation(2), "Run the suite", []);
      store.toolActivity(ids.otherThread, operation(2), 2, "Read", "src/checkout.ts");

      const result = searchThreads(
        store.connection,
        "checkout",
        [code(ids.thread, now), code(ids.otherThread, later)],
        50,
      );

      expect(result.matches.map((match) => [match.threadId, match.field, match.anchorId])).toEqual([
        [ids.thread, "title", ""],
        [ids.otherThread, "prompt", operation(1)],
        [ids.otherThread, "tool", operation(2)],
      ]);
      expect(result.matches[0]?.matchRanges).toEqual([{ start: 6, end: 14 }]);
    } finally {
      store.connection.close();
    }
  });

  it("finds a command's terminal output, keeps only its newest text, and follows a redraw", () => {
    const store = openStore();
    try {
      store.thread(ids.thread, "Build", now);
      store.turn(ids.thread, operation(1), "Run the build", []);
      store.terminal(ids.thread, operation(1), 2, "compiling...\n");
      store.terminal(ids.thread, operation(1), 3, "error TS2345: Argument of type");
      const visible = [code(ids.thread)];
      const fields = (query: string) =>
        searchThreads(store.connection, query, visible, 50).matches.map((match) => match.field);

      expect(fields("TS2345")).toEqual(["tool"]);
      store.terminal(ids.thread, operation(1), 4, "all clear", true);
      expect(fields("TS2345")).toEqual([]);
      expect(fields("all clear")).toEqual(["tool"]);

      store.terminal(
        ids.thread,
        operation(1),
        5,
        `oldest marker ${"x".repeat(MAX_THREAD_SEARCH_TOOL_TEXT)}`,
      );
      store.terminal(ids.thread, operation(1), 6, " newest marker");
      expect(fields("oldest marker")).toEqual([]);
      expect(fields("newest marker")).toEqual(["tool"]);
    } finally {
      store.connection.close();
    }
  });

  it("searches Work and Code together and names each hit's mode and turn", () => {
    const store = openStore();
    try {
      store.thread(ids.thread, "Code side", now);
      store.turn(ids.thread, operation(1), "Ship the quarterly report", []);
      store.workThread(ids.workThread, "Work side", later);
      store.workTurn(ids.workThread, ids.workRequest, ids.workTurn, "Draft it", {
        response: "The quarterly report is attached",
        wroteFiles: ["reports/q3.md"],
      });
      const visible: ReadonlyArray<ThreadSearchVisibleThread> = [
        code(ids.thread, now),
        { mode: "work", threadId: ids.workThread, updatedAt: later },
      ];

      expect(
        searchThreads(store.connection, "quarterly report", visible, 50).matches.map((match) => [
          match.mode,
          match.field,
          match.anchorId,
        ]),
      ).toEqual([
        ["work", "reply", ids.workTurn],
        ["code", "prompt", operation(1)],
      ]);
      expect(
        searchThreads(store.connection, "q3.md", visible, 50).matches.map((match) => match.field),
      ).toEqual(["tool"]);
    } finally {
      store.connection.close();
    }
  });

  it("returns only threads the caller may see, counts only those toward the cap, and reads short words", () => {
    const store = openStore();
    try {
      store.thread(ids.thread, "Go mod tidy", latest);
      store.thread(ids.otherThread, "Go vet", later);
      store.turn(ids.thread, operation(1), "Reach 100% coverage on snake_case", []);

      const mine = [code(ids.thread, latest)];
      expect(searchThreads(store.connection, "go", mine, 50).matches).toHaveLength(1);
      expect(
        searchThreads(store.connection, "go", [...mine, code(ids.otherThread, later)], 1).truncated,
      ).toBe(true);
      expect(searchThreads(store.connection, "go", [], 50).matches).toEqual([]);
      expect(searchThreads(store.connection, "%", mine, 50).matches).toHaveLength(1);
      expect(searchThreads(store.connection, "_", mine, 50).matches).toHaveLength(1);
      expect(searchThreads(store.connection, '"', mine, 50).matches).toEqual([]);
    } finally {
      store.connection.close();
    }
  });

  it("drops turns a rewind removed and rebuilds to the same index", () => {
    const store = openStore();
    try {
      store.thread(ids.thread, "Rewound", now);
      store.turn(ids.thread, operation(1), "first deploy step", ["deploy reply one"]);
      store.turn(ids.thread, operation(2), "second deploy step", ["deploy reply two"]);
      store.rewind(ids.thread, operation(3), operation(2), "conversation");
      store.turn(ids.thread, operation(4), "deploy again", []);
      const visible = [code(ids.thread)];
      const answer = () =>
        searchThreads(store.connection, "deploy", visible, 50).matches.map(
          (match) => match.anchorId,
        );

      expect(answer()).toEqual([operation(4), operation(1)]);
      const rows = () =>
        store.connection
          .prepare("SELECT doc_key, body FROM thread_search_document ORDER BY doc_key")
          .all();
      const before = rows();
      const projection = store.registries.projections.get("thread-search");
      if (projection === undefined) throw new Error("Thread search must be registered");
      rebuildProjection({
        connection: store.connection,
        journal: store.journal,
        projection,
        clock: () => now,
      });
      expect(rows()).toEqual(before);
      expect(answer()).toEqual([operation(4), operation(1)]);
    } finally {
      store.connection.close();
    }
  });
});

function openStore() {
  const directory = mkdtempSync(join(tmpdir(), "octant-thread-search-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const registries = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: registries.events,
    projections: registries.projections,
    clock: () => now,
  });
  const evidence = new CodeEvidenceStore({ connection, clock: () => now });
  let eventIndex = 0;
  const append = (
    aggregate: { readonly aggregateType: string; readonly aggregateId: string },
    expectedVersion: number,
    eventName: string,
    payload: unknown,
  ) => {
    eventIndex += 1;
    journal.append({
      aggregate,
      expectedVersion,
      events: [
        {
          eventId: `84000000-0000-4000-8000-${String(eventIndex).padStart(12, "0")}`,
          eventName,
          eventVersion: 1,
          correlationId: ids.correlation,
          actor: { kind: "system", actorId: ids.actor },
          occurredAt: now,
          payload,
        },
      ],
    });
  };
  const frame = (threadId: string, operationId: string, cursor: number, event: unknown) =>
    append(
      { aggregateType: "code-operation", aggregateId: operationId },
      cursor - 1,
      "code.operation-event-recorded@1",
      { threadId, operationId, cursor, occurredAt: now, event },
    );
  return {
    connection,
    journal,
    registries,
    thread(threadId: string, title: string, updatedAt: string) {
      append({ aggregateType: "code-thread", aggregateId: threadId }, 0, "code.thread-created@1", {
        kind: "thread-created",
        thread: {
          id: threadId,
          projectId: ids.project,
          bindingRevisionId: ids.binding,
          repositoryId,
          checkoutId: ids.checkout,
          title,
          lifecycle: "active",
          providerInstanceId: ids.provider,
          modelId: "model-a",
          executionPolicy: "approval-gated",
          permissionPersistence: "current-session",
          deliveryTarget: {
            branchIntent: "feature/search",
            remoteName: "origin",
            proposedBaseRepository: "octocat/octant",
            proposedBaseBranch: "main",
            outcomeKind: "opened-pr",
            confirmedAt: now,
          },
          version: 1,
          createdAt: now,
          updatedAt,
        },
      });
    },
    turn(threadId: string, operationId: string, prompt: string, reply: ReadonlyArray<string>) {
      frame(threadId, operationId, 1, {
        kind: "conversation-turn-started",
        providerInstanceId: ids.provider,
        modelId: "model-a",
        sessionId: ids.session,
        prompt: evidence.put(prompt),
      });
      reply.forEach((part, index) =>
        frame(threadId, operationId, index + 2, {
          kind: "provider-content",
          channel: "message",
          content: evidence.put(part),
        }),
      );
    },
    rewind(
      threadId: string,
      operationId: string,
      fromOperationId: string,
      scope: "files" | "conversation",
    ) {
      frame(threadId, operationId, 1, {
        kind: "operation-result",
        result: {
          kind: "thread-rewound",
          operationId,
          fromOperationId,
          scope,
          removedTurns: scope === "files" ? 0 : 1,
          files: "not-requested",
        },
      });
    },
    toolActivity(
      threadId: string,
      operationId: string,
      cursor: number,
      name: string,
      summary: string,
    ) {
      frame(threadId, operationId, cursor, {
        kind: "tool-activity",
        toolCallId: `call-${cursor}`,
        toolName: name,
        state: "completed",
        summary,
      });
    },
    terminal(
      threadId: string,
      operationId: string,
      cursor: number,
      output: string,
      replace = false,
    ) {
      frame(threadId, operationId, cursor, {
        kind: "terminal-output",
        terminalId: ids.terminal,
        content: evidence.put(output),
        replace,
      });
    },
    workThread(threadId: string, title: string, updatedAt: string) {
      append({ aggregateType: "work-thread", aggregateId: threadId }, 0, "work.thread-created@1", {
        kind: "thread-created",
        thread: {
          id: threadId,
          projectId: ids.project,
          title,
          lifecycle: "active",
          providerInstanceId: ids.provider,
          modelId: "model-a",
          version: 1,
          createdAt: now,
          updatedAt,
        },
      });
    },
    workTurn(
      threadId: string,
      requestId: string,
      turnId: string,
      prompt: string,
      update: { readonly response?: string; readonly wroteFiles?: ReadonlyArray<string> },
    ) {
      append({ aggregateType: "work-turn", aggregateId: requestId }, 0, "work.turn-accepted@1", {
        kind: "turn-accepted",
        requestId,
        threadId,
        turnId,
        projectId: ids.project,
        authority: {
          hostId: "local",
          projectId: ids.project,
          bindingRevisionId: ids.binding,
          workingDirectory: ".",
          confinementPosture: "project-root-confined",
          providerInstanceId: ids.provider,
          modelId: "model-a",
        },
        providerSessionId: ids.session,
        prompt,
        capabilities: {
          workspace: "project-backed",
          confinement: "project-root-confined",
          shell: "denied",
          git: "denied",
          worktree: "denied",
          pullRequest: "denied",
          code: "denied",
        },
        acceptedAt: now,
      });
      append({ aggregateType: "work-turn", aggregateId: requestId }, 1, "work.turn-updated@1", {
        kind: "turn-updated",
        requestId,
        threadId,
        turnId,
        status: "completed",
        ...(update.response === undefined ? {} : { response: update.response }),
        ...(update.wroteFiles === undefined
          ? {}
          : { wroteFiles: { paths: update.wroteFiles, truncated: false } }),
        updatedAt: now,
      });
    },
  };
}
