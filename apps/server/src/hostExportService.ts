import {
  HOST_EXPORT_FORMAT,
  decodeHostExportUsageRow,
  type HostExportPage,
  type HostExportUsageRow,
} from "@octant/contracts/host-export";
import { decodeUtcTimestamp, type UtcTimestamp } from "@octant/contracts/events";
import type { HostId } from "@octant/contracts/host";
import type { ProjectMemoryView } from "@octant/contracts/projects";
import type { ThreadExportBundle, ThreadExportOutcome } from "@octant/contracts/thread-export";
import type {
  ThreadPurgeTombstone,
  ThreadRetentionWindowEntry,
} from "@octant/contracts/thread-retention";
import type { WindowId } from "@octant/contracts";
import {
  assembleHostExportBundle,
  authorizeHostExport,
  hostExportOmissions,
  hostExportPageLimit,
  HOST_EXPORT_PAGE_SIZE,
  pageHostExportSlice,
  projectHostExportCanvas,
  projectHostExportProject,
  projectHostExportSettings,
  threadExportContainsForbiddenKey,
  type HostExportPrincipal,
  type HostExportProjectSource,
  type HostExportSettingsSource,
} from "@octant/domain";
import type { UsageProjectScope } from "./usageProjectScope";
import { queryUsageRecords } from "./persistence/usageProjection";
import {
  readThreadPurgeTombstonePage,
  readThreadRetentionWindowPage,
} from "./persistence/threadRetentionProjection";
import { toSafeExportRow } from "./persistence/usageExport";
import type { SqliteConnection } from "./persistence/sqlitePort";
import type { ThreadExportService } from "./threadExportService";

const MODES = ["chat", "work", "code"] as const;
type HostExportMode = (typeof MODES)[number];

export interface HostExportCursorPage<T> {
  readonly items: ReadonlyArray<T>;
  readonly nextCursor: string | undefined;
}

export interface HostExportUsagePage {
  readonly rows: ReadonlyArray<HostExportUsageRow>;
  readonly nextAfterSequence: number | undefined;
}

export interface HostExportServiceOptions {
  readonly hostId: HostId;
  readonly clock: () => string;
  /** Test seam. Production uses the policy page size. */
  readonly pageSize?: number;
  readonly observeResident?: (section: string, count: number) => void;
  readonly threads: {
    readonly listIds: (input: {
      readonly mode: HostExportMode;
      readonly cursor: string | undefined;
      readonly limit: number;
    }) => HostExportCursorPage<string> | Promise<HostExportCursorPage<string>>;
    readonly exportThread: (
      windowId: WindowId,
      mode: HostExportMode,
      threadId: string,
    ) => Promise<ThreadExportOutcome>;
  };
  readonly projects: {
    readonly list: (input: {
      readonly cursor: string | undefined;
      readonly limit: number;
    }) =>
      | HostExportCursorPage<HostExportProjectSource>
      | Promise<HostExportCursorPage<HostExportProjectSource>>;
  };
  readonly projectMemory: {
    readonly read: (projectId: string) => ProjectMemoryView | Promise<ProjectMemoryView>;
  };
  readonly canvases: {
    readonly list: (input: {
      readonly cursor: string | undefined;
      readonly limit: number;
    }) => HostExportCursorPage<unknown> | Promise<HostExportCursorPage<unknown>>;
  };
  readonly readSettings: () => HostExportSettingsSource | Promise<HostExportSettingsSource>;
  readonly usage: {
    readonly list: (input: {
      readonly scope: "projects" | "unfiled";
      readonly afterSequence: number;
      readonly limit: number;
    }) => HostExportUsagePage | Promise<HostExportUsagePage>;
  };
  readonly retention: {
    readonly windows: (input: {
      readonly cursor: string | undefined;
      readonly limit: number;
    }) =>
      | HostExportCursorPage<ThreadRetentionWindowEntry>
      | Promise<HostExportCursorPage<ThreadRetentionWindowEntry>>;
    readonly tombstones: (input: {
      readonly cursor: string | undefined;
      readonly limit: number;
    }) =>
      | HostExportCursorPage<ThreadPurgeTombstone>
      | Promise<HostExportCursorPage<ThreadPurgeTombstone>>;
  };
}

/**
 * One local-owner cut of what this host holds.
 *
 * Thread bundles come from the existing thread export. Every large store is
 * read and emitted a page at a time; a prior page is not retained. The
 * forbidden-key walk runs on each page before it is yielded, and again on
 * the assembled bundle.
 */
