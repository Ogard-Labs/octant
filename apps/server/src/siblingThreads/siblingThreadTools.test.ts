import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventActor,
  GlobalSequence,
  MAX_NATIVE_HARNESS_DELEGATE_WAIT_MS,
  MAX_SIBLING_THREAD_READS_PER_TURN,
  MAX_SIBLING_THREAD_WAITS_PER_TURN,
  MAX_THREAD_MENTION_TRANSCRIPT_CHARACTERS,
  MAX_THREAD_MENTION_TRANSCRIPT_ENTRIES,
  SIBLING_THREAD_EVENT_NAMES,
  SIBLING_THREAD_OBSERVATION_AGGREGATE,
  SIBLING_THREADS_TOOL_NAME,
  THREAD_EXTERNAL_CONTENT_AGGREGATE,
  THREAD_EXTERNAL_CONTENT_EVENT_NAMES,
  decodeCodeThreadId,
  decodeProjectId,
  decodeSiblingThreadObserved,
  decodeThreadRetentionThreadId,
  type CodeThreadId,
  type ThreadMentionTranscriptEntry,
} from "@octant/contracts";
import { SIBLING_THREAD_UNREACHABLE } from "@octant/domain";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { EXTERNAL_CONTENT_FRAME_OPEN_PREFIX } from "../context/externalContentFraming";
import { ExternalContentIngestionStore } from "../context/externalContentIngestionStore";
import { readThreadExternalContentTaint } from "../context/externalContentTaintProjection";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { erasePurgedThread } from "../persistence/threadPurge";
import { openSqlite } from "../persistence/sqlitePort";
import {
  SiblingThreadsService,
  createSiblingThreadTools,
  type SiblingThreadSnapshot,
  type SiblingThreadSource,
} from "./siblingThreadTools";

const decodeActor = Schema.decodeUnknownSync(EventActor);
const journalStart = Schema.decodeUnknownSync(GlobalSequence)(0);
const now = "2026-10-14T08:00:00.000Z";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const projectA = decodeProjectId("a0000000-0000-4000-8000-000000000001");
const projectB = decodeProjectId("b0000000-0000-4000-8000-000000000001");
const ids = {
  caller: thread("c0000000-0000-4000-8000-000000000001"),
  working: thread("c0000000-0000-4000-8000-000000000002"),
  idle: thread("c0000000-0000-4000-8000-000000000003"),
  waiting: thread("c0000000-0000-4000-8000-000000000004"),
  completed: thread("c0000000-0000-4000-8000-000000000005"),
  otherProject: thread("c0000000-0000-4000-8000-000000000006"),
  work: thread("c0000000-0000-4000-8000-000000000007"),
  // A child run is not a thread the host resolves, so its id is unknown here.
  childRun: thread("c0000000-0000-4000-8000-000000000008"),
};

function thread(value: string): CodeThreadId {
  return decodeCodeThreadId(value);
}

function referenceTo(threadId: CodeThreadId, projectId = projectA): string {
  return `${String(threadId)}@${String(projectId)}`;
}

function snapshot(
  threadId: CodeThreadId,
  overrides: Partial<SiblingThreadSnapshot> = {},
): SiblingThreadSnapshot {
  return {
    threadId,
    projectId: projectA,
    mode: "code",
    closed: false,
    title: `Thread ${String(threadId).slice(-1)}`,
    state: "idle",
    stateChangedAt: "2026-10-14T07:00:00.000Z",
    ...overrides,
  };
}

function transcriptOf(count: number, characters: number): ThreadMentionTranscriptEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: `${String(index).padStart(3, "0")} ${"x".repeat(characters - 4)}`,
    occurredAt: now as never,
  }));
}

interface HarnessOptions {
  readonly markFails?: boolean;
  readonly toolConstraints?: ReadonlyArray<string>;
}

