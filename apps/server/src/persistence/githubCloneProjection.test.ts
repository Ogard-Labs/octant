import type { EventEnvelope, GithubCloneOperation } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import type { SqliteConnection } from "./sqlitePort";
import {
  GITHUB_CLONE_AGGREGATE_TYPE,
  GITHUB_CLONE_REQUESTED,
  GITHUB_CLONE_TRANSITIONED,
  GithubCloneProjection,
} from "./githubCloneProjection";

const connection = {} as SqliteConnection;
const requestId = "11111111-2222-4333-8444-555555555555";

function operation(overrides: Partial<GithubCloneOperation> = {}): GithubCloneOperation {
  return {
    requestId,
    state: "awaiting-confirmation",
    mode: "clone",
    repository: {
      nodeId: "R_kgDOAbc123",
      owner: "octant",
      name: "octant",
      visibility: "private",
      defaultBranch: "development",
    },
    destination: {
      inventoryPath: "/inventory",
      destinationPath: "/inventory/github.com/octant/octant",
      digest: "a".repeat(64),
    },
    version: 1,
    requestedAt: "2026-08-11T10:00:00.000Z",
    updatedAt: "2026-08-11T10:00:00.000Z",
    ...overrides,
  } as GithubCloneOperation;
}

function envelope(input: {
  readonly eventName: string;
  readonly version: number;
  readonly payload: unknown;
  readonly occurredAt?: string;
}): EventEnvelope {
  return {
    globalSequence: input.version,
    eventId: `00000000-0000-4000-8000-00000000000${input.version}`,
    aggregateType: GITHUB_CLONE_AGGREGATE_TYPE,
    aggregateId: requestId,
    aggregateVersion: input.version,
    eventName: input.eventName,
    eventVersion: 1,
    hostId: "00000000-0000-4000-8000-0000000000aa",
    correlationId: "00000000-0000-4000-8000-0000000000bb",
    actor: { kind: "local-user", actorId: "00000000-0000-4000-8000-0000000000cc" },
    occurredAt: input.occurredAt ?? "2026-08-11T10:05:00.000Z",
    payload: input.payload,
  } as unknown as EventEnvelope;
}

describe("github clone projection", () => {
  it("rebuilds an operation from requested and transitioned events", () => {
    const projection = new GithubCloneProjection();
    projection.apply(
      connection,
      envelope({
        eventName: GITHUB_CLONE_REQUESTED,
        version: 1,
        payload: { operation: operation() },
      }),
    );
    projection.apply(
      connection,
      envelope({
        eventName: GITHUB_CLONE_TRANSITIONED,
        version: 2,
        payload: {
          requestId,
          fromState: "awaiting-confirmation",
          toState: "reserved",
          version: 2,
        },
        occurredAt: "2026-08-11T10:06:00.000Z",
      }),
    );
    const current = projection.getByRequestId(requestId);
    expect(current?.state).toBe("reserved");
    expect(current?.version).toBe(2);
    expect(current?.updatedAt).toBe("2026-08-11T10:06:00.000Z");
    expect(current?.requestedAt).toBe("2026-08-11T10:00:00.000Z");
  });

  it("is idempotent for duplicate and out-of-order older events", () => {
    const projection = new GithubCloneProjection();
    projection.applyRequested(operation());
    projection.applyTransitioned(
      { requestId, fromState: "awaiting-confirmation", toState: "reserved", version: 2 },
      "2026-08-11T10:06:00.000Z",
    );
    projection.applyTransitioned(
      { requestId, fromState: "reserved", toState: "cloning", version: 3 },
      "2026-08-11T10:07:00.000Z",
    );
    // Duplicate and older events never roll state back.
    projection.applyTransitioned(
      { requestId, fromState: "awaiting-confirmation", toState: "reserved", version: 2 },
      "2026-08-11T10:06:00.000Z",
    );
    projection.applyRequested(operation());
    const current = projection.getByRequestId(requestId);
    expect(current?.state).toBe("cloning");
    expect(current?.version).toBe(3);
  });

  it("records terminal failure, updated facts, and binding issuance", () => {
    const projection = new GithubCloneProjection();
    projection.applyRequested(operation());
    projection.applyTransitioned(
      {
        requestId,
        fromState: "awaiting-confirmation",
        toState: "failed",
        version: 2,
        failure: { code: "destination-collision" },
      },
      "2026-08-11T10:06:00.000Z",
    );
    expect(projection.getByRequestId(requestId)?.failure).toEqual({
      code: "destination-collision",
    });

    const second = "99999999-8888-4777-8666-555555555555";
    projection.applyRequested(operation({ requestId: second } as never));
    projection.applyTransitioned(
      {
        requestId: second,
        fromState: "awaiting-confirmation",
        toState: "verifying",
        version: 2,
        repository: {
          nodeId: "R_kgDOAbc123",
          owner: "octant",
          name: "octant",
          visibility: "private",
          defaultBranch: "main",
          empty: false,
        },
      } as never,
      "2026-08-11T10:07:00.000Z",
    );
    projection.applyTransitioned(
      {
        requestId: second,
        fromState: "verifying",
        toState: "completed",
        version: 3,
        bindingIssued: true,
      } as never,
      "2026-08-11T10:08:00.000Z",
    );
    const current = projection.getByRequestId(second);
    expect(current?.repository.defaultBranch).toBe("main");
    expect(current?.bindingIssued).toBe(true);
  });

  it("ignores transitions for unknown operations and rejects malformed payloads", () => {
    const projection = new GithubCloneProjection();
    projection.applyTransitioned(
      { requestId, fromState: "reserved", toState: "cloning", version: 2 },
      "2026-08-11T10:06:00.000Z",
    );
    expect(projection.getByRequestId(requestId)).toBeUndefined();
    expect(() =>
      projection.apply(
        connection,
        envelope({
          eventName: GITHUB_CLONE_REQUESTED,
          version: 1,
          payload: { operation: { hostile: true } },
        }),
      ),
    ).toThrow();
  });

  it("finds active conflicts by node identity and destination digest", () => {
    const projection = new GithubCloneProjection();
    projection.applyRequested(operation());
    expect(
      projection.findActiveConflict({ nodeId: "R_kgDOAbc123", digest: "f".repeat(64) })?.requestId,
    ).toBe(requestId);
    expect(
      projection.findActiveConflict({ nodeId: "R_other", digest: "a".repeat(64) })?.requestId,
    ).toBe(requestId);
    expect(
      projection.findActiveConflict({ nodeId: "R_other", digest: "f".repeat(64) }),
    ).toBeUndefined();
    projection.applyTransitioned(
      {
        requestId,
        fromState: "awaiting-confirmation",
        toState: "cancelled",
        version: 2,
      },
      "2026-08-11T10:06:00.000Z",
    );
    expect(
      projection.findActiveConflict({ nodeId: "R_kgDOAbc123", digest: "a".repeat(64) }),
    ).toBeUndefined();
  });

  it("lists newest operations first and resets cleanly", () => {
    const projection = new GithubCloneProjection();
    const older = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    projection.applyRequested(
      operation({ requestId: older, requestedAt: "2026-08-11T09:00:00.000Z" } as never),
    );
    projection.applyRequested(operation());
    expect(projection.list().map((entry) => entry.requestId)).toEqual([requestId, older]);
    projection.reset(connection);
    expect(projection.list()).toEqual([]);
  });
});
