import { describe, expect, it } from "vitest";
import {
  decodePurgeThreadsRequest,
  decodeRetentionScope,
  decodeRetentionWindow,
  decodeSetThreadRetentionRequest,
  decodeThreadPurgeReport,
  decodeThreadRetentionRefusal,
} from "./threadRetention";

const timestamp = "2026-08-19T12:00:00.000Z";
const threadId = "a1000000-0000-4000-8000-000000000001";
const projectId = "a2000000-0000-4000-8000-000000000002";

describe("RetentionWindow", () => {
  it("decodes forever and a bounded day count", () => {
    expect(decodeRetentionWindow({ kind: "forever" })).toEqual({ kind: "forever" });
    expect(decodeRetentionWindow({ kind: "duration-days", days: 90 })).toEqual({
      kind: "duration-days",
      days: 90,
    });
  });

  it("rejects a zero, negative, or oversized window", () => {
    expect(() => decodeRetentionWindow({ kind: "duration-days", days: 0 })).toThrow();
    expect(() => decodeRetentionWindow({ kind: "duration-days", days: -1 })).toThrow();
    expect(() => decodeRetentionWindow({ kind: "duration-days", days: 3_651 })).toThrow();
  });
});

describe("RetentionScope", () => {
  it("decodes host, project, and thread scopes", () => {
    expect(decodeRetentionScope({ kind: "host" })).toEqual({ kind: "host" });
    expect(decodeRetentionScope({ kind: "project", projectId })).toEqual({
      kind: "project",
      projectId,
    });
    expect(decodeRetentionScope({ kind: "thread", mode: "chat", threadId })).toEqual({
      kind: "thread",
      mode: "chat",
      threadId,
    });
  });

  it("rejects a thread scope without a mode", () => {
    expect(() => decodeRetentionScope({ kind: "thread", threadId })).toThrow();
  });
});

describe("SetThreadRetentionRequest", () => {
  it("decodes a host window change", () => {
    expect(
      decodeSetThreadRetentionRequest({
        scope: { kind: "host" },
        window: { kind: "duration-days", days: 30 },
      }),
    ).toMatchObject({ scope: { kind: "host" } });
  });

  it("rejects excess properties", () => {
    expect(() =>
      decodeSetThreadRetentionRequest({
        scope: { kind: "host" },
        window: { kind: "forever" },
        extra: true,
      }),
    ).toThrow();
  });
});

describe("PurgeThreadsRequest", () => {
  it("requires confirmation", () => {
    expect(
      decodePurgeThreadsRequest({
        scope: { kind: "thread", mode: "work", threadId },
        confirm: true,
      }).confirm,
    ).toBe(true);
  });

  it("rejects a purge without confirmation", () => {
    expect(() =>
      decodePurgeThreadsRequest({
        scope: { kind: "thread", mode: "work", threadId },
        confirm: false,
      }),
    ).toThrow();
  });
});

describe("ThreadPurgeReport", () => {
  it("names deleted and retained scopes without implying a broader wipe", () => {
    const report = decodeThreadPurgeReport({
      operation: "purge-threads",
      scope: { kind: "thread", mode: "chat", threadId },
      purged: [{ mode: "chat", threadId, projectId }],
      alreadyPurged: [],
      retained: [
        "host-identity",
        "store-schema",
        "other-threads",
        "projects",
        "usage-records",
        "credentials",
        "external-repositories",
        "sqlite-free-pages",
      ],
      deleted: ["thread-journal", "thread-projections", "thread-content", "thread-attachments"],
      occurredAt: timestamp,
    });
    expect(report.purged).toHaveLength(1);
    expect(report.retained).toContain("other-threads");
    expect(report.deleted).toContain("thread-journal");
  });
});

describe("ThreadRetentionRefusal", () => {
  it("decodes a typed refusal", () => {
    expect(
      decodeThreadRetentionRefusal({
        kind: "refused",
        reason: "unauthorized",
        guidance: "Thread retention can only be changed on this host.",
      }),
    ).toMatchObject({ reason: "unauthorized" });
  });
});
