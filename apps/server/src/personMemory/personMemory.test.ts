import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChatDeleted,
  EventActor,
  HUB_DELEGATION_RECORDED,
  HubDelegationRecordedPayload,
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
import { readReceivedDelegationThreadIds } from "../hub/delegationJournal";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { BENCHMARKS_PROJECT_ID } from "../benchmarks/benchmarkChatPort";
import { keepBenchmarksOutOfPersonMemory } from "../benchmarks/benchmarkMemory";
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
      .register("chat.deleted@1", 1, ChatDeleted)
      .register(HUB_DELEGATION_RECORDED, 1, HubDelegationRecordedPayload),
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
  const HUB_DEVICE = "cccccccc-0000-4000-8000-000000000004" as WindowId;

  it("gives the block and the search tool to a local window, a paired device, a routine, and other host-started turns", async () => {
    const h = harness([
      { id: THREAD_1, completedAt: later, title: "Invoices", personMessages: ["CSV"] },
    ]);
    h.advance(later);
    await h.sweep.pass();
    const access = createPersonMemoryAccess({
      store: h.store,
      isRestrictedDeviceScope: (scope) => scope === HUB_DEVICE,
      projectLabel: () => "Shop",
    });
    const scope = {
      mode: "code" as const,
      threadId: THREAD_3,
      createdAt: "2026-11-02T00:00:00.000Z",
    };

    const localBlock = access.blockFor({ ...scope, windowId: LOCAL });
    expect(localBlock).toContain("Prefers CSV");
    for (const windowId of [LOCAL, DEVICE, HOST]) {
      expect(access.blockFor({ ...scope, windowId })).toBe(localBlock);
      const tools = access.toolsFor({ ...scope, windowId });
      expect(tools?.definitions.map((definition) => definition.name)).toEqual([
        "octant_past_threads",
      ]);
      const answer = await tools?.execute({
        name: "octant_past_threads",
        inputJson: JSON.stringify({ query: "invoice" }),
      });
      expect(answer?.isError).toBeUndefined();
      expect(JSON.stringify(answer?.result)).toContain('\\"Invoices\\" (Chat, no Project');
    }

    for (const windowId of [HUB_DEVICE, undefined]) {
      expect(access.blockFor({ ...scope, windowId })).toBeUndefined();
      expect(access.toolsFor({ ...scope, windowId })).toBeUndefined();
    }

    h.store.change(
      decodePersonMemoryCommand({
        kind: "change-person-memory-settings",
        expectedVersion: h.store.view().version,
        settings: { ...h.store.settings(), enabled: false },
      }),
    );
    for (const windowId of [LOCAL, DEVICE, HOST]) {
      expect(access.blockFor({ ...scope, windowId })).toBeUndefined();
      expect(access.toolsFor({ ...scope, windowId })).toBeUndefined();
    }
  });

  it("gives a subagent its lead thread's block and search tool, never newer or withheld entries, and neither when tools or memory are off", async () => {
    const threads: FakeThread[] = [
      {
        id: THREAD_1,
        completedAt: later,
        projectId: PROJECT_A,
        title: "Invoices",
        personMessages: ["CSV"],
      },
    ];
    const h = harness(threads);
    h.advance(later);
    await h.sweep.pass();

    const leadCreatedAt = "2026-11-02T00:00:00.000Z";
    const afterLead = "2026-11-03T00:00:00.000Z";
    threads.push({
      id: THREAD_2,
      completedAt: afterLead,
      projectId: PROJECT_B,
      title: "Later work",
      personMessages: ["Use YAML"],
    });
    h.setReply({
      status: "answered",
      text: JSON.stringify({
        summary: "Switched to YAML.",
        entries: [{ kind: "preference", content: "Prefers YAML over TOML." }],
      }),
    });
    h.advance(afterLead);
    await h.sweep.pass();

    const access = createPersonMemoryAccess({
      store: h.store,
      isRestrictedDeviceScope: (scope) => scope === HUB_DEVICE,
      projectLabel: (projectId) => (projectId === PROJECT_A ? "Shop" : "Warehouse"),
    });
    const lead = {
      mode: "work" as const,
      threadId: THREAD_3,
      projectId: PROJECT_B,
      createdAt: leadCreatedAt,
      windowId: LOCAL,
    };

    const childBlock = access.childBlockFor(lead);
    expect(childBlock).toBe(access.blockFor(lead));
    expect(childBlock).toContain("Prefers CSV");
    // Learned after the lead thread was created: absent from the lead's block and the child's.
    expect(childBlock).not.toContain("Prefers YAML");

    const childTools = access.childToolsFor(lead, { tools: true });
    expect(childTools?.definitions.map((definition) => definition.name)).toEqual([
      "octant_past_threads",
    ]);
    const answer = await childTools?.execute({
      name: "octant_past_threads",
      inputJson: JSON.stringify({ query: "invoice" }),
    });
    expect(answer?.isError).toBeUndefined();
    expect(JSON.stringify(answer?.result)).toContain('\\"Invoices\\" (Chat, Shop');

    // A child with tools disabled gets no search tool.
    expect(access.childToolsFor(lead, { tools: false })).toBeUndefined();

    // A child delegated from a hub-introduced device or unknown scope gets neither block nor tool.
    for (const restrictedWindow of [HUB_DEVICE, undefined]) {
      expect(access.childBlockFor({ ...lead, windowId: restrictedWindow })).toBeUndefined();
      expect(
        access.childToolsFor({ ...lead, windowId: restrictedWindow }, { tools: true }),
      ).toBeUndefined();
    }

    // If a child's live scope later narrows to a restricted device or disappears, search refuses.
    let currentOwner: WindowId | undefined = LOCAL;
    const liveChildTools = access.childToolsFor(lead, { tools: true }, () => currentOwner);
    currentOwner = HUB_DEVICE;
    const refusedSearch = await liveChildTools?.execute({
      name: "octant_past_threads",
      inputJson: JSON.stringify({ query: "invoice" }),
    });
    expect(refusedSearch?.isError).toBe(true);

    // A child whose lead is in a Project kept out of memory gets neither.
    h.store.change(
      decodePersonMemoryCommand({
        kind: "change-person-memory-settings",
        expectedVersion: h.store.view().version,
        settings: { ...h.store.settings(), excludedProjectIds: [PROJECT_B] },
      }),
    );
    expect(access.childBlockFor(lead)).toBeUndefined();
    expect(access.childToolsFor(lead, { tools: true })).toBeUndefined();

    // A child whose lead is marked Leave no trace gets neither.
    const ordinaryLead = {
      mode: "work" as const,
      threadId: THREAD_3,
      projectId: PROJECT_A,
      createdAt: leadCreatedAt,
      windowId: LOCAL,
    };
    expect(access.childBlockFor(ordinaryLead)).toContain("Prefers CSV");
    h.store.change(
      decodePersonMemoryCommand({
        kind: "set-thread-leaves-no-trace",
        mode: "work",
        threadId: THREAD_3,
        leavesNoTrace: true,
      }),
    );
    expect(access.childBlockFor(ordinaryLead)).toBeUndefined();
    expect(access.childToolsFor(ordinaryLead, { tools: true })).toBeUndefined();

    // With memory switched off, a child in a participating lead gets neither.
    h.store.change(
      decodePersonMemoryCommand({
        kind: "change-person-memory-settings",
        expectedVersion: h.store.view().version,
        settings: { ...h.store.settings(), enabled: false, excludedProjectIds: [] },
      }),
    );
    const otherLead = {
      mode: "code" as const,
      threadId: "aaaaaaaa-0000-4000-8000-000000000004",
      projectId: PROJECT_A,
      createdAt: leadCreatedAt,
      windowId: LOCAL,
    };
    expect(access.childBlockFor(otherLead)).toBeUndefined();
    expect(access.childToolsFor(otherLead, { tools: true })).toBeUndefined();
  });

  it("withholds person memory from a peer-delegated Work thread and its subagents, including after journal replay", async () => {
    const h = harness([
      {
        id: THREAD_1,
        completedAt: later,
        projectId: PROJECT_A,
        title: "Private payroll",
        personMessages: ["CSV"],
      },
    ]);
    h.advance(later);
    await h.sweep.pass();

    const peerThreadId = "aaaaaaaa-0000-4000-8000-000000000099";
    h.journal.append({
      aggregate: {
        aggregateType: "hub-delegation",
        aggregateId: "77777777-7777-4777-8777-777777777777",
      },
      expectedVersion: 0,
      events: [
        {
          eventId: crypto.randomUUID(),
          eventName: HUB_DELEGATION_RECORDED,
          eventVersion: 1,
          correlationId: crypto.randomUUID(),
          actor,
          occurredAt: later,
          payload: {
            change: "received",
            actingPrincipal: {
              kind: "peer",
              memberId: "66666666-6666-4666-8666-666666666666",
            },
            requestId: "55555555-5555-4555-8555-555555555555",
            memberId: "66666666-6666-4666-8666-666666666666",
            projectId: PROJECT_B,
            threadId: peerThreadId,
          },
        },
      ],
    });
    const withheld = readReceivedDelegationThreadIds(h.journal);
    expect(withheld.has(peerThreadId)).toBe(true);

    const access = createPersonMemoryAccess({
      store: h.store,
      isRestrictedDeviceScope: (scope) => scope === HUB_DEVICE,
      isThreadWithheld: (threadId) => withheld.has(threadId),
      projectLabel: () => "Shop",
    });

    const peerScope = {
      mode: "work" as const,
      threadId: peerThreadId,
      projectId: PROJECT_B,
      createdAt: "2026-11-02T00:00:00.000Z",
      windowId: HOST,
    };
    expect(access.blockFor(peerScope)).toBeUndefined();
    expect(access.toolsFor(peerScope)).toBeUndefined();
    expect(access.childBlockFor(peerScope)).toBeUndefined();
    expect(access.childToolsFor(peerScope, { tools: true })).toBeUndefined();

    // An ordinary routine thread under the same host scope still reads person memory.
    const routineScope = { ...peerScope, threadId: THREAD_3 };
    expect(access.blockFor(routineScope)).toContain("Prefers CSV");
    expect(access.toolsFor(routineScope)?.definitions.map((d) => d.name)).toEqual([
      "octant_past_threads",
    ]);
  });
});

