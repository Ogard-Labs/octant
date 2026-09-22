import type { CodeThread } from "@octant/contracts/code";
import { decodeCodeThread } from "@octant/contracts/code";
import { decodeUtcTimestamp } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  archiveCodeThread,
  completeCodeThread,
  findCodeThread,
  pinCodeThread,
  renameCodeThread,
  reopenCodeThread,
  snoozeCodeThread,
  wakeCodeThread,
} from "./codeThreadCommands";

const thread = decodeCodeThread({
  id: "10000000-0000-4000-8000-000000000001",
  projectId: "20000000-0000-4000-8000-000000000001",
  checkoutId: "40000000-0000-4000-8000-000000000001",
  bindingRevisionId: "30000000-0000-4000-8000-000000000001",
  repositoryId: `repo_${"a".repeat(64)}`,
  providerInstanceId: "50000000-0000-4000-8000-000000000001",
  modelId: "model",
  title: "Thread",
  lifecycle: "active",
  pinned: false,
  executionPolicy: "approval-gated",
  permissionPersistence: "current-session",
  deliveryTarget: {
    branchIntent: "main",
    remoteName: "origin",
    proposedBaseRepository: "repo",
    proposedBaseBranch: "main",
    outcomeKind: "local-implementation",
    confirmedAt: "2026-07-21T12:00:00.000Z",
  },
  version: 7,
  createdAt: "2026-07-21T12:00:00.000Z",
  updatedAt: "2026-07-21T12:00:00.000Z",
});

describe("Code thread commands", () => {
  it.each([
    ["renames a thread", renameCodeThread(thread, "Renamed"), "rename-code-thread"],
    ["pins a thread", pinCodeThread(thread, true), "pin-code-thread"],
    ["archives a thread", archiveCodeThread(thread), "change-code-thread-lifecycle"],
    ["completes a thread", completeCodeThread(thread), "complete-code-thread"],
    ["reopens a thread", reopenCodeThread(thread), "reopen-code-thread"],
    [
      "snoozes a thread",
      snoozeCodeThread(thread, decodeUtcTimestamp("2026-07-22T12:00:00.000Z")),
      "snooze-code-thread",
    ],
    ["wakes a thread", wakeCodeThread(thread), "wake-code-thread"],
  ])("%s with the observed version", (_description, command, kind) => {
    expect(command).toMatchObject({ kind, expectedVersion: thread.version });
  });

  it("finds a thread by its branded identifier", () => {
    expect(findCodeThread([thread], String(thread.id) as CodeThread["id"])).toBe(thread);
  });

  it("returns no thread for an unknown identifier", () => {
    expect(
      findCodeThread([thread], "10000000-0000-4000-8000-000000000099" as CodeThread["id"]),
    ).toBeUndefined();
  });
});
