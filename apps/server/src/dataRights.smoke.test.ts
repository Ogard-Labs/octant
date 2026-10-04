// Data-rights end-to-end smoke on a throwaway host.
//
// One store resolved through OCTANT_DATA_DIR, seeded in Chat, Work, and
// Code, exercises the shipped rights against the live wiring: the same
// createLiveHostExportService the host-control route streams and the same
// ThreadRetentionService purge a confirmed purge calls. Export, purge one
// thread, export again. The second NDJSON cut carries no content trace of
// the purged thread; the thread id may still appear only inside the two
// scopes the purge outcome names as retained — the tombstone and usage
// attribution.
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeChatThread,
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeProjectId,
  decodeWindowId,
  decodeWorkThreadId,
  type WorkThread,
  type WorkTurnState,
} from "@octant/contracts";
import type { HostExportPage } from "@octant/contracts/host-export";
import { decodeUtcTimestamp } from "@octant/contracts/events";
import { decodeHostId } from "@octant/contracts/host";
import { decodeProviderInstanceId, decodeProviderModelId } from "@octant/contracts/providers";
import { decodeImageGenerationScopeId } from "@octant/contracts";
import { decodeThreadRetentionThreadId } from "@octant/contracts/thread-retention";
import type { CodeConversationPage } from "@octant/contracts/code-operations";
import {
  assembleHostExportBundle,
  encodeHostExportPage,
  THREAD_PURGE_DELETED_SCOPES,
  THREAD_PURGE_RETAINED_SCOPES,
} from "@octant/domain";
import { afterEach, describe, expect, it } from "vitest";
import { ChatAttachmentStore } from "./chat/chatAttachmentStore";
import { WorkAttachmentStore } from "./work/workAttachmentStore";
import { CodeAttachmentStore } from "./code/codeAttachmentStore";
import { GeneratedImageStore } from "./image/generatedImageStore";
import { managedWorktreeRoot } from "./code/managedWorktreeService";
import { readChatThreadView, writeChatContent } from "./persistence/chatProjection";
import { Journal } from "./persistence/journal";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { createPhase1RuntimeRegistries } from "./persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "./persistence/sqlitePort";
import { purgeThreadArtifacts } from "./persistence/threadArtifactPurge";
import { prepareStore } from "./persistence/storePath";
import { createLiveHostExportService, type HostExportService } from "./hostExportService";
import { ThreadExportService } from "./threadExportService";
import { ThreadRetentionService } from "./threadRetentionService";

const now = "2026-08-19T12:00:00.000Z";
const hostId = decodeHostId("local");
const windowId = decodeWindowId("70000000-0000-4000-8000-000000000002");
const projectId = decodeProjectId("20000000-0000-4000-8000-000000000001");
const providerId = "10000000-0000-4000-8000-000000000001";
const sessionId = "10000000-0000-4000-8000-000000000002";
const actorId = "00000000-0000-4000-8000-0000000000aa";

