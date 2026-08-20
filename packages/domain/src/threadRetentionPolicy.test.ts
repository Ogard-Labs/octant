import { describe, expect, it } from "vitest";
import type { RetentionScope, ThreadRetentionThreadId } from "@octant/contracts";
import {
  authorizeThreadRetentionAction,
  decidePurgeThreads,
  decideSetRetentionWindow,
  isThreadPastRetention,
  resolveEffectiveRetentionWindow,
  selectThreadsForPurge,
  THREAD_PURGE_DELETED_SCOPES,
  THREAD_PURGE_RETAINED_SCOPES,
} from "./threadRetentionPolicy";

const threadId = "b1000000-0000-4000-8000-000000000001" as ThreadRetentionThreadId;
const otherThreadId = "b1000000-0000-4000-8000-000000000002" as ThreadRetentionThreadId;
const projectId = "b2000000-0000-4000-8000-000000000001" as never;
const otherProjectId = "b2000000-0000-4000-8000-000000000002" as never;
const now = "2026-08-19T12:00:00.000Z";
const thirtyOneDaysAgo = "2026-07-19T12:00:00.000Z";
const yesterday = "2026-08-18T12:00:00.000Z";

const subject = {
  mode: "chat" as const,
  threadId,
  projectId,
  updatedAt: thirtyOneDaysAgo,
};

describe("authorizeThreadRetentionAction", () => {
  it.each(["read", "set", "purge"] as const)(
    "allows a local window and denies a remote device for %s",
    (operation) => {
      expect(authorizeThreadRetentionAction({ principalKind: "local-window", operation })).toEqual({
        kind: "allow",
      });
      expect(authorizeThreadRetentionAction({ principalKind: "remote-device", operation })).toEqual(
        { kind: "deny", reason: "local-host-required" },
      );
    },
  );
});

describe("resolveEffectiveRetentionWindow", () => {
  it("uses forever when no window is set", () => {
    expect(resolveEffectiveRetentionWindow({ subject, windows: [] })).toEqual({
      kind: "forever",
    });
  });

  it("lets a thread window beat the Project and host windows", () => {
    expect(
      resolveEffectiveRetentionWindow({
        subject,
        windows: [
          { scope: { kind: "host" }, window: { kind: "duration-days", days: 7 } },
          { scope: { kind: "project", projectId }, window: { kind: "duration-days", days: 30 } },
          {
            scope: { kind: "thread", mode: "chat", threadId },
            window: { kind: "forever" },
          },
        ],
      }),
    ).toEqual({ kind: "forever" });
  });

  it("lets a Project window beat the host window", () => {
    expect(
      resolveEffectiveRetentionWindow({
        subject,
        windows: [
          { scope: { kind: "host" }, window: { kind: "duration-days", days: 7 } },
          { scope: { kind: "project", projectId }, window: { kind: "duration-days", days: 90 } },
        ],
      }),
    ).toEqual({ kind: "duration-days", days: 90 });
  });

  it("does not apply another Project's window", () => {
    expect(
      resolveEffectiveRetentionWindow({
        subject,
        windows: [
          { scope: { kind: "host" }, window: { kind: "duration-days", days: 7 } },
          {
            scope: { kind: "project", projectId: otherProjectId },
            window: { kind: "duration-days", days: 90 },
          },
        ],
      }),
    ).toEqual({ kind: "duration-days", days: 7 });
  });
});

describe("isThreadPastRetention", () => {
  it("never expires a forever window", () => {
    expect(
      isThreadPastRetention({
        subject,
        window: { kind: "forever" },
        now,
      }),
    ).toBe(false);
  });

  it("expires a thread older than its day count and keeps a younger one", () => {
    expect(
      isThreadPastRetention({
        subject,
        window: { kind: "duration-days", days: 30 },
        now,
      }),
    ).toBe(true);
    expect(
      isThreadPastRetention({
        subject: { ...subject, updatedAt: yesterday },
        window: { kind: "duration-days", days: 30 },
        now,
      }),
    ).toBe(false);
  });
});

