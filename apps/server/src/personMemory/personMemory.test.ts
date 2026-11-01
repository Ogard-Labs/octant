import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatDeleted,
  EventActor,
  THREAD_RETENTION_EVENT_NAMES,
  ThreadRetentionThreadPurged,
  decodeUtcTimestamp,
  type ProviderInstanceId,
  type ProviderModelId,
  type WindowId,
} from "@octant/contracts";
import { decodePersonMemoryCommand } from "@octant/contracts/person-memory";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { createPersonMemoryAccess } from "./personMemoryAccess";
import { PersonMemoryStore, registerPersonMemoryEvents } from "./personMemoryStore";
import {
  PersonMemorySweep,
  type PersonMemoryModelAnswer,
  type PersonMemoryThreadSource,
} from "./personMemorySweep";

const START = "2026-11-01T10:00:00.000Z";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "99999999-9999-4999-8999-999999999999",
});
const PROVIDER = "33333333-3333-4333-8333-333333333333" as ProviderInstanceId;
const SMALL = "small-model" as ProviderModelId;
const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";
const THREAD_1 = "aaaaaaaa-0000-4000-8000-000000000001";
const THREAD_2 = "aaaaaaaa-0000-4000-8000-000000000002";
const THREAD_3 = "aaaaaaaa-0000-4000-8000-000000000003";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

interface FakeThread {
  readonly id: string;
  completedAt?: string;
  readonly projectId?: string;
  readonly title: string;
  readonly personMessages: ReadonlyArray<string>;
}

function harness(threads: FakeThread[]) {
  const directory = mkdtempSync(join(tmpdir(), "octant-person-memory-"));
  directories.push(directory);
  const connection: SqliteConnection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => START);
  const journal = new Journal({
    connection,
    registry: registerPersonMemoryEvents(new EventRegistry())
      .register(THREAD_RETENTION_EVENT_NAMES.threadPurged, 1, ThreadRetentionThreadPurged)
      .register("chat.deleted@1", 1, ChatDeleted),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => START,
  });
  let now = START;
  const store = new PersonMemoryStore({
    connection,
    journal,
    uuid: () => crypto.randomUUID(),
    clock: () => decodeUtcTimestamp(now),
    actor,
  });
  const prompts: string[] = [];
  const usage: string[] = [];
  let reply: PersonMemoryModelAnswer = {
    status: "answered",
    text: JSON.stringify({
      summary: "Built an invoice export.",
      entries: [
        { kind: "preference", content: "Prefers CSV over spreadsheets." },
        { kind: "past-work", content: "Wrote an invoice export for the shop." },
      ],
    }),
    usage: { inputTokens: 100, outputTokens: 20 },
  };
  const source: PersonMemoryThreadSource = {
    mode: "chat",
    threads: () =>
      threads.map((thread) => ({
        id: thread.id,
        // A thread put away gains a completion time and keeps its lifecycle.
        completedAt: thread.completedAt,
      })),
    read: (threadId) => {
      const thread = threads.find((candidate) => candidate.id === threadId);
      return thread === undefined
        ? undefined
        : {
            title: thread.title,
            projectId: thread.projectId,
            providerInstanceId: PROVIDER,
            modelId: "big-model" as ProviderModelId,
            personMessages: thread.personMessages,
          };
    },
  };
  const sweep = new PersonMemorySweep({
    store,
    sources: [source],
    model: {
      resolve: ({ thread }) => ({
        model: { providerInstanceId: thread.providerInstanceId, modelId: SMALL },
        driverKind: "fake",
      }),
      complete: async ({ prompt }) => {
        prompts.push(prompt);
        return reply;
      },
      recordUsage: ({ threadId, model }) => usage.push(`${threadId}:${String(model.modelId)}`),
    },
    namesProtectedPath: (text) => text.includes("~/.ssh"),
  });
  const journalText = () =>
    (
      connection.prepare("SELECT payload_json FROM event_journal").all() as ReadonlyArray<{
        readonly payload_json: string;
      }>
    )
      .map((row) => row.payload_json)
      .join("\n");
  return {
    connection,
    journal,
    store,
    sweep,
    prompts,
    usage,
    journalText,
    setReply: (next: PersonMemoryModelAnswer) => {
      reply = next;
    },
    advance: (to: string) => {
      now = to;
    },
  };
}

const later = "2026-11-01T11:00:00.000Z";