const threads = {
  chat: {
    id: "00000000-0000-4000-8000-000000000401",
    mode: "chat" as const,
    marker: "marker-chat-violet-ledger",
  },
  work: {
    id: "00000000-0000-4000-8000-000000000402",
    mode: "work" as const,
    marker: "marker-work-amber-ledger",
  },
  code: {
    id: "00000000-0000-4000-8000-000000000403",
    mode: "code" as const,
    marker: "marker-code-indigo-ledger",
  },
} as const;

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("data-rights smoke: export, purge, re-export on a throwaway host", () => {
  it("a confirmed purge leaves no content trace in the next host export", async () => {
    // The throwaway host resolves through OCTANT_DATA_DIR exactly like
    // main.ts, and store preparation fails closed unless the directory ends
    // up owner-only (mode 0700).
    const parent = join(process.env.TMPDIR ?? "/tmp", `octant-data-rights-${randomUUID()}`);
    mkdirSync(parent, { mode: 0o700 });
    directories.push(parent);
    const store = await prepareStore({
      env: { ...process.env, OCTANT_DATA_DIR: join(parent, "data") },
      platform: process.platform,
      home: process.env.HOME ?? parent,
    });
    directories.push(store.directory);
    expect(lstatSync(store.directory).mode & 0o777).toBe(0o700);

    const connection = openSqlite(store.databasePath);
    applyMigrations(connection, MIGRATIONS, () => now);
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });

    seedChatThread(connection, journal);
    seedCodeThread(connection);
    seedAttachments(store.directory);
    seedUsage(connection);

    const workThreads: WorkThread[] = [
      {
        id: decodeWorkThreadId(threads.work.id),
        projectId,
        title: threads.work.marker,
        lifecycle: "active",
        providerInstanceId: decodeProviderInstanceId(providerId),
        modelId: decodeProviderModelId("model-a"),
        version: 1,
        createdAt: decodeUtcTimestamp(now),
        updatedAt: decodeUtcTimestamp(now),
      } as unknown as WorkThread,
    ];
    const evidence = new Map<string, Uint8Array>([
      [`prompt-${threads.code.id}`, new TextEncoder().encode(threads.code.marker)],
      [`answer-${threads.code.id}`, new TextEncoder().encode("done")],
    ]);
    const threadExports = new ThreadExportService({
      hostId,
      clock: () => now,
      chat: {
        read: (threadId) => {
          try {
            return readChatThreadView(connection, decodeChatThreadId(threadId));
          } catch {
            return undefined;
          }
        },
      },
      work: {
        read: async (_windowId, threadId) => {
          const thread = workThreads.find((entry) => String(entry.id) === threadId);
          if (thread === undefined) return undefined;
          const turn = {
            requestId: randomUUID(),
            threadId,
            turnId: randomUUID(),
            projectId: String(projectId),
            status: "completed",
            prompt: threads.work.marker,
            transcript: [
              { role: "user", text: threads.work.marker },
              { role: "assistant", text: "The brief is on disk." },
            ],
            acceptedAt: now,
            updatedAt: now,
          } as unknown as WorkTurnState;
          return { thread, turns: [turn] };
        },
      },
      code: {
        readThread: async (_windowId, threadId) => {
          const row = connection
            .prepare(
              `SELECT project_id, updated_at FROM code_thread_projection WHERE thread_id = ?`,
            )
            .get(threadId) as
            | { readonly project_id: string; readonly updated_at: string }
            | undefined;
          if (row === undefined) return undefined;
          const timestamp = decodeUtcTimestamp(row.updated_at);
          return {
            threadId,
            title: threads.code.marker,
            projectId: decodeProjectId(row.project_id),
            version: 1,
            lastSequence: 1,
            providerInstanceId: decodeProviderInstanceId(providerId),
            modelId: decodeProviderModelId("model-a"),
            createdAt: timestamp,
            updatedAt: timestamp,
          };
        },
        conversation: async (_windowId, threadId) =>
          ({
            version: 3,
            threadId,
            turns: [
              {
                operationId: randomUUID(),
                providerInstanceId: decodeProviderInstanceId(providerId),
                modelId: decodeProviderModelId("model-a"),
                sessionId: decodeProviderInstanceId(sessionId),
                prompt: {
                  contentId: `prompt-${threadId}`,
                  digest: digest(threads.code.marker),
                  byteLength: threads.code.marker.length,
                },
                assistant: [
                  {
                    contentId: `answer-${threadId}`,
                    digest: digest("done"),
                    byteLength: 4,
                  },
                ],
                status: "completed",
                startedAt: decodeUtcTimestamp(now),
                updatedAt: decodeUtcTimestamp(now),
              },
            ],
            nextCursor: 1,
            hasMore: false,
          }) as unknown as CodeConversationPage,
        readEvidence: async (_windowId, _threadId, _operationId, contentId) => {
          const bytes = evidence.get(String(contentId));
          if (bytes === undefined) throw new Error(`missing evidence ${contentId}`);
          return { bytes };
        },
      },
      canvases: { byThread: () => [] },
    });

    // The live wiring from #997: the same service the host-control route
    // streams to a local owner.
    const exportService: HostExportService = createLiveHostExportService({
      hostId,
      clock: () => now,
      threads: threadExports,
      connection,
      listWorkThreadIds: () => workThreads.map((thread) => String(thread.id)),
      listProjects: () => [],
      readProjectMemory: (id) => ({
        projectId: decodeProjectId(id),
        active: [],
        history: [],
      }),
      listCanvases: () => [],
      readSettings: () => ({ chatEnabled: true, workEnabled: true, themeMode: "dark" }),
      listProjectIds: () => [String(projectId)],
    });

    // The live purge wiring from #986/#997: journal erasure plus the artifact
    // sweep over the same store directory.
    const retention = new ThreadRetentionService({
      connection,
      journal,
      clock: () => now,
      uuid: randomUUID,
      listWorkThreads: () =>
        workThreads.map((thread) => ({ id: String(thread.id), projectId, updatedAt: now })),
      forgetWorkThread: (threadId) => {
        const index = workThreads.findIndex((thread) => String(thread.id) === threadId);
        if (index >= 0) workThreads.splice(index, 1);
      },
      purgeThreadArtifacts: ({ mode, threadId }) =>
        purgeThreadArtifacts({
          connection,
          dataDirectory: store.directory,
          mode,
          threadId: String(threadId),
          managedWorktreeRootPath: managedWorktreeRoot,
          purgeChatAttachments: (id) =>
            new ChatAttachmentStore(join(store.directory, "chat")).purgeThread(
              decodeChatThreadId(id),
            ),
          purgeWorkAttachments: (id) =>
            new WorkAttachmentStore(store.directory).purgeThread(decodeWorkThreadId(id)),
          purgeCodeAttachments: (id) =>
            new CodeAttachmentStore(store.directory).purgeThread(decodeCodeThreadId(id)),
          purgeGeneratedImages: async (id) => {
            try {
              await new GeneratedImageStore(store.directory).purgeScope(
                decodeImageGenerationScopeId(id),
              );
            } catch {
              // A thread id that is not an image scope is not an image basin.
            }
          },
          purgeAgentMessages: async () => undefined,
        }),
    });

    const first = await exportNdjson(exportService);
    expect(first.ndjson).toContain(threads.chat.marker);
    expect(first.ndjson).toContain(threads.work.marker);
    expect(first.ndjson).toContain(threads.code.marker);
    const firstBundle = assembleHostExportBundle(first.pages);
    expect(firstBundle.kind).toBe("exported");
    if (firstBundle.kind !== "exported") return;
    expect(firstBundle.bundle.octant.format).toBe("octant.host-export/1");
    expect(
      firstBundle.bundle.threads.map((thread) => String(thread.octant.threadId)).sort(),
    ).toEqual([threads.chat.id, threads.code.id, threads.work.id].sort());

    const outcome = await retention.purge(
      {
        scope: {
          kind: "thread",
          mode: "chat",
          threadId: decodeThreadRetentionThreadId(threads.chat.id),
        },
        confirm: true,
      },
      "local-window",
    );
    expect(outcome).toMatchObject({ operation: "purge-threads" });
    if (!("deleted" in outcome)) throw new Error("purge did not report deleted scopes");
    expect(outcome.deleted).toEqual([...THREAD_PURGE_DELETED_SCOPES]);
    expect(outcome.retained).toEqual([...THREAD_PURGE_RETAINED_SCOPES]);
    // The purged thread's attachment basin is gone from disk.
    expect(scopeDirectoryExists(join(store.directory, "chat", "threads"), threads.chat.id)).toBe(
      false,
    );

    const second = await exportNdjson(exportService);
    // No content trace of the purged thread survives in the next cut.
    expect(second.ndjson).not.toContain(threads.chat.marker);
    // The other threads keep their data.
    expect(second.ndjson).toContain(threads.work.marker);
    expect(second.ndjson).toContain(threads.code.marker);
    const secondBundle = assembleHostExportBundle(second.pages);
    expect(secondBundle.kind).toBe("exported");
    if (secondBundle.kind !== "exported") return;
    expect(secondBundle.bundle.threads.map((thread) => String(thread.octant.threadId))).toEqual([
      threads.work.id,
      threads.code.id,
    ]);
    // The purged thread id appears only inside the two scopes the outcome
    // names as retained: the purge tombstone and usage attribution.
    const pagesNamingThread = second.pages
      .filter((page) => JSON.stringify(page).includes(threads.chat.id))
      .map((page) => page.kind);
    expect([...new Set(pagesNamingThread)].sort()).toEqual(["retention-tombstones", "usage"]);
  }, 120_000);
});

