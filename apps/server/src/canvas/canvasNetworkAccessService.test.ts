import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventActor, type UtcTimestamp } from "@octant/contracts";
import { decodeCanvasId } from "@octant/contracts/canvas";
import { CANVAS_NETWORK_ACCESS_CHANGED } from "@octant/contracts/canvas-network";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  CANVAS_NETWORK_MAX_TOKENS_PER_CANVAS,
  CANVAS_NETWORK_TOKEN_TTL_MS,
  CanvasNetworkAccessService,
  registerCanvasNetworkAccessEvents,
} from "./canvasNetworkAccessService";

const directories: string[] = [];
const now = "2026-11-12T10:00:00.000Z";
const canvasId = decodeCanvasId("11111111-1111-4111-8111-111111111111");
const otherCanvasId = decodeCanvasId("22222222-2222-4222-8222-222222222222");
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "99999999-9999-4999-8999-999999999999",
});

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function connection(): SqliteConnection {
  const directory = join(tmpdir(), `octant-canvas-network-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  directories.push(directory);
  const opened = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(opened, MIGRATIONS, () => now);
  return opened;
}

function serviceOver(open: SqliteConnection, time: () => number = () => 0) {
  const journal = new Journal({
    connection: open,
    registry: registerCanvasNetworkAccessEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => now,
  });
  const service = new CanvasNetworkAccessService({
    journal,
    uuid: randomUUID,
    actor,
    clock: () => now as UtcTimestamp,
    now: time,
  });
  return { service, journal };
}

describe("Canvas network access", () => {
  it("is off for every Canvas until a person turns it on, and mints no token while off", () => {
    const open = connection();
    const { service } = serviceOver(open);
    expect(service.isAllowed(canvasId)).toBe(false);
    expect(service.issueToken(canvasId)).toBeUndefined();
    open.close();
  });

  it("journals a change with the person as its actor and finds it again after a restart", () => {
    const open = connection();
    const first = serviceOver(open);
    first.service.set(canvasId, true);
    expect(first.service.isAllowed(canvasId)).toBe(true);
    expect(first.service.isAllowed(otherCanvasId)).toBe(false);

    const events = first.journal.replayAggregate({
      aggregateType: "canvas-network-access",
      aggregateId: canvasId,
      afterVersion: 0,
      limit: 10,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventName: CANVAS_NETWORK_ACCESS_CHANGED,
      actor,
      payload: { canvasId, allowed: true },
    });

    const restarted = serviceOver(open);
    expect(restarted.service.isAllowed(canvasId)).toBe(true);
    restarted.service.set(canvasId, false);
    expect(serviceOver(open).service.isAllowed(canvasId)).toBe(false);
    open.close();
  });

  it("writes nothing when the switch already stands as asked", () => {
    const open = connection();
    const { service, journal } = serviceOver(open);
    service.set(canvasId, false);
    service.set(canvasId, true);
    service.set(canvasId, true);
    expect(
      journal.replayAggregate({
        aggregateType: "canvas-network-access",
        aggregateId: canvasId,
        afterVersion: 0,
        limit: 10,
      }),
    ).toHaveLength(1);
    open.close();
  });

  it("revokes a live token the moment the switch is turned off, and only that Canvas's", () => {
    const open = connection();
    const { service } = serviceOver(open);
    service.set(canvasId, true);
    service.set(otherCanvasId, true);
    const token = service.issueToken(canvasId);
    const otherToken = service.issueToken(otherCanvasId);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(service.canvasForToken(token ?? "")).toBe(canvasId);

    service.set(canvasId, false);
    expect(service.canvasForToken(token ?? "")).toBeUndefined();
    expect(service.canvasForToken(otherToken ?? "")).toBe(otherCanvasId);

    // Turning it on again does not bring the old token back.
    service.set(canvasId, true);
    expect(service.canvasForToken(token ?? "")).toBeUndefined();
    open.close();
  });

  it("answers nothing for a token it did not mint", () => {
    const open = connection();
    const { service } = serviceOver(open);
    service.set(canvasId, true);
    service.issueToken(canvasId);
    expect(service.canvasForToken("A".repeat(43))).toBeUndefined();
    expect(service.canvasForToken("")).toBeUndefined();
    open.close();
  });

  it("forgets a token after twelve hours and keeps at most eight for a Canvas", () => {
    const open = connection();
    let time = 0;
    const { service } = serviceOver(open, () => time);
    service.set(canvasId, true);
    const aged = service.issueToken(canvasId) ?? "";
    time = CANVAS_NETWORK_TOKEN_TTL_MS - 1;
    expect(service.canvasForToken(aged)).toBe(canvasId);
    time = CANVAS_NETWORK_TOKEN_TTL_MS;
    expect(service.canvasForToken(aged)).toBeUndefined();

    const first = service.issueToken(canvasId) ?? "";
    const rest = Array.from(
      { length: CANVAS_NETWORK_MAX_TOKENS_PER_CANVAS },
      () => service.issueToken(canvasId) ?? "",
    );
    expect(service.canvasForToken(first)).toBeUndefined();
    expect(rest.map((token) => service.canvasForToken(token))).toEqual(rest.map(() => canvasId));
    open.close();
  });
});
