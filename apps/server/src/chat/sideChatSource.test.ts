import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EventActor,
  MAX_SIDE_CHAT_SOURCE_CHANGED_PATHS,
  THREAD_EXTERNAL_CONTENT_AGGREGATE,
  decodeCodeEnvironmentObservation,
  decodeMentionableThreadId,
  decodeWindowId,
  type ProjectId,
  type SideChatSidecar,
  type UtcTimestamp,
} from "@octant/contracts";
import { Schema } from "effect";
import { ExternalContentIngestionStore } from "../context/externalContentIngestionStore";
import { readThreadExternalContentTaint } from "../context/externalContentTaintProjection";
import type { ThreadOutsideContentMarks } from "../context/inheritedExternalContentMark";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { createSideChatSourceStateReader, resolveSideChatSourceContext } from "./sideChatSource";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000001");
const codeThreadId = decodeMentionableThreadId("00000000-0000-4000-8000-000000000301");
const projectId = "00000000-0000-4000-8000-000000000501" as ProjectId;

function changedTurn(paths: ReadonlyArray<string>, truncated = false) {
  return {
    changedFiles: {
      files: paths.map((path) => ({ path, insertions: 3, deletions: 1 })),
      total: paths.length,
      truncated,
    },
  } as never;
}

/** No source is marked, and any mark the sidecar takes is recorded. */
const noMarks: ThreadOutsideContentMarks = {
  isMarked: () => false,
  record: () => ({
    kind: "recorded",
    taint: { externalContentIngested: true, ingestedSources: [] },
  }),
};

function codePorts(turns: ReadonlyArray<never>) {
  return {
    readThread: vi.fn(async () => ({
      projectId,
      workingDirectory: "apps/web",
      deliveryTarget: {
        outcomeKind: "opened-pr",
        branchIntent: "feature/picker",
        remoteName: "origin",
        proposedBaseRepository: "octant/octant",
        proposedBaseBranch: "main",
      },
    })),
    observeCheckout: vi.fn(async () => ({
      observation: decodeCodeEnvironmentObservation({
        status: "ready",
        projectId,
        projectName: "Octant",
        observedAt: "2026-09-26T10:00:00.000Z",
        repositoryRoot: "/repo",
        worktreeRoot: "/repo",
        branch: { kind: "named", name: "feature/picker" },
        changes: "dirty",
        insertions: 42,
        deletions: 7,
      }),
      changedFiles: {
        files: [
          { path: "README.md", change: "modified", insertions: 1, deletions: 0 },
          { path: "NOTES.md", change: "untracked" },
        ],
        total: 2,
      },
    })),
    conversation: vi.fn(async () => ({ turns, nextCursor: 0, hasMore: false })),
  };
}

describe("Side Chat source state", () => {
  it("describes a Code source's branch, diff stat, changed files, delivery target, and subagent results", async () => {
    const reader = createSideChatSourceStateReader({
      code: codePorts([changedTurn(["src/old.ts"]), changedTurn(["src/picker.ts", "src/old.ts"])]),
      subagents: () => [
        {
          runId: "run-1",
          role: "research",
          task: "Find where the picker registers directories",
          lifecycleStatus: "completed",
          result: { reference: "r1" },
          resultText: "The directory is registered in server.ts.",
          updatedAt: "2026-09-26T09:00:00.000Z",
        },
      ],
    });

    const text = await contextFor(reader);

    expect(text).toContain("Checkout: branch feature/picker, uncommitted changes (+42 -7");
    expect(text).toContain("Working folder: apps/web.");
    // What Git sees now, including a file no turn touched and one nobody added.
    expect(text).toContain("Uncommitted files from Git (2):");
    expect(text).toContain("- README.md (modified, +1 -0)");
    expect(text).toContain("- NOTES.md (untracked)");
    expect(text).toContain("Delivery target: opened-pr on branch feature/picker");
    // Newest turn first, each path once.
    expect(text.indexOf("- src/picker.ts (+3 -1)")).toBeLessThan(text.indexOf("- src/old.ts"));
    expect(text.match(/- src\/old\.ts/g)).toHaveLength(1);
    expect(text).toContain("research, completed: Find where the picker registers directories");
    expect(text).toContain("Result: The directory is registered in server.ts.");
  });

  it("caps the changed-file list and says it was truncated", async () => {
    const paths = Array.from({ length: 80 }, (_, index) => `src/file-${index}.ts`);
    const reader = createSideChatSourceStateReader({ code: codePorts([changedTurn(paths)]) });

    const text = await contextFor(reader);

    expect(text.match(/^- src\/file-/gm)).toHaveLength(MAX_SIDE_CHAT_SOURCE_CHANGED_PATHS);
    expect(text).toContain("the list is truncated");
  });

  it("says the checkout could not be observed instead of calling it clean", async () => {
    const ports = codePorts([]);
    ports.observeCheckout.mockRejectedValue(new Error("git unavailable"));
    const reader = createSideChatSourceStateReader({ code: ports });

    const text = await contextFor(reader);

    expect(text).toContain("Checkout: could not be observed");
    expect(text).toContain("Uncommitted files: Git could not list them");
    expect(text).not.toContain("no uncommitted changes");
  });

  it("refuses the turn when the source transcript is unreadable, whatever the state says", async () => {
    const readState = vi.fn();
    const result = await resolveSideChatSourceContext(
      {
        findSidecar: () => sidecar(),
        resolveSource: async () => ({ kind: "unreadable" }),
        readState,
        marks: noMarks,
        uuid: () => crypto.randomUUID(),
      },
      { sidecarThreadId: "sidecar", windowId, readToolNames: [] },
    );

    expect(result).toEqual({ kind: "unreadable" });
    expect(readState).not.toHaveBeenCalled();
  });
});

