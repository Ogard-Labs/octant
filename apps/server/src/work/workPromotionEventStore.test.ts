import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { WorkPromotionEventStore } from "./workPromotionEventStore";
import {
  decodeWorkPromotionFrame,
  decodeWorkPromotionProposalId,
  type WorkPromotionFrame,
  type WorkPromotionProposalId,
} from "@octant/contracts";
import { EventActor } from "@octant/contracts/events";

const directories: Array<string> = [];
const now = "2026-07-22T08:00:00.000Z";

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-work-promotion-store-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const ids = {
  proposal: decodeWorkPromotionProposalId("11111111-1111-4111-8111-111111111111"),
  otherProposal: decodeWorkPromotionProposalId("99999999-9999-4999-8999-999999999999"),
  origin: "22222222-2222-4222-8222-222222222222",
  target: "33333333-3333-4333-8333-333333333333",
  codeThread: "44444444-4444-4444-8444-444444444444",
  actor: "55555555-5555-4555-8555-555555555555",
} as const;

const actor = Schema.decodeUnknownSync(EventActor)({ kind: "local-user", actorId: ids.actor });
const proposedAt = "2026-07-22T08:00:00.000Z";
const decidedAt = "2026-07-22T08:05:00.000Z";

const selectedContext = {
  summary: "Refactor the report generator into a small CLI",
  artifactRefs: ["opaque-artifact-token-1"],
} as const;

function proposedFrame(
  version = 1,
  proposalId: WorkPromotionProposalId = ids.proposal,
): WorkPromotionFrame {
  return decodeWorkPromotionFrame({
    kind: "proposed",
    proposal: {
      proposalId,
      originProjectId: ids.origin,
      targetCodeProjectId: ids.target,
      selectedContext,
      status: "proposed",
      proposedCodeExecutionPolicy: "approval-gated",
      proposedCodePermissionPersistence: "current-session",
      proposedBy: { kind: "local-user", actorId: ids.actor },
      proposedAt,
      version,
    },
  });
}

function approvedFrame(version = 2): WorkPromotionFrame {
  return decodeWorkPromotionFrame({
    kind: "approved",
    proposal: {
      proposalId: ids.proposal,
      originProjectId: ids.origin,
      targetCodeProjectId: ids.target,
      selectedContext,
      status: "approved",
      proposedCodeExecutionPolicy: "approval-gated",
      proposedCodePermissionPersistence: "current-session",
      proposedBy: { kind: "local-user", actorId: ids.actor },
      proposedAt,
      decidedAt,
      linkedCodeThreadId: ids.codeThread,
      version,
    },
    linkedCodeThreadId: ids.codeThread,
  });
}

function createStore(connection: SqliteConnection = openConnection()): WorkPromotionEventStore {
  const registry = new EventRegistry().register("work.promotion-recorded@1", 1, Schema.Unknown);
  const projections = new ProjectionRegistry().register(new AggregateHeadsProjection());
  const journal = new Journal({
    connection,
    registry,
    projections,
    clock: () => now,
  });
  let counter = 0;
  const uuid = () => {
    counter += 1;
    const suffix = counter.toString(16).padStart(12, "0");
    return `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`;
  };
  return new WorkPromotionEventStore({ journal, uuid, actor });
}