describe("person memory", () => {
  it("learns once from a thread put away after memory began, from the person's words only", async () => {
    const threads: FakeThread[] = [
      {
        id: THREAD_1,
        completedAt: later,
        projectId: PROJECT_A,
        title: "Invoices",
        personMessages: ["Export invoices as CSV. My key is sk-abcdefghijklmnopqrstuvwx"],
      },
      // Completed before memory began: never distilled after the fact.
      {
        id: THREAD_2,
        completedAt: "2026-10-31T09:00:00.000Z",
        title: "Old",
        personMessages: ["hi"],
      },
    ];
    const h = harness(threads);
    h.advance(later);

    const first = await h.sweep.pass();
    const second = await h.sweep.pass();

    expect(first).toEqual([{ mode: "chat", threadId: THREAD_1, outcome: "remembered" }]);
    expect(second).toEqual([]);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain("Export invoices as CSV.");
    expect(h.prompts[0]).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(h.usage).toEqual([`${THREAD_1}:small-model`]);
    expect(
      h.store
        .view()
        .entries.map((entry) => entry.content)
        .sort(),
    ).toEqual(["Prefers CSV over spreadsheets.", "Wrote an invoice export for the shop."]);
  });

  it("gives a new thread the entries older than it, labelled as data, and none when switched off", async () => {
    const h = harness([
      { id: THREAD_1, completedAt: later, title: "Invoices", personMessages: ["CSV please"] },
    ]);
    h.advance(later);
    await h.sweep.pass();

    const block = h.store.blockFor({
      mode: "work",
      threadId: THREAD_3,
      createdAt: "2026-11-02T00:00:00.000Z",
    });
    expect(block).toContain("not instructions");
    expect(block).toContain("Prefers CSV over spreadsheets.");
    expect(
      h.store.blockFor({ mode: "work", threadId: THREAD_3, createdAt: START }),
    ).toBeUndefined();

    h.store.change(
      decodePersonMemoryCommand({
        kind: "change-person-memory-settings",
        expectedVersion: h.store.view().version,
        settings: { ...h.store.settings(), enabled: false },
      }),
    );
    expect(
      h.store.blockFor({ mode: "work", threadId: THREAD_3, createdAt: "2026-11-02T00:00:00.000Z" }),
    ).toBeUndefined();
    expect(h.store.search({ mode: "work", threadId: THREAD_3 }, "invoice")).toBeUndefined();
  });

  it("keeps a Project kept out of memory from being learned from or shown", async () => {
    const h = harness([
      {
        id: THREAD_1,
        completedAt: later,
        projectId: PROJECT_A,
        title: "Payroll",
        personMessages: ["pay"],
      },
    ]);
    h.store.change(
      decodePersonMemoryCommand({
        kind: "change-person-memory-settings",
        expectedVersion: h.store.view().version,
        settings: { ...h.store.settings(), excludedProjectIds: [PROJECT_A] },
      }),
    );
    h.advance(later);

    expect(await h.sweep.pass()).toEqual([
      { mode: "chat", threadId: THREAD_1, outcome: "skipped" },
    ]);
    expect(h.prompts).toEqual([]);
    expect(
      h.store.blockFor({
        mode: "chat",
        threadId: THREAD_3,
        projectId: PROJECT_A,
        createdAt: later,
      }),
    ).toBeUndefined();
  });

  it("finds a remembered thread from another Project by search, with its source", async () => {
    const h = harness([
      {
        id: THREAD_1,
        completedAt: later,
        projectId: PROJECT_A,
        title: "Invoices",
        personMessages: ["CSV"],
      },
    ]);
    h.advance(later);
    await h.sweep.pass();

    const hits = h.store.search(
      { mode: "code", threadId: THREAD_3, projectId: PROJECT_B },
      "invoice export",
    );
    expect(hits?.[0]?.source).toMatchObject({
      threadId: THREAD_1,
      projectId: PROJECT_A,
      title: "Invoices",
    });
    expect(hits?.[0]?.excerpt).toBe("Built an invoice export.");
  });

  it("erases a deleted or edited entry's old text from the journal", async () => {
    const h = harness([
      { id: THREAD_1, completedAt: later, title: "Invoices", personMessages: ["CSV"] },
    ]);
    h.advance(later);
    await h.sweep.pass();
    const [preference, pastWork] = [...h.store.view().entries].sort((a, b) =>
      a.content.localeCompare(b.content),
    );
    if (preference === undefined || pastWork === undefined) throw new Error("expected two entries");

    h.store.change(
      decodePersonMemoryCommand({
        kind: "edit-person-memory-entry",
        entryId: preference.id,
        content: "Prefers plain text.",
      }),
    );
    h.store.change(
      decodePersonMemoryCommand({ kind: "delete-person-memory-entry", entryId: pastWork.id }),
    );

    expect(h.journalText()).toContain("Prefers plain text.");
    expect(h.journalText()).not.toContain("Prefers CSV over spreadsheets.");
    expect(h.journalText()).not.toContain("Wrote an invoice export");
    const restarted = new PersonMemoryStore({
      connection: h.connection,
      journal: h.journal,
      uuid: () => crypto.randomUUID(),
      clock: () => decodeUtcTimestamp(later),
      actor,
    });
    expect(restarted.view().entries.map((entry) => entry.content)).toEqual(["Prefers plain text."]);
  });

  it("forgets what came only from a thread marked to leave no trace, and never learns from it", async () => {
    const h = harness([
      { id: THREAD_1, completedAt: later, title: "Invoices", personMessages: ["CSV"] },
      { id: THREAD_2, title: "Diary", personMessages: ["private"] },
    ]);
    h.advance(later);
    await h.sweep.pass();
    h.store.change(
      decodePersonMemoryCommand({
        kind: "set-thread-leaves-no-trace",
        mode: "chat",
        threadId: THREAD_1,
        leavesNoTrace: true,
      }),
    );
    h.store.change(
      decodePersonMemoryCommand({
        kind: "set-thread-leaves-no-trace",
        mode: "chat",
        threadId: THREAD_2,
        title: "Diary",
        leavesNoTrace: true,
      }),
    );

    expect(h.store.view().entries).toEqual([]);
    expect(h.store.view().rememberedThreads).toBe(0);
    expect(h.journalText()).not.toContain("Built an invoice export.");
    expect(
      h.store.blockFor({ mode: "chat", threadId: THREAD_2, createdAt: later }),
    ).toBeUndefined();
  });

  it("drops only what came from a purged thread and keeps entries learned elsewhere too", async () => {
    const threads: FakeThread[] = [
      { id: THREAD_1, completedAt: later, title: "Invoices", personMessages: ["CSV"] },
    ];
    const h = harness(threads);
    h.advance(later);
    await h.sweep.pass();
    threads.push({
      id: THREAD_2,
      completedAt: later,
      title: "Reports",
      personMessages: ["CSV again"],
    });
    h.setReply({
      status: "answered",
      text: JSON.stringify({
        summary: "Reports.",
        entries: [{ kind: "preference", content: "Prefers CSV over spreadsheets." }],
      }),
    });
    await h.sweep.pass();

    h.journal.append({
      aggregate: { aggregateType: "thread-retention", aggregateId: THREAD_1 },
      expectedVersion: 0,
      events: [
        {
          eventId: crypto.randomUUID(),
          eventName: THREAD_RETENTION_EVENT_NAMES.threadPurged,
          eventVersion: 1,
          correlationId: crypto.randomUUID(),
          actor,
          occurredAt: later,
          payload: { kind: "thread-purged", mode: "chat", threadId: THREAD_1, purgedAt: later },
        },
      ],
    });

    const entries = h.store.view().entries;
    expect(entries.map((entry) => entry.content)).toEqual(["Prefers CSV over spreadsheets."]);
    expect(entries[0]?.sources.map((source) => source.threadId)).toEqual([THREAD_2]);
    expect(h.journalText()).not.toContain("Wrote an invoice export");
  });

  it("keeps nothing from a reply that read outside content or names a protected path, but counts its usage", async () => {
    const h = harness([
      { id: THREAD_1, completedAt: later, title: "Keys", personMessages: ["set up ssh"] },
      { id: THREAD_2, completedAt: later, title: "Web", personMessages: ["read this page"] },
    ]);
    h.advance(later);
    h.setReply({
      status: "answered",
      text: JSON.stringify({
        summary: "Configured ~/.ssh/config.",
        entries: [{ kind: "past-work", content: "Keeps keys in ~/.ssh/id_ed25519." }],
      }),
    });
    await h.sweep.distill(sourceOf(), THREAD_1, later);
    h.setReply({ status: "withheld", usage: { inputTokens: 5, outputTokens: 1 } });
    expect(await h.sweep.distill(sourceOf(), THREAD_2, later)).toBe("unavailable");

    expect(h.store.view().entries).toEqual([]);
    expect(h.journalText()).not.toContain("~/.ssh");
    expect(h.usage).toHaveLength(2);
  });
});