async function exportNdjson(service: HostExportService): Promise<{
  readonly pages: HostExportPage[];
  readonly ndjson: string;
}> {
  const pages: HostExportPage[] = [];
  for await (const page of service.exportPages({ principal: "local-window", windowId })) {
    pages.push(page);
  }
  const lines = pages.map((page) => encodeHostExportPage(page));
  const refused = lines.find((line) => line.kind === "refused");
  if (refused !== undefined) throw new Error("host export was refused during the smoke");
  return {
    pages,
    ndjson: lines.map((line) => (line.kind === "ok" ? line.line : "")).join(""),
  };
}

function scopeDirectoryExists(root: string, threadId: string): boolean {
  try {
    return readdirSync(root).includes(threadId);
  } catch {
    return false;
  }
}

function digest(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function seedChatThread(connection: SqliteConnection, journal: Journal): void {
  journal.append({
    aggregate: { aggregateType: "chat-thread", aggregateId: threads.chat.id },
    expectedVersion: 0,
    events: [
      {
        eventId: randomUUID(),
        eventName: "chat.thread-created@1",
        eventVersion: 1,
        correlationId: randomUUID(),
        actor: { kind: "system", actorId },
        occurredAt: now,
        payload: {
          kind: "thread-created",
          thread: decodeChatThread({
            id: threads.chat.id,
            title: threads.chat.marker,
            lifecycle: "active",
            providerInstanceId: providerId,
            modelId: "model-a",
            researchEnabled: false,
            researchRouting: "automatic",
            personalityInstructions: "Be useful.",
            version: 1,
            createdAt: now,
            updatedAt: now,
          }),
        },
      },
    ],
  });
  writeChatContent(connection, {
    contentId: randomUUID(),
    threadId: threads.chat.id,
    role: "user",
    body: threads.chat.marker,
    digest: digest(threads.chat.marker),
    byteLength: threads.chat.marker.length,
  });
}

function seedCodeThread(connection: SqliteConnection): void {
  connection
    .prepare(
      `INSERT INTO code_thread_projection (
        thread_id, project_id, checkout_id, lifecycle, schema_version, thread_json,
        aggregate_version, updated_at, last_sequence
      ) VALUES (?, ?, ?, 'active', 1, '{}', 1, ?, 1)`,
    )
    .run(threads.code.id, String(projectId), `checkout-${threads.code.id}`, now);
}

function seedAttachments(directory: string): void {
  const attachment = randomUUID();
  const chatFile = join(directory, "chat", "threads", threads.chat.id, attachment);
  mkdirSync(chatFile, { recursive: true, mode: 0o700 });
  writeFileSync(join(chatFile, "finalized.bin"), threads.chat.marker);
  const imageFile = join(directory, "generated-images", threads.chat.id, randomUUID());
  mkdirSync(imageFile, { recursive: true, mode: 0o700 });
  writeFileSync(join(imageFile, "finalized.bin"), threads.chat.marker);
}

function seedUsage(connection: SqliteConnection): void {
  let sequence = 10;
  for (const thread of Object.values(threads)) {
    const subjectType =
      thread.mode === "chat"
        ? "chat-thread"
        : thread.mode === "code"
          ? "code-thread"
          : "work-thread";
    connection
      .prepare(
        `INSERT INTO usage_record_projection (
          reconciliation_id, subject_type, subject_id, provider_instance_id, model_id,
          request_shape, quality, input_tokens, output_tokens, planned_input_tokens,
          variance_tokens, schema_version, attribution_json, observed_at, last_sequence, host_id
        ) VALUES (?, ?, ?, ?, 'model-a', 'turn', 'exact', 3, 1, 3, 0, 2, '[]', ?, ?, 'local')`,
      )
      .run(randomUUID(), subjectType, thread.id, providerId, now, sequence);
    sequence += 1;
  }
}
