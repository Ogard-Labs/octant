import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeCodeCheckoutId, decodeCodeFileId, decodeCodeRuntimeWorkId } from "@octant/contracts";
import { Effect, Either } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { readCodeCheckout, readCodeFileReference, readCodeRuntimeWork } from "./codeProjection";
import { Journal } from "./journal";
import { applyMigrations, MIGRATIONS } from "./migrations";
import { Persistence, makePersistenceLive } from "./persistenceService";
import { rebuildProjection } from "./projection";
import { createPhase1RuntimeRegistries } from "./runtimeRegistry";
import { openSqlite } from "./sqlitePort";

const directories: Array<string> = [];
const now = "2026-07-20T22:30:00.000Z";
const restartedAt = "2026-07-20T22:31:00.000Z";
const ids = {
  actor: "84000000-0000-4000-8000-000000000001",
  correlation: "84000000-0000-4000-8000-000000000002",
  thread: "84000000-0000-4000-8000-000000000003",
  checkout: "84000000-0000-4000-8000-000000000004",
  managedCheckout: "84000000-0000-4000-8000-000000000008",
  receipt: "84000000-0000-4000-8000-000000000009",
  file: "84000000-0000-4000-8000-000000000005",
  running: "84000000-0000-4000-8000-000000000006",
  ambiguous: "84000000-0000-4000-8000-000000000007",
  runningTerminal: "84000000-0000-4000-8000-00000000000a",
} as const;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Code persistence restart", () => {
  it("fails stale checkout identity closed and reconciles running work without inventing completion or reordering turns", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "octant.sqlite3");
    const first = openSqlite(path);
    applyMigrations(first, MIGRATIONS, () => now);
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection: first,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    appendRuntime(journal, ids.running, "running", 101);
    appendRuntime(journal, ids.ambiguous, "ambiguous", 102);
    appendRuntime(journal, ids.runningTerminal, "running", 107, "terminal");
    appendCheckout(journal, {
      id: ids.checkout,
      kind: "existing-worktree",
      eventId: "84000000-0000-4000-8000-000000000105",
    });
    appendCheckout(journal, {
      id: ids.managedCheckout,
      kind: "managed-worktree",
      eventId: "84000000-0000-4000-8000-000000000106",
    });
    journal.append({
      aggregate: { aggregateType: "code-file", aggregateId: ids.file },
      expectedVersion: 0,
      events: [
        {
          eventId: "84000000-0000-4000-8000-000000000103",
          eventName: "code.file-reference-updated@1",
          eventVersion: 1,
          correlationId: ids.correlation,
          actor: { kind: "system", actorId: ids.actor },
          occurredAt: now,
          payload: {
            kind: "file-reference-updated",
            file: {
              id: ids.file,
              threadId: ids.thread,
              checkoutId: ids.checkout,
              digest: "c".repeat(64),
              byteLength: 12,
              state: "saving",
              version: 1,
              updatedAt: now,
            },
          },
        },
      ],
    });
    first.close();

    const states = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const persistence = yield* Persistence;
          return {
            running: persistence.readCodeRuntimeWork(decodeCodeRuntimeWorkId(ids.running)),
            ambiguous: persistence.readCodeRuntimeWork(decodeCodeRuntimeWorkId(ids.ambiguous)),
            runningTerminal: persistence.readCodeRuntimeWork(
              decodeCodeRuntimeWorkId(ids.runningTerminal),
            ),
            file: persistence.readCodeFileReference(decodeCodeFileId(ids.file)),
            existingCheckout: persistence.readCodeCheckout(decodeCodeCheckoutId(ids.checkout)),
            managedCheckout: persistence.readCodeCheckout(
              decodeCodeCheckoutId(ids.managedCheckout),
            ),
          };
        }).pipe(
          Effect.provide(
            makePersistenceLive({ dataDirectory: directory, clock: () => restartedAt }),
          ),
        ),
      ),
    );

    // A provider turn may still be owed a resume or an approval, so it waits.
    // Its `updatedAt` keeps the moment the work last actually moved: stamping
    // the restart would make a frozen turn look newer than one that finished
    // after it, and the board reads the latest turn to decide what is owed.
    expect(states.running).toMatchObject({ state: "waiting", updatedAt: now });
    // An outcome that could not be established stays unresolved rather than
    // being rewritten into a conclusion nobody observed.
    expect(states.ambiguous).toMatchObject({ state: "ambiguous", updatedAt: now });
    // A terminal's OS process did not survive the restart; it is interrupted,
    // not waiting, so it can never hold its thread in Waiting forever.
    expect(states.runningTerminal).toMatchObject({
      state: "interrupted",
      updatedAt: now,
    });
    expect(states.file).toMatchObject({
      state: "interrupted",
      version: 2,
      updatedAt: restartedAt,
    });
    expect(states.existingCheckout).toMatchObject({
      kind: "existing-worktree",
      availability: "waiting",
      observedAt: restartedAt,
    });
    expect(states.managedCheckout).toMatchObject({
      kind: "managed-worktree",
      availability: "waiting",
      observedAt: restartedAt,
    });
    expect(JSON.stringify(states)).not.toContain("completed");

    const rebuilt = openSqlite(path);
    const rebuiltRuntime = createPhase1RuntimeRegistries();
    const codeProjection = rebuiltRuntime.projections.get("code");
    if (codeProjection === undefined) throw new Error("Code projection must be registered");
    const rebuiltJournal = new Journal({
      connection: rebuilt,
      registry: rebuiltRuntime.events,
      projections: rebuiltRuntime.projections,
      clock: () => restartedAt,
    });
    const checkoutEvents = rebuilt
      .prepare(`
        SELECT aggregate_id, aggregate_version, payload_json
        FROM event_journal
        WHERE event_name = 'code.checkout-observed@1'
        ORDER BY global_sequence
      `)
      .all() as ReadonlyArray<{
      readonly aggregate_id: string;
      readonly aggregate_version: number;
      readonly payload_json: string;
    }>;
    expect(checkoutEvents).toHaveLength(4);
    expect(checkoutEvents.filter(({ aggregate_version }) => aggregate_version === 2)).toHaveLength(
      2,
    );
    expect(
      checkoutEvents
        .slice(-2)
        .every(({ payload_json }) => payload_json.includes('"availability":"waiting"')),
    ).toBe(true);
    expect(JSON.stringify(checkoutEvents)).not.toContain("canonicalPath");
    rebuildProjection({
      connection: rebuilt,
      journal: rebuiltJournal,
      projection: codeProjection,
      clock: () => restartedAt,
    });
    expect(readCodeRuntimeWork(rebuilt, decodeCodeRuntimeWorkId(ids.running))).toMatchObject({
      state: "waiting",
    });
    expect(readCodeRuntimeWork(rebuilt, decodeCodeRuntimeWorkId(ids.ambiguous))).toMatchObject({
      state: "ambiguous",
    });
    expect(
      readCodeRuntimeWork(rebuilt, decodeCodeRuntimeWorkId(ids.runningTerminal)),
    ).toMatchObject({ state: "interrupted" });
    expect(readCodeFileReference(rebuilt, decodeCodeFileId(ids.file))).toMatchObject({
      state: "interrupted",
      version: 2,
    });
    expect(readCodeCheckout(rebuilt, decodeCodeCheckoutId(ids.checkout))).toMatchObject({
      availability: "waiting",
    });
    expect(readCodeCheckout(rebuilt, decodeCodeCheckoutId(ids.managedCheckout))).toMatchObject({
      availability: "waiting",
    });
    rebuilt.close();
  });

  it("quarantines a future Code event version across the global journal projections", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "octant.sqlite3");
    const seeded = openSqlite(path);
    applyMigrations(seeded, MIGRATIONS, () => now);
    seeded
      .prepare(`
        INSERT INTO event_journal (
          event_id, aggregate_type, aggregate_id, aggregate_version, event_name,
          event_version, correlation_id, causation_id, actor_kind, actor_id,
          occurred_at, payload_json
        ) VALUES (?, 'code-runtime', ?, 1, 'code.runtime-work-updated@1', 2, ?, NULL, 'system', ?, ?, ?)
      `)
      .run(
        "84000000-0000-4000-8000-000000000104",
        ids.running,
        ids.correlation,
        ids.actor,
        now,
        JSON.stringify({ private: "future-code-payload" }),
      );
    seeded.close();

    const result = await Effect.runPromise(
      Effect.either(
        Effect.scoped(
          Effect.provide(
            Persistence,
            makePersistenceLive({ dataDirectory: directory, clock: () => restartedAt }),
          ),
        ),
      ),
    );
    expect(Either.isLeft(result)).toBe(true);

    const inspected = openSqlite(path);
    expect(
      inspected
        .prepare("SELECT projection_name, reason FROM event_quarantine ORDER BY projection_name")
        .all(),
    ).toEqual([
      { projection_name: "agent-profiles", reason: "unsupported-event-version" },
      { projection_name: "agent-runs", reason: "unsupported-event-version" },
      { projection_name: "aggregate-heads", reason: "unsupported-event-version" },
      { projection_name: "automations", reason: "unsupported-event-version" },
      { projection_name: "canvas", reason: "unsupported-event-version" },
      { projection_name: "chat", reason: "unsupported-event-version" },
      { projection_name: "code", reason: "unsupported-event-version" },
      { projection_name: "contexts", reason: "unsupported-event-version" },
      { projection_name: "diagnostics-exports", reason: "unsupported-event-version" },
      { projection_name: "extensions", reason: "unsupported-event-version" },
      { projection_name: "github-clones", reason: "unsupported-event-version" },
      { projection_name: "product-feedback", reason: "unsupported-event-version" },
      { projection_name: "projects", reason: "unsupported-event-version" },
      { projection_name: "providers", reason: "unsupported-event-version" },
      { projection_name: "remote-access", reason: "unsupported-event-version" },
      { projection_name: "shell", reason: "unsupported-event-version" },
      { projection_name: "theme", reason: "unsupported-event-version" },
      { projection_name: "thread-checkpoint", reason: "unsupported-event-version" },
      { projection_name: "thread-external-content-taint", reason: "unsupported-event-version" },
      { projection_name: "thread-retention", reason: "unsupported-event-version" },
      { projection_name: "usage", reason: "unsupported-event-version" },
      { projection_name: "validation-evidence", reason: "unsupported-event-version" },
      { projection_name: "zen", reason: "unsupported-event-version" },
    ]);
    inspected.close();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-code-restart-"));
  directories.push(directory);
  return directory;
}