describe("WorkPromotionEventStore", () => {
  it("appends a proposed frame and returns the committed frame", () => {
    const store = createStore();
    const frame = store.append({
      proposalId: ids.proposal,
      expectedVersion: 0,
      frame: proposedFrame(1),
    });
    expect(frame.kind).toBe("proposed");
    expect(frame.proposal.version).toBe(1);
  });

  it("rejects an append whose expected version does not match the current head (optimistic concurrency)", () => {
    const store = createStore();
    store.append({ proposalId: ids.proposal, expectedVersion: 0, frame: proposedFrame(1) });
    expect(() =>
      store.append({ proposalId: ids.proposal, expectedVersion: 0, frame: approvedFrame(2) }),
    ).toThrow();
  });

  it("appends an approved frame when the expected version matches the current head", () => {
    const store = createStore();
    store.append({ proposalId: ids.proposal, expectedVersion: 0, frame: proposedFrame(1) });
    const frame = store.append({
      proposalId: ids.proposal,
      expectedVersion: 1,
      frame: approvedFrame(2),
    });
    expect(frame.kind).toBe("approved");
    if (frame.kind !== "approved") return;
    expect(frame.linkedCodeThreadId).toBe(ids.codeThread);
  });

  it("rejects an append whose frame version is not one greater than the expected head", () => {
    const store = createStore();
    expect(() =>
      store.append({ proposalId: ids.proposal, expectedVersion: 0, frame: proposedFrame(2) }),
    ).toThrow();
  });

  it("rejects an append whose frame proposal id does not match the request", () => {
    const store = createStore();
    const mismatchedFrame = decodeWorkPromotionFrame({
      kind: "proposed",
      proposal: {
        proposalId: ids.otherProposal,
        originProjectId: ids.origin,
        targetCodeProjectId: ids.target,
        selectedContext,
        status: "proposed",
        proposedCodeExecutionPolicy: "approval-gated",
        proposedCodePermissionPersistence: "current-session",
        proposedBy: { kind: "local-user", actorId: ids.actor },
        proposedAt,
        version: 1,
      },
    });
    expect(() =>
      store.append({
        proposalId: ids.proposal,
        expectedVersion: 0,
        frame: mismatchedFrame,
      }),
    ).toThrow();
  });

  it("replays frames for a proposal in version order", () => {
    const store = createStore();
    store.append({ proposalId: ids.proposal, expectedVersion: 0, frame: proposedFrame(1) });
    store.append({ proposalId: ids.proposal, expectedVersion: 1, frame: approvedFrame(2) });
    const replay = store.replay({ proposalId: ids.proposal, afterVersion: 0, limit: 10 });
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") return;
    expect(replay.frames).toHaveLength(2);
    expect(replay.frames[0]?.kind).toBe("proposed");
    expect(replay.frames[1]?.kind).toBe("approved");
    expect(replay.nextCursor).toBe(2);
  });

  it("replays no frames for an unknown proposal", () => {
    const store = createStore();
    const replay = store.replay({ proposalId: ids.proposal, afterVersion: 0, limit: 10 });
    expect(replay.status).toBe("ok");
    if (replay.status !== "ok") return;
    expect(replay.frames).toHaveLength(0);
    expect(replay.nextCursor).toBe(0);
  });

  it("rejects an invalid replay limit", () => {
    const store = createStore();
    expect(() => store.replay({ proposalId: ids.proposal, afterVersion: 0, limit: 0 })).toThrow();
  });

  it("replays all promotion frames across proposals in version order", () => {
    const store = createStore();
    store.append({ proposalId: ids.proposal, expectedVersion: 0, frame: proposedFrame(1) });
    store.append({
      proposalId: ids.otherProposal,
      expectedVersion: 0,
      frame: proposedFrame(1, ids.otherProposal),
    });
    store.append({ proposalId: ids.proposal, expectedVersion: 1, frame: approvedFrame(2) });
    const result = store.replayAll();
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.frames).toHaveLength(3);
    // Frames for the same proposal are in version order.
    const proposalFrames = result.frames.filter((f) => f.proposal.proposalId === ids.proposal);
    expect(proposalFrames).toHaveLength(2);
    expect(proposalFrames[0]?.proposal.version).toBe(1);
    expect(proposalFrames[1]?.proposal.version).toBe(2);
  });

  it("replays no frames from an empty journal", () => {
    const store = createStore();
    const result = store.replayAll();
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.frames).toHaveLength(0);
  });

  it("rebuilds every proposal when other aggregate types hold more rows than the scan cap", () => {
    const connection = openConnection();
    const store = createStore(connection);
    store.append({ proposalId: ids.proposal, expectedVersion: 0, frame: proposedFrame(1) });
    // A Code turn journals a row per streamed delta, so other types outgrow
    // promotions by orders of magnitude. The rows carry an event name nothing
    // registers: reading even one of them would fail the replay.
    connection
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100001)
         INSERT INTO event_journal (
           event_id, aggregate_type, aggregate_id, aggregate_version, event_name,
           event_version, correlation_id, actor_kind, actor_id, occurred_at, payload_json
         )
         SELECT printf('other-%d', i), 'code-operation', printf('operation-%d', i), 1,
           'unregistered.frame@1', 1, 'correlation', 'local-user', 'actor', ?, '{}'
         FROM n`,
      )
      .run(now);
    store.append({ proposalId: ids.proposal, expectedVersion: 1, frame: approvedFrame(2) });

    const result = store.replayAll();

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.frames.map((frame) => frame.kind)).toEqual(["proposed", "approved"]);
  });

  it("refuses a rebuild once the promotion history itself passes the scan cap", () => {
    const frame = proposedFrame(1);
    const journal = {
      append: () => {
        throw new Error("not used");
      },
      replay: () => [],
      replayAggregateType: (cursor: { readonly afterSequence: number; readonly limit: number }) =>
        Array.from({ length: cursor.limit }, (_, index) => ({
          globalSequence: cursor.afterSequence + index + 1,
          aggregateType: "work-promotion",
          aggregateId: ids.proposal,
          aggregateVersion: 1,
          eventName: "work.promotion-recorded@1",
          eventVersion: 1,
          payload: frame,
        })),
    };
    const store = new WorkPromotionEventStore({
      journal: journal as never,
      uuid: () => "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
      actor,
    });

    expect(store.replayAll()).toEqual({ status: "snapshot-required", reason: "scan-limit" });
  });
});