function harness(options: HarnessOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "octant-sibling-threads-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const actor = decodeActor({ kind: "system", actorId: "e0000000-0000-4000-8000-000000000001" });
  const ingestion = new ExternalContentIngestionStore({
    journal,
    connection,
    uuid: randomUUID,
    clock: () => now,
    actor,
  });
  const threads = new Map<string, SiblingThreadSnapshot>([
    [String(ids.caller), snapshot(ids.caller, { state: "working" })],
    [
      String(ids.working),
      snapshot(ids.working, { state: "working", stateChangedAt: "2026-10-14T07:30:00.000Z" }),
    ],
    [String(ids.idle), snapshot(ids.idle, { stateChangedAt: "2026-10-14T07:10:00.000Z" })],
    [
      String(ids.waiting),
      snapshot(ids.waiting, {
        state: "waiting-for-person",
        stateChangedAt: "2026-10-14T07:20:00.000Z",
      }),
    ],
    [String(ids.completed), snapshot(ids.completed, { closed: true })],
    [String(ids.otherProject), snapshot(ids.otherProject, { projectId: projectB })],
    [String(ids.work), snapshot(ids.work, { mode: "work" })],
  ]);
  const transcripts = new Map<string, ReadonlyArray<ThreadMentionTranscriptEntry>>([
    [String(ids.working), transcriptOf(3, 40)],
    [String(ids.idle), transcriptOf(3, 40)],
    [String(ids.waiting), transcriptOf(20, 1_000)],
  ]);
  const transcriptReads: string[] = [];
  const source: SiblingThreadSource = {
    thread: (threadId) => threads.get(String(threadId)),
    projectThreads: (projectId) =>
      [...threads.values()].filter((entry) => String(entry.projectId) === String(projectId)),
    readTranscript: async (threadId) => {
      transcriptReads.push(String(threadId));
      return transcripts.get(String(threadId));
    },
  };
  let clockMs = Date.parse(now);
  const slept: number[] = [];
  let onSleep: (() => void) | undefined;
  const service = new SiblingThreadsService({
    journal,
    connection,
    uuid: randomUUID,
    clock: () => now,
    actor,
    recordExternalContentIngestion: (input) =>
      options.markFails === true
        ? { kind: "refused", reason: "malformed" }
        : ingestion.record(input),
    now: () => clockMs,
    sleep: async (ms) => {
      slept.push(ms);
      clockMs += ms;
      onSleep?.();
    },
  });
  const newTurn = () =>
    createSiblingThreadTools({
      service,
      source,
      callerThreadId: String(ids.caller),
      toolConstraints: options.toolConstraints ?? [],
      profileDisplayName: "Reviewer",
    });
  const tools = newTurn();
  const call = async (input: unknown, signal?: AbortSignal, turn = tools) =>
    await turn.execute({
      name: SIBLING_THREADS_TOOL_NAME,
      inputJson: JSON.stringify(input),
      ...(signal === undefined ? {} : { signal }),
    });
  const events = () => journal.replay({ afterSequence: journalStart, limit: 1_000 });
  const observations = (readerId = String(ids.caller)) =>
    // A journal opened afresh over the same database is what a restarted host replays.
    new Journal({
      connection,
      registry: createPhase1RuntimeRegistries().events,
      projections: createPhase1RuntimeRegistries().projections,
      clock: () => now,
    })
      .replayAggregate({
        aggregateType: SIBLING_THREAD_OBSERVATION_AGGREGATE,
        aggregateId: readerId,
        afterVersion: 0,
        limit: 1_000,
      })
      .map((event) => ({
        eventName: event.eventName,
        payload: decodeSiblingThreadObserved(event.payload),
        payloadJson: JSON.stringify(event.payload),
      }));
  const marks = () =>
    events().filter(
      (event) =>
        event.aggregateType === THREAD_EXTERNAL_CONTENT_AGGREGATE &&
        event.eventName === THREAD_EXTERNAL_CONTENT_EVENT_NAMES.ingested,
    );
  return {
    tools,
    newTurn,
    call,
    threads,
    transcripts,
    transcriptReads,
    events,
    observations,
    marks,
    slept,
    connection,
    setOnSleep: (next: (() => void) | undefined) => {
      onSleep = next;
    },
  };
}

/** The answer inside a framed result, after checking it arrived as framed data. */
function unframe(result: unknown): Record<string, unknown> {
  expect(typeof result).toBe("string");
  const text = result as string;
  expect(text.startsWith(`${EXTERNAL_CONTENT_FRAME_OPEN_PREFIX} origin="external-content"`)).toBe(
    true,
  );
  const lines = text.split("\n");
  return JSON.parse(lines.slice(1, -1).join("\n")) as Record<string, unknown>;
}