function appendCheckout(
  journal: Journal,
  input:
    | { readonly id: string; readonly kind: "existing-worktree"; readonly eventId: string }
    | { readonly id: string; readonly kind: "managed-worktree"; readonly eventId: string },
): void {
  journal.append({
    aggregate: { aggregateType: "code-checkout", aggregateId: input.id },
    expectedVersion: 0,
    events: [
      {
        eventId: input.eventId,
        eventName: "code.checkout-observed@1",
        eventVersion: 1,
        correlationId: ids.correlation,
        actor: { kind: "system", actorId: ids.actor },
        occurredAt: now,
        payload: {
          kind: "checkout-observed",
          checkout: {
            id: input.id,
            repositoryId: `repo_${"a".repeat(64)}`,
            kind: input.kind,
            availability: "available",
            head: { kind: "branch", name: "feature/phase-7", oid: "b".repeat(40) },
            ...(input.kind === "managed-worktree" ? { ownershipReceiptId: ids.receipt } : {}),
            observedAt: now,
          },
        },
      },
    ],
  });
}

function appendRuntime(
  journal: Journal,
  runtimeWorkId: string,
  state: "running" | "ambiguous",
  eventSuffix: number,
  kind: "provider-turn" | "terminal" = "provider-turn",
): void {
  journal.append({
    aggregate: { aggregateType: "code-runtime", aggregateId: runtimeWorkId },
    expectedVersion: 0,
    events: [
      {
        eventId: `84000000-0000-4000-8000-000000000${eventSuffix}`,
        eventName: "code.runtime-work-updated@1",
        eventVersion: 1,
        correlationId: ids.correlation,
        actor: { kind: "system", actorId: ids.actor },
        occurredAt: now,
        payload: {
          kind: "runtime-work-updated",
          work: {
            id: runtimeWorkId,
            threadId: ids.thread,
            kind,
            state,
            updatedAt: now,
          },
        },
      },
    ],
  });
}