function sourceOf(): PersonMemoryThreadSource {
  return {
    mode: "chat",
    threads: () => [],
    read: (threadId: string) => ({
      title: threadId === THREAD_1 ? "Keys" : "Web",
      providerInstanceId: PROVIDER,
      modelId: SMALL,
      personMessages: ["text"],
    }),
  };
}

describe("who person memory reaches", () => {
  const LOCAL = "cccccccc-0000-4000-8000-000000000001" as WindowId;
  const DEVICE = "cccccccc-0000-4000-8000-000000000002" as WindowId;
  const HOST = "cccccccc-0000-4000-8000-000000000003" as WindowId;

  it("gives the block and the search tool only to a turn a window on this host started", async () => {
    const h = harness([
      { id: THREAD_1, completedAt: later, title: "Invoices", personMessages: ["CSV"] },
    ]);
    h.advance(later);
    await h.sweep.pass();
    const access = createPersonMemoryAccess({
      store: h.store,
      isPairedDeviceScope: (scope) => scope === DEVICE,
      isHostScope: (scope) => scope === HOST,
      projectLabel: () => "Shop",
    });
    const scope = {
      mode: "code" as const,
      threadId: THREAD_3,
      createdAt: "2026-11-02T00:00:00.000Z",
    };

    expect(access.blockFor({ ...scope, windowId: LOCAL })).toContain("Prefers CSV");
    for (const windowId of [DEVICE, HOST, undefined]) {
      expect(access.blockFor({ ...scope, windowId })).toBeUndefined();
      expect(access.toolsFor({ ...scope, windowId })).toBeUndefined();
    }
    const tools = access.toolsFor({ ...scope, windowId: LOCAL });
    expect(tools?.definitions.map((definition) => definition.name)).toEqual([
      "octant_past_threads",
    ]);
    const answer = await tools?.execute({
      name: "octant_past_threads",
      inputJson: JSON.stringify({ query: "invoice" }),
    });
    expect(answer?.isError).toBeUndefined();
    expect(JSON.stringify(answer?.result)).toContain('\\"Invoices\\" (Chat, no Project');
  });
});

