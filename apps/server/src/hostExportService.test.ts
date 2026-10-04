import { decodeHostId } from "@octant/contracts/host";
import { decodeUtcTimestamp } from "@octant/contracts/events";
import { decodeProjectId } from "@octant/contracts/projects";
import { ThreadPurgeTombstone } from "@octant/contracts/thread-retention";
import { decodeWindowId } from "@octant/contracts";
import { decodeProviderInstanceId, decodeProviderModelId } from "@octant/contracts/providers";
import {
  assembleHostExportBundle,
  buildThreadExportBundle,
  pageHostExportSlice,
  transcriptWithCounts,
  type ThreadExportSource,
} from "@octant/domain";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { HostExportService, type HostExportServiceOptions } from "./hostExportService";

const now = "2026-08-19T12:00:00.000Z";
const generatedAt = decodeUtcTimestamp(now);
const hostId = decodeHostId("local");
const windowId = decodeWindowId("70000000-0000-4000-8000-000000000002");
const projectId = decodeProjectId("20000000-0000-4000-8000-000000000001");
const SEEDED_CREDENTIAL = "seeded-credential-do-not-export";

const THREADS = {
  chat: ["00000000-0000-4000-8000-000000000901", "00000000-0000-4000-8000-000000000902"],
  work: ["00000000-0000-4000-8000-000000000903"],
  code: ["00000000-0000-4000-8000-000000000904"],
} as const;

function bundleFor(mode: "chat" | "work" | "code", threadId: string) {
  const source: ThreadExportSource = {
    threadId,
    mode,
    title: `${mode} thread`,
    hostId,
    projectId,
    version: 1,
    sequence: 1,
    generatedAt,
    providerInstanceId: decodeProviderInstanceId("10000000-0000-4000-8000-000000000001"),
    modelId: decodeProviderModelId("model-a"),
    createdAt: generatedAt,
    updatedAt: generatedAt,
    transcript: transcriptWithCounts(
      [{ role: "user", text: "hello", occurredAt: generatedAt, status: "completed" }],
      0,
    ),
    artifacts: [],
    attachments: [],
    citations: [],
    omissions: [],
  };
  return buildThreadExportBundle(source);
}

function service(
  overrides: {
    readonly pageSize?: number;
    readonly observeResident?: (section: string, count: number) => void;
    readonly exportThread?: HostExportServiceOptions["threads"]["exportThread"];
    readonly listIds?: HostExportServiceOptions["threads"]["listIds"];
  } = {},
) {
  const limits: number[] = [];
  const listIds = vi.fn<HostExportServiceOptions["threads"]["listIds"]>(
    overrides.listIds ??
      ((input) => {
        limits.push(input.limit);
        return pageHostExportSlice([...THREADS[input.mode]], input.cursor, input.limit);
      }),
  );
  const options: HostExportServiceOptions = {
    hostId,
    clock: () => now,
    ...(overrides.pageSize === undefined ? {} : { pageSize: overrides.pageSize }),
    ...(overrides.observeResident === undefined
      ? {}
      : { observeResident: overrides.observeResident }),
    threads: {
      listIds,
      exportThread:
        overrides.exportThread ??
        (async (_windowId, mode, threadId) => ({
          kind: "exported",
          bundle: bundleFor(mode, threadId),
        })),
    },
    projects: {
      list: ({ cursor, limit }) =>
        pageHostExportSlice(
          [
            {
              projectId,
              name: "Notes",
              type: "work" as const,
              lifecycle: "active" as const,
              canonicalRoot: "/Users/ada/secret",
              apiKey: SEEDED_CREDENTIAL,
            },
          ],
          cursor,
          limit,
        ),
    },
    projectMemory: {
      read: (id) => ({
        projectId: decodeProjectId(id),
        active: [],
        history: [],
      }),
    },
    canvases: {
      list: () => ({
        items: [{ canvasId: "canvas", apiKey: SEEDED_CREDENTIAL }],
        nextCursor: undefined,
      }),
    },
    readSettings: () => ({
      chatEnabled: true,
      workEnabled: true,
      themeMode: "dark",
      apiKey: SEEDED_CREDENTIAL,
      password: SEEDED_CREDENTIAL,
    }),
    usage: {
      list: () => ({ rows: [], nextAfterSequence: undefined }),
    },
    retention: {
      windows: () => ({ items: [], nextCursor: undefined }),
      tombstones: ({ cursor, limit }) =>
        pageHostExportSlice(
          [
            Schema.decodeUnknownSync(ThreadPurgeTombstone)({
              mode: "chat",
              threadId: THREADS.chat[0],
              purgedAt: now,
            }),
          ],
          cursor,
          limit,
        ),
    },
  };
  return { service: new HostExportService(options), listIds, limits };
}

describe("host export", () => {
  it("refuses a remote principal and a paired device before reading stores", async () => {
    for (const principal of ["remote-device", "paired-device"] as const) {
      const fixture = service();
      const pages = [];
      for await (const page of fixture.service.exportPages({ principal, windowId }))
        pages.push(page);
      expect(pages).toEqual([{ kind: "refused", reason: "local-owner-only" }]);
      expect(fixture.listIds).not.toHaveBeenCalled();
      expect(JSON.stringify(pages)).not.toContain(SEEDED_CREDENTIAL);
    }
  });

  it("exports one bundle per projected thread in every mode and never writes a seeded credential", async () => {
    const resident: number[] = [];
    const fixture = service({
      pageSize: 1,
      observeResident: (section, count) => {
        if (section === "threads") resident.push(count);
      },
    });
    const collected = [];
    for await (const page of fixture.service.exportPages({ principal: "local-window", windowId })) {
      collected.push(page);
    }
    const assembled = assembleHostExportBundle(collected);
    expect(assembled.kind).toBe("exported");
    if (assembled.kind !== "exported") return;
    expect(assembled.bundle.octant.format).toBe("octant.host-export/1");
    expect(assembled.bundle.octant.threadCount).toBe(4);
    expect(assembled.bundle.threads).toHaveLength(4);
    expect(assembled.bundle.threads.map((thread) => thread.octant.mode).sort()).toEqual([
      "chat",
      "chat",
      "code",
      "work",
    ]);
    expect(assembled.bundle.projects).toEqual([
      { projectId, name: "Notes", type: "work", lifecycle: "active" },
    ]);
    expect(assembled.bundle.canvases).toEqual([]);
    expect(assembled.bundle.retention.tombstones).toHaveLength(1);
    expect(assembled.bundle.omissions.map((omission) => omission.subject)).toContain(
      "unrepresentable-record",
    );
    expect(assembled.bundle.omissions.map((omission) => omission.subject)).toContain("credentials");
    const serialized = JSON.stringify(assembled.bundle);
    expect(serialized).not.toContain(SEEDED_CREDENTIAL);
    expect(serialized).not.toContain("/Users/ada/secret");
    expect(fixture.limits.every((limit) => limit === 1)).toBe(true);
    expect(Math.max(...resident)).toBe(1);
    expect(resident.length).toBe(4);
  });
});
