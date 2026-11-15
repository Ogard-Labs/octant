import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodeEvidenceStore } from "../code/codeEvidenceStore";
import { searchCodeTranscript } from "./codeTranscriptSearchProjection";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { rebuildProjection } from "./projection";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import { openSqlite } from "./sqlitePort";

const directories: Array<string> = [];
const now = "2026-11-14T10:00:00.000Z";
const later = "2026-11-14T11:00:00.000Z";
const ids = {
  actor: "84000000-0000-4000-8000-000000000001",
  correlation: "84000000-0000-4000-8000-000000000002",
  thread: "84000000-0000-4000-8000-000000000003",
  otherThread: "84000000-0000-4000-8000-000000000004",
  project: "84000000-0000-4000-8000-000000000005",
  binding: "84000000-0000-4000-8000-000000000006",
  checkout: "84000000-0000-4000-8000-000000000007",
  provider: "84000000-0000-4000-8000-000000000008",
  session: "84000000-0000-4000-8000-000000000009",
} as const;
const operation = (index: number) =>
  `84000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`;
const repositoryId = `repo_${"a".repeat(64)}`;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Code message search", () => {
  it("finds a word that straddles two streamed reply bursts and names the turn's operation", () => {
    const store = openStore();
    try {
      store.thread(ids.thread, "Parser fix", now);
      store.turn(ids.thread, operation(1), "Fix the parser", ["The tokeni", "zer was wrong"]);

      const result = searchCodeTranscript(store.connection, "Tokenizer", new Set([ids.thread]));

      expect(result.truncated).toBe(false);
      expect(result.matches).toEqual([
        {
          threadId: ids.thread,
          operationId: operation(1),
          snippet: "The tokenizer was wrong",
          matchRanges: [{ start: 4, end: 13 }],
        },
      ]);
    } finally {
      store.connection.close();
    }
  });

  it("matches each turn once, leaves out threads the caller may not list, and counts only listed matches toward the cap", () => {
    const store = openStore();
    try {
      store.thread(ids.thread, "Parser fix", later);
      store.thread(ids.otherThread, "Other", now);
      store.turn(ids.thread, operation(1), "Look at the parser", ["The parser is fixed"]);
      store.turn(ids.thread, operation(2), "And the parser tests", []);
      store.turn(ids.otherThread, operation(3), "parser elsewhere", []);

      const visible = new Set([ids.thread]);
      const all = searchCodeTranscript(store.connection, "parser", visible);
      expect(all.matches.map((match) => [String(match.operationId), match.snippet])).toEqual([
        [operation(1), "Look at the parser"],
        [operation(2), "And the parser tests"],
      ]);
      expect(all.truncated).toBe(false);
      expect(searchCodeTranscript(store.connection, "parser", visible, 1).truncated).toBe(true);
      expect(searchCodeTranscript(store.connection, "parser", new Set()).matches).toEqual([]);
    } finally {
      store.connection.close();
    }
  });

  it("treats LIKE wildcards in the query as text", () => {
    const store = openStore();
    try {
      store.thread(ids.thread, "Coverage", now);
      store.turn(ids.thread, operation(1), "Reach 100% coverage", []);
      store.turn(ids.thread, operation(2), "Rename the snake_case field", []);
      store.turn(ids.thread, operation(3), "Nothing special here", []);
      const visible = new Set([ids.thread]);

      expect(searchCodeTranscript(store.connection, "%", visible).matches).toHaveLength(1);
      expect(searchCodeTranscript(store.connection, "_", visible).matches).toHaveLength(1);
      expect(searchCodeTranscript(store.connection, "\\", visible).matches).toHaveLength(0);
    } finally {
      store.connection.close();
    }
  });

  it("drops turns a conversation rewind removed, keeps turns sent after it, and rebuilds to the same answer", () => {
    const store = openStore();
    try {
      store.thread(ids.thread, "Rewound", now);
      store.turn(ids.thread, operation(1), "first deploy step", []);
      store.turn(ids.thread, operation(2), "second deploy step", []);
      store.rewind(ids.thread, operation(3), operation(2), "files");
      store.rewind(ids.thread, operation(4), operation(2), "conversation");
      store.turn(ids.thread, operation(5), "deploy again", []);
      const visible = new Set([ids.thread]);
      const answer = () =>
        searchCodeTranscript(store.connection, "deploy", visible).matches.map((match) =>
          String(match.operationId),
        );

      expect(answer()).toEqual([operation(1), operation(5)]);
      const rows = () =>
        store.connection
          .prepare(
            "SELECT * FROM code_transcript_search_projection ORDER BY operation_id, content_role",
          )
          .all();
      const before = rows();
      const projection = store.registries.projections.get("code-transcript-search");
      if (projection === undefined) throw new Error("Code transcript search must be registered");
      rebuildProjection({
        connection: store.connection,
        journal: store.journal,
        projection,
        clock: () => now,
      });
      expect(rows()).toEqual(before);
      expect(answer()).toEqual([operation(1), operation(5)]);
    } finally {
      store.connection.close();
    }
  });
});

function openStore() {
  const directory = mkdtempSync(join(tmpdir(), "octant-code-transcript-search-"));
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
  };
}