describe("the sibling threads tool", () => {
  it("lists only the other open Code threads of the caller's Project, most recently changed first", async () => {
    const { call, threads } = harness();
    threads.set(
      String(ids.idle),
      snapshot(ids.idle, {
        title: `  ${"Long title ".repeat(60)}  `,
        stateChangedAt: "2026-10-14T07:10:00.000Z",
      }),
    );

    const { result, isError } = await call({ action: "list" });

    expect(isError).toBe(false);
    const answer = unframe(result);
    expect(answer.status).toBe("listed");
    expect(answer.truncated).toBe(false);
    const rows = answer.threads as ReadonlyArray<{
      readonly reference: string;
      readonly title: string;
      readonly state: string;
    }>;
    expect(rows.map((row) => row.reference)).toEqual([
      referenceTo(ids.working),
      referenceTo(ids.waiting),
      referenceTo(ids.idle),
    ]);
    expect(rows.map((row) => row.state)).toEqual(["working", "waiting-for-person", "idle"]);
    // A long title is cut to the contract's bound instead of failing the answer.
    expect(rows[2]?.title.length).toBe(400);
    expect(rows[2]?.title.endsWith("…")).toBe(true);
  });

  it("marks the caller for every list, and withholds the titles when the mark cannot be recorded", async () => {
    const marked = harness();
    await marked.call({ action: "list" });
    await marked.call({ action: "list" });
    expect(marked.marks()).toHaveLength(2);
    expect(readThreadExternalContentTaint(marked.connection, String(ids.caller))).toEqual({
      externalContentIngested: true,
      ingestedSources: ["sibling-thread"],
    });

    const unmarked = harness({ markFails: true });
    const { result, isError } = await unmarked.call({ action: "list" });
    expect(isError).toBe(true);
    expect(result).toEqual({
      status: "refused",
      reason: "unavailable",
      message:
        "The host could not record that this thread read outside content, so it returned nothing.",
    });
    expect(JSON.stringify(result)).not.toContain("Thread");
  });

  it("refuses every reference outside the readable set in the words of an unknown one", async () => {
    const { call, marks, observations, transcriptReads, newTurn } = harness();
    const outside = [
      referenceTo(ids.caller),
      referenceTo(ids.completed),
      referenceTo(ids.otherProject, projectB),
      referenceTo(ids.otherProject),
      referenceTo(ids.work),
      referenceTo(ids.childRun),
      referenceTo(ids.working, projectB),
      "not a reference",
    ];

    for (const reference of outside) {
      for (const action of ["read", "wait"] as const) {
        // A fresh turn per call keeps the per-turn bounds out of this case.
        const { result, isError } = await call({ action, reference }, undefined, newTurn());
        expect(isError).toBe(true);
        expect(result).toEqual({
          status: "refused",
          reason: "unauthorized",
          message: SIBLING_THREAD_UNREACHABLE,
        });
      }
    }
    expect(transcriptReads).toEqual([]);
    expect(marks()).toEqual([]);
    expect(observations()).toEqual([]);
  });

  it("reads the mention window as framed data, within 12 entries and 8,000 characters, after marking the reader", async () => {
    const { call, marks } = harness();

    const { result, isError } = await call({
      action: "read",
      reference: referenceTo(ids.waiting),
    });

    expect(isError).toBe(false);
    expect(marks()).toHaveLength(1);
    const answer = unframe(result);
    expect(answer).toMatchObject({
      status: "read",
      reference: referenceTo(ids.waiting),
      title: "Thread 4",
      state: "waiting-for-person",
      truncated: true,
    });
    const transcript = answer.transcript as ReadonlyArray<{ readonly text: string }>;
    expect(transcript.length).toBeLessThanOrEqual(MAX_THREAD_MENTION_TRANSCRIPT_ENTRIES);
    expect(transcript.reduce((total, entry) => total + entry.text.length, 0)).toBeLessThanOrEqual(
      MAX_THREAD_MENTION_TRANSCRIPT_CHARACTERS,
    );
    // The newest entries survive, the way a mention keeps them.
    expect(transcript.at(-1)?.text.startsWith("019 ")).toBe(true);

    await call({ action: "read", reference: referenceTo(ids.waiting) });
    expect(marks()).toHaveLength(2);
  });

  it("returns nothing from a read it cannot mark, and journals no observation", async () => {
    const { call, observations } = harness({ markFails: true });

    const { result, isError } = await call({ action: "read", reference: referenceTo(ids.idle) });

    expect(isError).toBe(true);
    expect(result).toMatchObject({ status: "refused", reason: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("xxx");
    expect(observations()).toEqual([]);
  });

  it("waits until the thread stops working and returns its state alone, unmarked", async () => {
    const { call, threads, marks, setOnSleep, slept } = harness();
    setOnSleep(() => {
      if (slept.length === 3) {
        threads.set(String(ids.working), snapshot(ids.working, { state: "waiting-for-person" }));
      }
    });

    const { result, isError } = await call({
      action: "wait",
      reference: referenceTo(ids.working),
      timeoutMs: 10_000,
    });

    expect(isError).toBe(false);
    expect(result).toEqual({
      status: "waited",
      reference: referenceTo(ids.working),
      state: "waiting-for-person",
    });
    expect(slept).toHaveLength(3);
    expect(marks()).toEqual([]);
  });

  it("stops waiting at the child-run bound and says the thread is still working", async () => {
    const { call, slept } = harness();

    const defaulted = await call({ action: "wait", reference: referenceTo(ids.working) });
    expect(defaulted.result).toEqual({
      status: "waited",
      reference: referenceTo(ids.working),
      state: "working",
    });
    expect(slept.reduce((total, ms) => total + ms, 0)).toBe(30_000);

    slept.length = 0;
    await call({
      action: "wait",
      reference: referenceTo(ids.working),
      timeoutMs: MAX_NATIVE_HARNESS_DELEGATE_WAIT_MS,
    });
    expect(slept.reduce((total, ms) => total + ms, 0)).toBe(MAX_NATIVE_HARNESS_DELEGATE_WAIT_MS);

    const beyond = await call({
      action: "wait",
      reference: referenceTo(ids.working),
      timeoutMs: MAX_NATIVE_HARNESS_DELEGATE_WAIT_MS + 1,
    });
    expect(beyond.result).toMatchObject({ status: "refused", reason: "policy" });
  });

  it("refuses a listed thread once it is completed, archived, deleted, or moved", async () => {
    const { call, threads, newTurn } = harness();
    const listed = unframe((await call({ action: "list" })).result);
    const reference = (listed.threads as ReadonlyArray<{ reference: string }>)[0]?.reference;
    expect(reference).toBe(referenceTo(ids.working));

    const unreachable = {
      status: "refused",
      reason: "unauthorized",
      message: SIBLING_THREAD_UNREACHABLE,
    };
    threads.set(String(ids.working), snapshot(ids.working, { closed: true }));
    expect((await call({ action: "read", reference }, undefined, newTurn())).result).toEqual(
      unreachable,
    );
    threads.set(String(ids.working), snapshot(ids.working, { projectId: projectB }));
    expect((await call({ action: "read", reference }, undefined, newTurn())).result).toEqual(
      unreachable,
    );
    threads.delete(String(ids.working));
    expect((await call({ action: "wait", reference }, undefined, newTurn())).result).toEqual(
      unreachable,
    );
  });

  it("refuses a read whose thread closes while its transcript is read, and a wait whose thread closes", async () => {
    const { call, threads, transcripts, setOnSleep, marks, newTurn } = harness();
    const reference = referenceTo(ids.idle);
    transcripts.set(String(ids.idle), transcriptOf(2, 20));
    const turn = newTurn();
    const reading = call({ action: "read", reference }, undefined, turn);
    threads.set(String(ids.idle), snapshot(ids.idle, { closed: true }));
    expect((await reading).result).toMatchObject({ reason: "unauthorized" });
    expect(marks()).toEqual([]);

    setOnSleep(() => {
      threads.set(String(ids.working), snapshot(ids.working, { closed: true }));
    });
    expect(
      (await call({ action: "wait", reference: referenceTo(ids.working) }, undefined, newTurn()))
        .result,
    ).toMatchObject({ reason: "unauthorized" });
  });

  it("journals every answered read and wait on the reader, without the text, and replays it", async () => {
    const { call, observations } = harness();

    const read = await call({ action: "read", reference: referenceTo(ids.idle) });
    await call({ action: "wait", reference: referenceTo(ids.idle) });

    const replayed = observations();
    expect(replayed.map((entry) => entry.eventName)).toEqual([
      SIBLING_THREAD_EVENT_NAMES.observed,
      SIBLING_THREAD_EVENT_NAMES.observed,
    ]);
    expect(replayed.map((entry) => entry.payload)).toEqual([
      expect.objectContaining({
        kind: "sibling-observed",
        threadId: String(ids.caller),
        targetThreadId: String(ids.idle),
        action: "read",
        returnedBytes: new TextEncoder().encode(read.result as string).length,
        occurredAt: now,
      }),
      expect.objectContaining({
        threadId: String(ids.caller),
        targetThreadId: String(ids.idle),
        action: "wait",
      }),
    ]);
    for (const entry of replayed) {
      expect(entry.payloadJson).not.toContain("xxx");
      expect(entry.payloadJson).not.toContain("Thread 3");
    }
  });

  it("takes a reader's observations with it when the reader is purged", async () => {
    const { call, observations, connection } = harness();
    await call({ action: "read", reference: referenceTo(ids.idle) });
    expect(observations(String(ids.caller))).toHaveLength(1);

    erasePurgedThread({
      connection,
      mode: "code",
      threadId: decodeThreadRetentionThreadId(String(ids.caller)),
    });

    expect(observations(String(ids.caller))).toEqual([]);
  });

  it("refuses the read and wait past the per-turn bounds, and a new turn starts fresh", async () => {
    const { call, newTurn } = harness();
    const turn = newTurn();
    const reference = referenceTo(ids.idle);

    for (let index = 0; index < MAX_SIBLING_THREAD_READS_PER_TURN; index += 1) {
      expect((await call({ action: "read", reference }, undefined, turn)).isError).toBe(false);
    }
    expect((await call({ action: "read", reference }, undefined, turn)).result).toEqual({
      status: "refused",
      reason: "rate-limited",
      message: `This turn has already read ${String(MAX_SIBLING_THREAD_READS_PER_TURN)} threads.`,
    });
    for (let index = 0; index < MAX_SIBLING_THREAD_WAITS_PER_TURN; index += 1) {
      // Probing an unreachable reference spends the bound like a real wait.
      await call({ action: "wait", reference: referenceTo(ids.completed) }, undefined, turn);
    }
    expect((await call({ action: "wait", reference }, undefined, turn)).result).toMatchObject({
      reason: "rate-limited",
    });
    for (let index = 0; index < 10; index += 1) {
      expect((await call({ action: "list" }, undefined, turn)).isError).toBe(false);
    }
    expect((await call({ action: "read", reference }, undefined, newTurn())).isError).toBe(false);
  });

  it("is offered in every posture and changes nothing outside the caller's own record", async () => {
    const { tools, call, events } = harness();
    expect(tools.definitions.map((definition) => definition.name)).toEqual([
      SIBLING_THREADS_TOOL_NAME,
    ]);

    await call({ action: "list" });
    await call({ action: "read", reference: referenceTo(ids.working) });
    await call({ action: "wait", reference: referenceTo(ids.idle) });

    const appended = events();
    expect(appended.length).toBeGreaterThan(0);
    for (const event of appended) {
      expect(String(event.aggregateId)).toBe(String(ids.caller));
      expect([THREAD_EXTERNAL_CONTENT_AGGREGATE, SIBLING_THREAD_OBSERVATION_AGGREGATE]).toContain(
        event.aggregateType,
      );
    }
  });

  it("is omitted from a profile that leaves it out, and refuses a call made anyway", async () => {
    const { tools, call } = harness({ toolConstraints: ["octant_agent_message"] });

    expect(tools.definitions).toEqual([]);
    expect((await call({ action: "list" })).result).toEqual({
      status: "refused",
      reason: "policy",
      message: `Profile "Reviewer" does not permit "${SIBLING_THREADS_TOOL_NAME}".`,
    });
  });

  it("refuses a cancelled turn and input that names a Project or path", async () => {
    const { call } = harness();
    const cancelled = new AbortController();
    cancelled.abort();

    expect((await call({ action: "list" }, cancelled.signal)).result).toMatchObject({
      reason: "policy",
      message: "The turn was cancelled.",
    });
    expect((await call({ action: "list", projectId: String(projectB) })).result).toMatchObject({
      reason: "policy",
      message: "The tool input is invalid.",
    });
    expect(
      (await call({ action: "read", reference: referenceTo(ids.idle), path: "/etc" })).result,
    ).toMatchObject({ reason: "policy" });
  });
});
