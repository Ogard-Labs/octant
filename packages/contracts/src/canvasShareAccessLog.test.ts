import { describe, expect, it } from "vitest";
import {
  decodeCanvasShareAccessLogEvent,
  decodeCanvasShareAccessResult,
  decodeCanvasShareOverview,
} from "./canvasShareAccessLog";

const event = {
  schemaVersion: 1,
  kind: "canvas-share-access-log",
  eventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  snapshotId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  canvasId: "11111111-1111-4111-8111-111111111111",
  hostId: "local",
  projectId: "33333333-3333-4333-8333-333333333333",
  occurredAt: "2026-08-04T14:00:00.000Z",
  outcome: "allowed",
  browserFamily: "safari",
  audienceLabel: "Reviewer device",
} as const;

describe("Canvas share access log contracts", () => {
  it("round-trips a privacy-preserving access event", () => {
    expect(decodeCanvasShareAccessLogEvent(event)).toEqual(event);
  });

  it("rejects credential-bearing or raw user-agent fields", () => {
    expect(() =>
      decodeCanvasShareAccessLogEvent({
        ...event,
        userAgent: "Mozilla/5.0",
        authorization: "Bearer secret",
      }),
    ).toThrow();
  });

  it("rejects secret-bearing audience labels at decode time", () => {
    expect(() =>
      decodeCanvasShareAccessLogEvent({
        schemaVersion: 1,
        kind: "canvas-share-access-log",
        eventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        snapshotId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        canvasId: "11111111-1111-4111-8111-111111111111",
        hostId: "local",
        projectId: "33333333-3333-4333-8333-333333333333",
        occurredAt: "2026-08-04T12:05:01.000Z",
        outcome: "allowed",
        browserFamily: "chrome",
        audienceLabel: "Bearer abcdefghijklmnop",
      }),
    ).toThrow();
  });
  it("publishes an owner-visible overview and refuses an unaudited access result", () => {
    const overview = {
      schemaVersion: 1,
      kind: "canvas-share-overview",
      canvasId: event.canvasId,
      hostId: "local",
      projectId: event.projectId,
      sharingEnabled: true,
      owner: { kind: "local-user", actorId: "44444444-4444-4444-8444-444444444444" },
      snapshots: [],
      accessLog: [event],
    } as const;
    expect(decodeCanvasShareOverview(overview)).toEqual(overview);

    // Every evaluated read reports the outcome the owner will audit, so a
    // denial without its journaled event cannot cross the wire.
    expect(
      decodeCanvasShareAccessResult({ kind: "denied", outcome: "denied-revoked", event }).kind,
    ).toBe("denied");
    expect(() =>
      decodeCanvasShareAccessResult({ kind: "denied", outcome: "denied-revoked" }),
    ).toThrow();
  });
});