describe("decideSetRetentionWindow", () => {
  it("refuses a remote principal", () => {
    expect(
      decideSetRetentionWindow({
        principalKind: "remote-device",
        scope: { kind: "host" },
      }),
    ).toMatchObject({ kind: "refused", reason: "unauthorized" });
  });

  it("refuses a window for a thread that is not on this host", () => {
    expect(
      decideSetRetentionWindow({
        principalKind: "local-window",
        scope: { kind: "thread", mode: "chat", threadId },
        threadExists: false,
      }),
    ).toMatchObject({ kind: "refused", reason: "unknown-thread" });
  });

  it("allows a local principal to set the host window", () => {
    expect(
      decideSetRetentionWindow({
        principalKind: "local-window",
        scope: { kind: "host" },
      }),
    ).toEqual({ kind: "allow" });
  });
});

describe("decidePurgeThreads", () => {
  const threadScope: RetentionScope = { kind: "thread", mode: "chat", threadId };

  it("refuses a remote principal even when confirmation is present", () => {
    expect(
      decidePurgeThreads({
        principalKind: "remote-device",
        confirm: true,
        scope: threadScope,
        threadExists: true,
      }),
    ).toMatchObject({ kind: "refused", reason: "unauthorized" });
  });

  it("requires confirmation", () => {
    expect(
      decidePurgeThreads({
        principalKind: "local-window",
        confirm: false,
        scope: threadScope,
        threadExists: true,
      }),
    ).toMatchObject({ kind: "refused", reason: "confirmation-required" });
  });

  it("refuses an unknown thread and treats an already-purged thread as a completed no-op", () => {
    expect(
      decidePurgeThreads({
        principalKind: "local-window",
        confirm: true,
        scope: threadScope,
        threadExists: false,
      }),
    ).toMatchObject({ kind: "refused", reason: "unknown-thread" });
    expect(
      decidePurgeThreads({
        principalKind: "local-window",
        confirm: true,
        scope: threadScope,
        threadAlreadyPurged: true,
      }),
    ).toEqual({ kind: "allow" });
  });

  it("allows a confirmed local purge of a known thread", () => {
    expect(
      decidePurgeThreads({
        principalKind: "local-window",
        confirm: true,
        scope: threadScope,
        threadExists: true,
      }),
    ).toEqual({ kind: "allow" });
  });
});

describe("selectThreadsForPurge", () => {
  const younger = { ...subject, threadId: otherThreadId, updatedAt: yesterday };
  const windows = [
    { scope: { kind: "host" } as const, window: { kind: "duration-days" as const, days: 30 } },
  ];

  it("selects the named thread even when it is still inside the window", () => {
    expect(
      selectThreadsForPurge({
        scope: { kind: "thread", mode: "chat", threadId: younger.threadId },
        subjects: [subject, younger],
        windows,
        now,
      }),
    ).toEqual([younger]);
  });

  it("selects only expired threads for a Project or host scope", () => {
    expect(
      selectThreadsForPurge({
        scope: { kind: "project", projectId },
        subjects: [subject, younger],
        windows,
        now,
      }),
    ).toEqual([subject]);
    expect(
      selectThreadsForPurge({
        scope: { kind: "host" },
        subjects: [subject, younger],
        windows,
        now,
      }),
    ).toEqual([subject]);
  });

  it("does not select a thread from another Project", () => {
    expect(
      selectThreadsForPurge({
        scope: { kind: "project", projectId: otherProjectId },
        subjects: [subject],
        windows,
        now,
      }),
    ).toEqual([]);
  });
});

describe("purge scope report", () => {
  it("names thread-owned deletions and keeps host, other threads, and free pages retained", () => {
    expect(THREAD_PURGE_DELETED_SCOPES).toEqual([
      "thread-journal",
      "thread-projections",
      "thread-content",
      "thread-attachments",
    ]);
    expect(THREAD_PURGE_RETAINED_SCOPES).toContain("other-threads");
    expect(THREAD_PURGE_RETAINED_SCOPES).toContain("sqlite-free-pages");
    expect(THREAD_PURGE_RETAINED_SCOPES).not.toContain("thread-journal");
  });
});