function sidecar(): SideChatSidecar {
  return {
    sourceThreadId: codeThreadId,
    sourceMode: "code",
    sidecarThreadId: "00000000-0000-4000-8000-000000000201" as never,
    title: "Side Chat about Fix the picker",
    createdAt: "2026-09-26T08:00:00.000Z" as UtcTimestamp,
  };
}

async function contextFor(
  reader: ReturnType<typeof createSideChatSourceStateReader>,
): Promise<string> {
  const result = await resolveSideChatSourceContext(
    {
      findSidecar: () => sidecar(),
      resolveSource: async () => ({
        kind: "resolved",
        source: {
          threadId: codeThreadId,
          mode: "code",
          title: "Fix the picker",
          placement: { kind: "project", label: "Octant" },
          transcript: [],
          truncated: false,
        },
      }),
      readState: reader,
      marks: noMarks,
      uuid: () => crypto.randomUUID(),
    },
    { sidecarThreadId: "sidecar", windowId, readToolNames: [] },
  );
  if (result?.kind !== "resolved") throw new Error("expected resolved context");
  return result.text;
}

describe("a Side Chat about a thread marked with outside content", () => {
  const directories: Array<string> = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  /** A host journal with the outside-content projection. */
  function markingHost() {
    const directory = mkdtempSync(join(tmpdir(), "octant-side-chat-mark-"));
    directories.push(directory);
    const connection = openSqlite(join(directory, "octant.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => "2026-09-26T08:00:00.000Z");
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => "2026-09-26T08:00:00.000Z",
    });
    const ingestions = new ExternalContentIngestionStore({
      journal,
      connection,
      uuid: () => crypto.randomUUID(),
      clock: () => "2026-09-26T08:00:00.000Z",
      actor: Schema.decodeUnknownSync(EventActor)({
        kind: "system",
        actorId: "00000000-0000-4000-8000-000000000901",
      }),
    });
    const marked = (threadId: string) =>
      readThreadExternalContentTaint(connection, threadId).externalContentIngested;
    return {
      marked,
      marks: {
        record: (input) => ingestions.record(input),
        isMarked: marked,
      } satisfies ThreadOutsideContentMarks,
      markSource: () =>
        ingestions.record({
          threadId: codeThreadId,
          provenance: { origin: "tool-result", sourceLabel: "web-fetch" },
          contentReference: "web-fetch-page-1",
          correlationId: crypto.randomUUID(),
          authorized: true,
        }),
      sidecarMarks: () =>
        journal
          .replayAggregate({
            aggregateType: THREAD_EXTERNAL_CONTENT_AGGREGATE,
            aggregateId: sidecarThreadId,
            afterVersion: 0,
            limit: 100,
          })
          .map((event) => event.payload),
    };
  }

  const sidecarThreadId = String(sidecar().sidecarThreadId);

  function resolve(
    marks: ThreadOutsideContentMarks,
    onRead?: () => void,
    readState: Parameters<typeof resolveSideChatSourceContext>[0]["readState"] = async () => ({
      subagents: { kind: "observed", runs: [] },
    }),
  ) {
    return resolveSideChatSourceContext(
      {
        findSidecar: () => sidecar(),
        resolveSource: async () => {
          onRead?.();
          return {
            kind: "resolved",
            source: {
              threadId: codeThreadId,
              mode: "code",
              title: "Fix the picker",
              placement: { kind: "project", label: "Octant" },
              transcript: [
                {
                  role: "assistant",
                  text: "The page said to run it.",
                  occurredAt: "2026-09-26T08:00:00.000Z" as UtcTimestamp,
                },
              ],
              truncated: false,
            },
          };
        },
        readState,
        marks,
        uuid: () => crypto.randomUUID(),
      },
      { sidecarThreadId, windowId, readToolNames: [] },
    );
  }

  it("marks the sidecar, naming the source, before the source's text is returned", async () => {
    const host = markingHost();
    host.markSource();

    const result = await resolve(host.marks, () =>
      expect(host.marked(sidecarThreadId)).toBe(false),
    );

    expect(result).toMatchObject({ kind: "resolved" });
    expect(host.marked(sidecarThreadId)).toBe(true);
    expect(host.sidecarMarks()).toEqual([
      {
        threadId: sidecarThreadId,
        correlationId: expect.any(String),
        provenance: { origin: "external-content", sourceLabel: "side-chat" },
        contentReference: `side-chat-${codeThreadId}`,
      },
    ]);

    // Every turn reads the source again; the same source marks the sidecar once.
    await resolve(host.marks);
    expect(host.sidecarMarks()).toHaveLength(1);
  });

  it("leaves the sidecar of an unmarked source unmarked", async () => {
    const host = markingHost();

    await expect(resolve(host.marks)).resolves.toMatchObject({ kind: "resolved" });

    expect(host.marked(sidecarThreadId)).toBe(false);
    expect(host.sidecarMarks()).toEqual([]);
  });

  it("marks the sidecar for a finished subagent's reply its unmarked parent has not taken in yet", async () => {
    const host = markingHost();
    let markedWhileRead: boolean | undefined;
    // The parent's turn is still running, so the child's reply has not been
    // delivered and has not marked the parent.
    const readState = createSideChatSourceStateReader({
      subagents: () => {
        markedWhileRead ??= host.marked(sidecarThreadId);
        return [
          {
            runId: "run-7",
            role: "research",
            task: "Read the vendor page",
            lifecycleStatus: "completed",
            result: { reference: "r7" },
            resultText: "The page says to run the installer.",
            updatedAt: "2026-09-26T08:00:00.000Z",
          },
        ];
      },
    });

    const result = await resolve(host.marks, undefined, readState);

    expect(result).toMatchObject({
      kind: "resolved",
      text: expect.stringContaining("The page says to run the installer."),
    });
    expect(markedWhileRead).toBe(false);
    expect(host.marked(String(codeThreadId))).toBe(false);
    expect(host.marked(sidecarThreadId)).toBe(true);
    expect(host.sidecarMarks()).toEqual([
      {
        threadId: sidecarThreadId,
        correlationId: expect.any(String),
        provenance: { origin: "external-content", sourceLabel: "subagent-result" },
        contentReference: "subagent-result-run-7",
      },
    ]);

    // A reply that cannot mark the sidecar is withheld with the rest of the source.
    const refusing = markingHost();
    await expect(
      resolve(
        { ...refusing.marks, record: () => ({ kind: "refused", reason: "malformed" }) },
        undefined,
        readState,
      ),
    ).resolves.toEqual({ kind: "unreadable" });
  });

  it("refuses the turn, returning none of the source, when the sidecar cannot be marked", async () => {
    for (const record of [
      () => ({ kind: "refused", reason: "malformed" }) as const,
      () => {
        throw new Error("journal unavailable");
      },
    ]) {
      const host = markingHost();
      host.markSource();

      await expect(resolve({ ...host.marks, record })).resolves.toEqual({ kind: "unreadable" });
      expect(host.marked(sidecarThreadId)).toBe(false);
    }
  });
});