export class HostExportService {
  readonly #hostId: HostId;
  readonly #clock: () => string;
  readonly #pageSize: number;
  readonly #observeResident: ((section: string, count: number) => void) | undefined;
  readonly #options: HostExportServiceOptions;

  constructor(options: HostExportServiceOptions) {
    this.#hostId = options.hostId;
    this.#clock = options.clock;
    this.#pageSize = hostExportPageLimit(options.pageSize ?? HOST_EXPORT_PAGE_SIZE);
    this.#observeResident = options.observeResident;
    this.#options = options;
  }

  async *exportPages(input: {
    readonly principal: HostExportPrincipal;
    readonly windowId: WindowId;
  }): AsyncGenerator<HostExportPage> {
    if (authorizeHostExport(input.principal).kind === "deny") {
      yield { kind: "refused", reason: "local-owner-only" };
      return;
    }

    const limit = this.#pageSize;
    let generatedAt: UtcTimestamp;
    try {
      generatedAt = decodeUtcTimestamp(this.#clock());
    } catch {
      yield { kind: "refused", reason: "unrepresentable" };
      return;
    }

    const projected = await this.#countThreads(limit);
    const header: HostExportPage = {
      kind: "header",
      octant: {
        format: HOST_EXPORT_FORMAT,
        hostId: this.#hostId,
        generatedAt,
        threadCount: projected,
      },
    };
    if (threadExportContainsForbiddenKey(header)) {
      yield { kind: "refused", reason: "unrepresentable" };
      return;
    }
    yield header;

    const exported = yield* this.#threadPages(input.windowId, limit);
    if (exported === undefined) return;
    let unrepresentable = 0;
    const projectDropped = yield* this.#projectPages(limit);
    if (projectDropped === undefined) return;
    unrepresentable += projectDropped;
    const canvasDropped = yield* this.#canvasPages(limit);
    if (canvasDropped === undefined) return;
    unrepresentable += canvasDropped;
    const settings = projectHostExportSettings(await this.#options.readSettings());
    if (!(yield* this.#emit({ kind: "settings", settings }))) return;
    const usageDropped = yield* this.#usagePages(limit);
    if (usageDropped === undefined) return;
    unrepresentable += usageDropped;
    if (!(yield* this.#retentionPages(limit))) return;
    const omissions = hostExportOmissions(unrepresentable);
    if (!(yield* this.#emit({ kind: "omissions", omissions }))) return;
    if (exported !== projected) {
      yield { kind: "refused", reason: "unrepresentable" };
      return;
    }
    yield { kind: "complete", threadCount: exported };
  }

  async #countThreads(limit: number): Promise<number> {
    let count = 0;
    for (const mode of MODES) {
      let cursor: string | undefined;
      for (;;) {
        const page = await this.#options.threads.listIds({ mode, cursor, limit });
        count += Math.min(page.items.length, limit);
        if (page.nextCursor === undefined || page.nextCursor === cursor) break;
        cursor = page.nextCursor;
      }
    }
    return count;
  }

  async *#threadPages(
    windowId: WindowId,
    limit: number,
  ): AsyncGenerator<HostExportPage, number | undefined> {
    let exported = 0;
    for (const mode of MODES) {
      let cursor: string | undefined;
      for (;;) {
        const page = await this.#options.threads.listIds({ mode, cursor, limit });
        const ids = page.items.slice(0, limit);
        if (ids.length === 0) break;
        const threads: ThreadExportBundle[] = [];
        for (const threadId of ids) {
          const outcome = await this.#options.threads.exportThread(windowId, mode, threadId);
          if (outcome.kind !== "exported" || threadExportContainsForbiddenKey(outcome.bundle)) {
            yield { kind: "refused", reason: "unrepresentable" };
            return undefined;
          }
          threads.push(outcome.bundle);
        }
        if (!(yield* this.#emit({ kind: "threads", threads }))) return undefined;
        exported += threads.length;
        if (page.nextCursor === undefined || page.nextCursor === cursor) break;
        cursor = page.nextCursor;
      }
    }
    return exported;
  }

  async *#projectPages(limit: number): AsyncGenerator<HostExportPage, number | undefined> {
    let cursor: string | undefined;
    let dropped = 0;
    for (;;) {
      const page = await this.#options.projects.list({ cursor, limit });
      const sources = page.items.slice(0, limit);
      if (sources.length === 0) break;
      const projects = sources.map((source) => projectHostExportProject(source));
      if (!(yield* this.#emit({ kind: "projects", projects }))) return undefined;
      const memory = [];
      for (const project of projects) {
        const view = await this.#options.projectMemory.read(String(project.projectId));
        if (threadExportContainsForbiddenKey(view)) {
          dropped += 1;
          continue;
        }
        memory.push(view);
      }
      if (
        memory.length > 0 &&
        !(yield* this.#emit({ kind: "project-memory", projectMemory: memory }))
      ) {
        return undefined;
      }
      if (page.nextCursor === undefined || page.nextCursor === cursor) break;
      cursor = page.nextCursor;
    }
    return dropped;
  }

  async *#canvasPages(limit: number): AsyncGenerator<HostExportPage, number | undefined> {
    let cursor: string | undefined;
    let dropped = 0;
    for (;;) {
      const page = await this.#options.canvases.list({ cursor, limit });
      const sources = page.items.slice(0, limit);
      if (sources.length === 0) break;
      const canvases = [];
      for (const source of sources) {
        const canvas = projectHostExportCanvas(source);
        if (canvas === undefined) {
          dropped += 1;
          continue;
        }
        canvases.push(canvas);
      }
      if (canvases.length > 0 && !(yield* this.#emit({ kind: "canvases", canvases })))
        return undefined;
      if (page.nextCursor === undefined || page.nextCursor === cursor) break;
      cursor = page.nextCursor;
    }
    return dropped;
  }

  async *#usagePages(limit: number): AsyncGenerator<HostExportPage, number | undefined> {
    let dropped = 0;
    for (const scope of ["projects", "unfiled"] as const) {
      let afterSequence = 0;
      for (;;) {
        const page = await this.#options.usage.list({ scope, afterSequence, limit });
        const rows = [];
        for (const row of page.rows.slice(0, limit)) {
          if (threadExportContainsForbiddenKey(row)) {
            dropped += 1;
            continue;
          }
          rows.push(row);
        }
        if (rows.length > 0 && !(yield* this.#emit({ kind: "usage", usage: rows })))
          return undefined;
        if (page.nextAfterSequence === undefined || page.nextAfterSequence === afterSequence) break;
        afterSequence = page.nextAfterSequence;
      }
    }
    return dropped;
  }

  async *#retentionPages(limit: number): AsyncGenerator<HostExportPage, boolean> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.#options.retention.windows({ cursor, limit });
      const windows = page.items.slice(0, limit);
      if (windows.length > 0 && !(yield* this.#emit({ kind: "retention-windows", windows })))
        return false;
      if (windows.length === 0 || page.nextCursor === undefined || page.nextCursor === cursor)
        break;
      cursor = page.nextCursor;
    }
    cursor = undefined;
    for (;;) {
      const page = await this.#options.retention.tombstones({ cursor, limit });
      const tombstones = page.items.slice(0, limit);
      if (
        tombstones.length > 0 &&
        !(yield* this.#emit({ kind: "retention-tombstones", tombstones }))
      ) {
        return false;
      }
      if (tombstones.length === 0 || page.nextCursor === undefined || page.nextCursor === cursor)
        break;
      cursor = page.nextCursor;
    }
    return true;
  }

  /**
   * Yield one page only when the forbidden-key walk accepts it. The page
   * array is the resident set; the caller does not keep it.
   */
  *#emit(page: HostExportPage): Generator<HostExportPage, boolean> {
    const count =
      page.kind === "threads"
        ? page.threads.length
        : page.kind === "projects"
          ? page.projects.length
          : page.kind === "project-memory"
            ? page.projectMemory.length
            : page.kind === "canvases"
              ? page.canvases.length
              : page.kind === "usage"
                ? page.usage.length
                : page.kind === "retention-windows"
                  ? page.windows.length
                  : page.kind === "retention-tombstones"
                    ? page.tombstones.length
                    : 1;
    this.#observeResident?.(page.kind, count);
    if (threadExportContainsForbiddenKey(page)) {
      yield { kind: "refused", reason: "unrepresentable" };
      return false;
    }
    yield page;
    return true;
  }
}

export interface HostExportLiveDependencies {
  readonly hostId: HostId;
  readonly clock: () => string;
  readonly threads: ThreadExportService;
  readonly connection: SqliteConnection;
  readonly listWorkThreadIds: () => ReadonlyArray<string>;
  readonly listProjects: () => ReadonlyArray<HostExportProjectSource>;
  readonly readProjectMemory: (projectId: string) => ProjectMemoryView;
  readonly listCanvases: () => ReadonlyArray<unknown>;
  readonly readSettings: () => HostExportSettingsSource;
  readonly listProjectIds: () => ReadonlyArray<string>;
}

/**
 * Wire the live stores. Chat and Code identities are read with a bounded
 * SQL page so thread documents are not loaded together. Usage rows and purge
 * tombstones use the same bound. Work identities and Canvases already live
 * in memory and are sliced to the page before a transcript or definition is
 * opened.
 */
export function createLiveHostExportService(input: HostExportLiveDependencies): HostExportService {
  const limitOf = (limit: number) => hostExportPageLimit(limit);
  return new HostExportService({
    hostId: input.hostId,
    clock: input.clock,
    threads: {
      listIds: ({ mode, cursor, limit }) => {
        const bounded = limitOf(limit);
        if (mode === "work") return pageHostExportSlice(input.listWorkThreadIds(), cursor, bounded);
        const offset = offsetOf(cursor);
        const sql =
          mode === "chat"
            ? `SELECT thread_id FROM chat_thread_projection
               WHERE lifecycle NOT IN ('deleted', 'deleting')
               ORDER BY updated_at DESC, thread_id ASC
               LIMIT ? OFFSET ?`
            : `SELECT thread_id FROM code_thread_projection
               ORDER BY updated_at DESC, thread_id ASC
               LIMIT ? OFFSET ?`;
        return readIdPage(input.connection, sql, offset, bounded);
      },
      exportThread: (windowId, mode, threadId) =>
        input.threads.exportThread(windowId, "local-window", { mode, threadId }),
    },
    projects: {
      list: ({ cursor, limit }) =>
        pageHostExportSlice(input.listProjects(), cursor, limitOf(limit)),
    },
    projectMemory: { read: (projectId) => input.readProjectMemory(projectId) },
    canvases: {
      list: ({ cursor, limit }) =>
        pageHostExportSlice(input.listCanvases(), cursor, limitOf(limit)),
    },
    readSettings: () => input.readSettings(),
    usage: {
      list: ({ scope, afterSequence, limit }) => {
        const projectScope: UsageProjectScope =
          scope === "unfiled"
            ? { kind: "unfiled" }
            : { kind: "projects", projectIds: input.listProjectIds() };
        const result = queryUsageRecords(
          input.connection,
          {},
          limitOf(limit),
          afterSequence,
          projectScope,
        );
        const rows: HostExportUsageRow[] = [];
        for (const record of result.records) {
          try {
            rows.push(decodeHostExportUsageRow(toSafeExportRow(record)));
          } catch {
            // A row that cannot be the safe export shape is omitted by the caller scan.
          }
        }
        return {
          rows,
          nextAfterSequence: result.hasMore ? result.nextAfterSequence : undefined,
        };
      },
    },
    retention: {
      windows: ({ cursor, limit }) => {
        const bounded = limitOf(limit);
        const page = readThreadRetentionWindowPage(input.connection, offsetOf(cursor), bounded);
        return {
          items: page.windows,
          nextCursor: page.hasMore ? String(offsetOf(cursor) + page.windows.length) : undefined,
        };
      },
      tombstones: ({ cursor, limit }) => {
        const bounded = limitOf(limit);
        const page = readThreadPurgeTombstonePage(input.connection, offsetOf(cursor), bounded);
        return {
          items: page.tombstones,
          nextCursor: page.hasMore ? String(offsetOf(cursor) + page.tombstones.length) : undefined,
        };
      },
    },
  });
}

export async function collectHostExportPages(
  pages: AsyncIterable<HostExportPage>,
): Promise<ReturnType<typeof assembleHostExportBundle>> {
  const collected: HostExportPage[] = [];
  for await (const page of pages) collected.push(page);
  return assembleHostExportBundle(collected);
}

function offsetOf(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const offset = Number(cursor);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}

function readIdPage(
  connection: SqliteConnection,
  sql: string,
  offset: number,
  limit: number,
): HostExportCursorPage<string> {
  const rows = connection.prepare(sql).all(limit + 1, offset);
  const ids: string[] = [];
  for (const row of rows) {
    if (isThreadIdRow(row)) ids.push(row.thread_id);
  }
  const hasMore = ids.length > limit;
  const items = hasMore ? ids.slice(0, limit) : ids;
  return { items, nextCursor: hasMore ? String(offset + items.length) : undefined };
}

function isThreadIdRow(value: unknown): value is { readonly thread_id: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "thread_id" in value &&
    typeof value.thread_id === "string"
  );
}