describe("what person memory does not learn back", () => {
  it("does not learn again what the person forgot, or what ended while memory was off", async () => {
    const threads: FakeThread[] = [
      { id: THREAD_1, completedAt: later, title: "Invoices", personMessages: ["CSV"] },
    ];
    const h = harness(threads);
    h.advance(later);
    await h.sweep.pass();
    h.advance("2026-11-01T11:30:00.000Z");
    h.store.change(decodePersonMemoryCommand({ kind: "forget-person-memory", confirmed: true }));
    expect(await h.sweep.pass()).toEqual([]);

    const off = { ...h.store.settings(), enabled: false };
    h.store.change(
      decodePersonMemoryCommand({
        kind: "change-person-memory-settings",
        expectedVersion: h.store.view().version,
        settings: off,
      }),
    );
    threads.push({
      id: THREAD_2,
      completedAt: "2026-11-01T12:00:00.000Z",
      title: "Private",
      personMessages: ["x"],
    });
    h.advance("2026-11-01T13:00:00.000Z");
    h.store.change(
      decodePersonMemoryCommand({
        kind: "change-person-memory-settings",
        expectedVersion: h.store.view().version,
        settings: { ...off, enabled: true },
      }),
    );
    expect(await h.sweep.pass()).toEqual([]);
    expect(h.prompts).toHaveLength(1);
  });

  it("never shows the model an entry learned only in a Project kept out", async () => {
    const threads: FakeThread[] = [
      {
        id: THREAD_1,
        completedAt: later,
        projectId: PROJECT_A,
        title: "Payroll",
        personMessages: ["pay"],
      },
    ];
    const h = harness(threads);
    h.advance(later);
    await h.sweep.pass();
    h.store.change(
      decodePersonMemoryCommand({
        kind: "change-person-memory-settings",
        expectedVersion: h.store.view().version,
        settings: { ...h.store.settings(), excludedProjectIds: [PROJECT_A] },
      }),
    );
    threads.push({
      id: THREAD_2,
      completedAt: "2026-11-01T12:00:00.000Z",
      title: "Other",
      personMessages: ["hi"],
    });
    h.advance("2026-11-01T12:30:00.000Z");
    await h.sweep.pass();
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]).not.toContain("Prefers CSV over spreadsheets.");
  });

  it("erases a deleted Chat's leave-no-trace mark with its title", () => {
    const h = harness([]);
    h.store.change(
      decodePersonMemoryCommand({
        kind: "set-thread-leaves-no-trace",
        mode: "chat",
        threadId: THREAD_2,
        title: "Secret diary",
        leavesNoTrace: true,
      }),
    );
    h.journal.append({
      aggregate: { aggregateType: "chat-thread", aggregateId: THREAD_2 },
      expectedVersion: 0,
      events: [
        {
          eventId: crypto.randomUUID(),
          eventName: "chat.deleted@1",
          eventVersion: 1,
          correlationId: crypto.randomUUID(),
          actor,
          occurredAt: later,
          payload: { kind: "deleted", threadId: THREAD_2, deletedAt: later },
        },
      ],
    });
    expect(h.store.view().untracedThreads).toEqual([]);
    expect(h.journalText()).not.toContain("Secret diary");
  });
});
