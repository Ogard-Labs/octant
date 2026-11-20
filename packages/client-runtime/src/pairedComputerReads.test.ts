import { decodeCodeNavigation } from "@octant/contracts/code";
import { decodePendingRequestList } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { createHostReadModelCache, mergeAllHostsReadModels } from "./hostFederationMergedReads";
import {
  isPairedComputerAsk,
  isPairedComputerThread,
  pairedComputerReadItems,
} from "./pairedComputerReads";

const studio = "11111111-1111-4111-8111-111111111111";
const now = "2026-11-20T09:00:00.000Z";

function thread(id: string, title: string, lifecycle: "active" | "archived" = "active") {
  return {
    id,
    projectId: "20000000-0000-4000-8000-000000000001",
    bindingRevisionId: "30000000-0000-4000-8000-000000000001",
    repositoryId: `repo_${"a".repeat(64)}`,
    checkoutId: "40000000-0000-4000-8000-000000000001",
    title,
    lifecycle,
    providerInstanceId: "50000000-0000-4000-8000-000000000001",
    modelId: "model-a",
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "main",
      remoteName: "origin",
      proposedBaseRepository: "octocat/octant",
      proposedBaseBranch: "main",
      outcomeKind: "opened-pr",
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

const working = "60000000-0000-4000-8000-000000000001";
const waiting = "60000000-0000-4000-8000-000000000002";
const archived = "60000000-0000-4000-8000-000000000003";

describe("a paired computer's work in this window", () => {
  it("lists that computer's active Code threads with their live state, and what it holds for the person", () => {
    const items = pairedComputerReadItems({
      hostId: studio,
      navigation: decodeCodeNavigation({
        threads: [
          thread(working, "Fix login"),
          thread(waiting, "Bump deps"),
          thread(archived, "Old", "archived"),
        ],
        runtime: [
          { threadId: working, executing: true },
          { threadId: waiting, executing: false, awaitingInput: true },
        ],
        plannerThreadIds: [],
      }),
      pendingRequests: decodePendingRequestList({
        requests: [
          {
            mode: "code",
            kind: "approval",
            projectId: "20000000-0000-4000-8000-000000000001",
            threadId: waiting,
            threadTitle: "Bump deps",
            text: "Run `bun install`.",
            requestedAt: now,
            answer: {
              threadId: waiting,
              checkoutId: "40000000-0000-4000-8000-000000000001",
              approvalId: "70000000-0000-4000-8000-000000000001",
            },
          },
        ],
        truncated: false,
      }),
    });

    const cache = createHostReadModelCache();
    cache.put({
      hostId: studio as never,
      hostDisplayName: "Studio Mac",
      freshness: "ready",
      items: items.map((item) => ({
        ...item,
        hostDisplayName: "Studio Mac",
        freshness: "ready",
        readOnly: false,
      })),
    });
    const merged = mergeAllHostsReadModels(cache.list()).items;
    const threads = merged.filter(isPairedComputerThread);
    expect(threads.map((item) => [item.title, item.payload.state]).sort()).toEqual([
      ["Bump deps", "needs-you"],
      ["Fix login", "working"],
    ]);
    // Each item keeps the computer it belongs to.
    expect(threads.every((item) => String(item.ref.hostId) === studio)).toBe(true);
    const asks = merged.filter(isPairedComputerAsk);
    expect(asks.map((item) => item.payload.request.threadTitle)).toEqual(["Bump deps"]);
  });

  it("keeps a computer's last items, read-only, once it stops answering", () => {
    const cache = createHostReadModelCache();
    const items = pairedComputerReadItems({
      hostId: studio,
      navigation: decodeCodeNavigation({
        threads: [thread(working, "Fix login")],
        plannerThreadIds: [],
      }),
      pendingRequests: undefined,
    });
    cache.put({
      hostId: studio as never,
      hostDisplayName: "Studio Mac",
      freshness: "ready",
      items: items.map((item) => ({
        ...item,
        hostDisplayName: "Studio Mac",
        freshness: "ready",
        readOnly: false,
      })),
    });
    cache.markStale(studio, "unavailable");
    const [only] = mergeAllHostsReadModels(cache.list()).items;
    expect(only?.title).toBe("Fix login");
    expect(only?.readOnly).toBe(true);
  });
});