describe("benchmark threads and person memory", () => {
  const LOCAL = "cccccccc-0000-4000-8000-000000000001" as WindowId;
  const benchmarkProject = String(BENCHMARKS_PROJECT_ID);

  it("gives a judge or contender thread in the Benchmarks Project no memory block or search tool, and learns nothing from it", async () => {
    const h = harness([
      { id: THREAD_1, completedAt: later, title: "Invoices", personMessages: ["CSV"] },
      {
        id: THREAD_2,
        completedAt: later,
        projectId: benchmarkProject,
        title: "Smoke · Greeting · model-a",
        personMessages: ["Say hello."],
      },
    ]);
    h.advance(later);
    expect(keepBenchmarksOutOfPersonMemory(h.store)).toEqual({ status: "kept-out" });
    expect(keepBenchmarksOutOfPersonMemory(h.store)).toEqual({ status: "kept-out" });
    expect(h.store.settings().excludedProjectIds).toEqual([benchmarkProject]);

    const outcomes = await h.sweep.pass();

    expect(outcomes.find((entry) => entry.threadId === THREAD_2)?.outcome).toBe("skipped");
    expect(h.prompts.join("\n")).not.toContain("Say hello.");
    const access = createPersonMemoryAccess({
      store: h.store,
      projectLabel: () => undefined,
    });
    const scope = {
      mode: "chat" as const,
      threadId: THREAD_3,
      createdAt: "2026-11-02T00:00:00.000Z",
    };
    // An ordinary thread from a local window still gets the block; the judge's does not,
    // even when a window started it.
    expect(access.blockFor({ ...scope, windowId: LOCAL })).toContain("Prefers CSV");
    const judge = { ...scope, projectId: benchmarkProject };
    expect(access.blockFor({ ...judge, windowId: LOCAL })).toBeUndefined();
    expect(access.toolsFor({ ...judge, windowId: LOCAL })).toBeUndefined();
    // The runner sends its turns with no window, which memory never serves either.
    expect(access.blockFor({ ...judge, windowId: undefined })).toBeUndefined();
  });
});

describe("who a memory change is journaled as", () => {
  it("journals a paired device's memory changes with the device as their actor, and a local window's as the local user", () => {
    const deviceId = "00000000-0000-4000-8000-0000000000d1";
    const device = { kind: "remote-device", actorId: deviceId, deviceId } as never;
    const actorsOf = (actor?: never) => {
      const h = harness([]);
      const before = h.journal.headSequence();
      h.store.change(
        decodePersonMemoryCommand({
          kind: "change-person-memory-settings",
          expectedVersion: h.store.view().version,
          settings: { ...h.store.settings(), enabled: false },
        }),
        actor,
      );
      h.store.change(
        decodePersonMemoryCommand({ kind: "forget-person-memory", confirmed: true }),
        actor,
      );
      return h.journal
        .replay({ afterSequence: before as never, limit: 100 } as never)
        .map((event) => event.actor);
    };

    expect(actorsOf(device)).toEqual([device, device]);
    expect(actorsOf().map((actor) => actor.kind)).toEqual(["local-user", "local-user"]);
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

describe("person memory under timing and volume", () => {
  it("keeps nothing from a call that was still running when the person forgot everything", async () => {
    const h = harness([
      { id: THREAD_1, completedAt: later, title: "Invoices", personMessages: ["CSV"] },
    ]);
    h.advance(later);
    h.store.since();
    let answer: (value: PersonMemoryModelAnswer) => void = () => undefined;
    const pending = new Promise<PersonMemoryModelAnswer>((resolve) => {
      answer = resolve;
    });
    const sweep = new PersonMemorySweep({
      store: h.store,
      sources: [
        {
          mode: "chat",
          threads: () => [{ id: THREAD_1, completedAt: later }],
          read: () => ({
            title: "Invoices",
            providerInstanceId: PROVIDER,
            modelId: SMALL,
            personMessages: ["CSV"],
          }),
        },
      ],
      model: {
        resolve: ({ thread }) => ({
          model: { providerInstanceId: thread.providerInstanceId, modelId: SMALL },
          driverKind: "fake",
        }),
        complete: () => pending,
        recordUsage: () => undefined,
      },
      namesProtectedPath: () => false,
    });
    const running = sweep.pass();
    await Promise.resolve();
    h.advance("2026-11-01T11:30:00.000Z");
    h.store.change(decodePersonMemoryCommand({ kind: "forget-person-memory", confirmed: true }));
    answer({
      status: "answered",
      text: JSON.stringify({
        summary: "Invoices.",
        entries: [{ kind: "preference", content: "Prefers CSV." }],
      }),
    });
    await running;
    expect(h.store.view().entries).toEqual([]);
    expect(h.store.view().rememberedThreads).toBe(0);
  });

  it("does not let threads of a Project kept out use up a pass", async () => {
    const threads: FakeThread[] = Array.from({ length: 12 }, (_, index) => ({
      id: `aaaaaaaa-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
      completedAt: later,
      projectId: PROJECT_A,
      title: `Payroll ${index}`,
      personMessages: ["pay"],
    }));
    threads.push({
      id: THREAD_3,
      completedAt: later,
      projectId: PROJECT_B,
      title: "Shop",
      personMessages: ["CSV"],
    });
    const h = harness(threads);
    h.store.change(
      decodePersonMemoryCommand({
        kind: "change-person-memory-settings",
        expectedVersion: h.store.view().version,
        settings: { ...h.store.settings(), excludedProjectIds: [PROJECT_A] },
      }),
    );
    h.advance(later);
    const results = await h.sweep.pass();
    expect(
      results.filter((result) => result.outcome === "remembered").map((result) => result.threadId),
    ).toEqual([THREAD_3]);
  });
});
