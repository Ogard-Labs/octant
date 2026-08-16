import { describe, expect, it, vi } from "vitest";
import { LOCAL_HOST_ID, decodeHostId } from "@octant/contracts/host";
import { globalEntityReference } from "./hostFederationTransports";
import type { HostFederationTransports } from "./hostFederationTransports";
import {
  allowAuthorityBearingMutation,
  buildFederatedReadItem,
  createHostReadModelCache,
  filterFederatedReadItems,
  freshnessFromTransportState,
  mergeAllHostsReadModels,
  refreshAllHostsReadModels,
  rejectQueuedAuthorityMutation,
  searchFederatedReadItems,
  sortFederatedReadItems,
  type FederatedReadItem,
  type HostReadModelContribution,
} from "./hostFederationMergedReads";

const HOST_A = decodeHostId("11111111-1111-4111-8111-111111111111");
const HOST_B = decodeHostId("22222222-2222-4222-8222-222222222222");

const NOW = "2026-08-12T10:00:00.000Z";
const LATER = "2026-08-12T12:00:00.000Z";
const EARLIER = "2026-08-12T08:00:00.000Z";

function item(input: {
  readonly hostId: typeof HOST_A | typeof HOST_B | typeof LOCAL_HOST_ID;
  readonly entityId: string;
  readonly kind: FederatedReadItem["kind"];
  readonly title: string;
  readonly sortKey: string;
  readonly hostDisplayName?: string;
  readonly freshness?: FederatedReadItem["freshness"];
  readonly tags?: ReadonlyArray<string>;
}): FederatedReadItem {
  const freshness = input.freshness ?? "ready";
  return {
    ref: globalEntityReference(input.hostId, input.entityId),
    kind: input.kind,
    hostDisplayName: input.hostDisplayName ?? "Host",
    title: input.title,
    sortKey: input.sortKey,
    searchableText: `${input.title} ${input.kind} ${input.entityId}`,
    freshness,
    readOnly: freshness !== "ready",
    tags: input.tags ?? [],
    payload: { title: input.title },
  };
}

function contribution(input: {
  readonly hostId: typeof HOST_A | typeof HOST_B | typeof LOCAL_HOST_ID;
  readonly displayName: string;
  readonly freshness: HostReadModelContribution["freshness"];
  readonly items: ReadonlyArray<FederatedReadItem>;
}): HostReadModelContribution {
  return {
    hostId: input.hostId,
    hostDisplayName: input.displayName,
    freshness: input.freshness,
    items: input.items.map((entry) => ({
      ...entry,
      hostDisplayName: input.displayName,
      freshness: input.freshness,
      readOnly: input.freshness !== "ready",
    })),
  };
}

describe("HostFederationMergedReads (Post-preview B3)", () => {
  it("namespaces merged items by host so duplicate entity IDs remain distinct", () => {
    const sharedEntityId = "00000000-0000-4000-8000-000000000099";
    const merged = mergeAllHostsReadModels([
      contribution({
        hostId: HOST_A,
        displayName: "Studio",
        freshness: "ready",
        items: [
          item({
            hostId: HOST_A,
            entityId: sharedEntityId,
            kind: "project",
            title: "Atlas",
            sortKey: NOW,
            hostDisplayName: "Studio",
          }),
        ],
      }),
      contribution({
        hostId: HOST_B,
        displayName: "Laptop",
        freshness: "ready",
        items: [
          item({
            hostId: HOST_B,
            entityId: sharedEntityId,
            kind: "project",
            title: "Atlas",
            sortKey: LATER,
            hostDisplayName: "Laptop",
          }),
        ],
      }),
    ]);

    expect(merged.items).toHaveLength(2);
    expect(merged.items.map((entry) => entry.ref.hostId)).toEqual([HOST_B, HOST_A]);
    expect(merged.items.every((entry) => entry.ref.entityId === sharedEntityId)).toBe(true);
    expect(federatedRefsAreDistinct(merged.items[0]!.ref, merged.items[1]!.ref)).toBe(true);
  });

  it("merges Projects, threads, activity, agents, approvals, and Code board deterministically", () => {
    const merged = mergeAllHostsReadModels([
      contribution({
        hostId: LOCAL_HOST_ID,
        displayName: "This Mac",
        freshness: "ready",
        items: [
          item({
            hostId: LOCAL_HOST_ID,
            entityId: "project-local",
            kind: "project",
            title: "Local Project",
            sortKey: EARLIER,
          }),
          item({
            hostId: LOCAL_HOST_ID,
            entityId: "thread-local",
            kind: "thread",
            title: "Local thread",
            sortKey: NOW,
          }),
          item({
            hostId: LOCAL_HOST_ID,
            entityId: "activity-local",
            kind: "activity",
            title: "Local activity",
            sortKey: EARLIER,
          }),
        ],
      }),
      contribution({
        hostId: HOST_A,
        displayName: "Studio",
        freshness: "ready",
        items: [
          item({
            hostId: HOST_A,
            entityId: "agent-a",
            kind: "agent",
            title: "Studio agent",
            sortKey: LATER,
          }),
          item({
            hostId: HOST_A,
            entityId: "approval-a",
            kind: "approval",
            title: "Studio approval",
            sortKey: NOW,
          }),
          item({
            hostId: HOST_A,
            entityId: "board-a",
            kind: "code-board",
            title: "Studio board card",
            sortKey: LATER,
          }),
        ],
      }),
    ]);

    // Newer sortKey first; equal keys break by hostId then entityId.
    expect(merged.items.map((entry) => `${entry.kind}:${entry.title}`)).toEqual([
      "agent:Studio agent",
      "code-board:Studio board card",
      "approval:Studio approval",
      "thread:Local thread",
      "activity:Local activity",
      "project:Local Project",
    ]);
  });

  it("sorts ties by hostId then entityId for stable ordering", () => {
    const sorted = sortFederatedReadItems([
      item({
        hostId: HOST_B,
        entityId: "zzzzzzzz-0000-4000-8000-000000000002",
        kind: "thread",
        title: "B-late",
        sortKey: NOW,
      }),
      item({
        hostId: HOST_A,
        entityId: "aaaaaaaa-0000-4000-8000-000000000001",
        kind: "thread",
        title: "A-early-id",
        sortKey: NOW,
      }),
      item({
        hostId: HOST_A,
        entityId: "bbbbbbbb-0000-4000-8000-000000000001",
        kind: "thread",
        title: "A-late-id",
        sortKey: NOW,
      }),
    ]);

    expect(sorted.map((entry) => entry.title)).toEqual(["A-early-id", "A-late-id", "B-late"]);
  });

  it("filters and searches across hosts without collapsing ownership", () => {
    const merged = mergeAllHostsReadModels([
      contribution({
        hostId: HOST_A,
        displayName: "Studio",
        freshness: "ready",
        items: [
          item({
            hostId: HOST_A,
            entityId: "proj-1",
            kind: "project",
            title: "Alpha Studio",
            sortKey: NOW,
            tags: ["chat"],
          }),
          item({
            hostId: HOST_A,
            entityId: "thread-1",
            kind: "thread",
            title: "Fix auth",
            sortKey: LATER,
            tags: ["chat"],
          }),
        ],
      }),
      contribution({
        hostId: HOST_B,
        displayName: "Laptop",
        freshness: "ready",
        items: [
          item({
            hostId: HOST_B,
            entityId: "proj-1",
            kind: "project",
            title: "Alpha Laptop",
            sortKey: EARLIER,
            tags: ["code"],
          }),
        ],
      }),
    ]);

    const hostFiltered = filterFederatedReadItems(merged.items, { hostId: HOST_A });
    expect(hostFiltered.map((entry) => entry.title)).toEqual(["Fix auth", "Alpha Studio"]);

    const kindFiltered = filterFederatedReadItems(merged.items, { kinds: ["project"] });
    expect(kindFiltered.map((entry) => entry.title)).toEqual(["Alpha Studio", "Alpha Laptop"]);

    const searched = searchFederatedReadItems(merged.items, "alpha");
    expect(searched.map((entry) => `${entry.ref.hostId}:${entry.title}`)).toEqual([
      `${HOST_A}:Alpha Studio`,
      `${HOST_B}:Alpha Laptop`,
    ]);
  });

  it("marks disconnected-host cache entries stale and read-only", () => {
    const cache = createHostReadModelCache();
    cache.put(
      contribution({
        hostId: HOST_A,
        displayName: "Studio",
        freshness: "ready",
        items: [
          item({
            hostId: HOST_A,
            entityId: "proj-1",
            kind: "project",
            title: "Studio Project",
            sortKey: NOW,
          }),
        ],
      }),
    );

    cache.markStale(HOST_A, "unavailable");
    const stale = cache.get(HOST_A);
    expect(stale?.freshness).toBe("stale");
    expect(stale?.items.every((entry) => entry.freshness === "stale" && entry.readOnly)).toBe(true);

    const merged = mergeAllHostsReadModels(cache.list());
    expect(merged.items[0]?.readOnly).toBe(true);
    expect(merged.hostStates.find((state) => state.hostId === HOST_A)?.freshness).toBe("stale");
  });

  it("rejects queued authority-bearing mutations while a host is stale", () => {
    expect(allowAuthorityBearingMutation("ready")).toBe(true);
    expect(allowAuthorityBearingMutation("stale")).toBe(false);
    expect(allowAuthorityBearingMutation("unavailable")).toBe(false);
    expect(allowAuthorityBearingMutation("unauthorized")).toBe(false);
    expect(allowAuthorityBearingMutation("connecting")).toBe(false);
    expect(allowAuthorityBearingMutation("incompatible")).toBe(false);

    const rejected = rejectQueuedAuthorityMutation({
      hostId: HOST_A,
      freshness: "stale",
      action: "create-thread",
    });
    expect(rejected.queued).toBe(false);
    expect(rejected.allowed).toBe(false);
    expect(rejected.reason).toMatch(/stale|read-only|reconnect/i);
  });

  it("keeps healthy host rows when another host fails during merge refresh", () => {
    const healthy = contribution({
      hostId: HOST_A,
      displayName: "Studio",
      freshness: "ready",
      items: [
        item({
          hostId: HOST_A,
          entityId: "thread-ok",
          kind: "thread",
          title: "Healthy",
          sortKey: LATER,
        }),
      ],
    });
    const merged = mergeAllHostsReadModels([healthy], {
      failures: [
        {
          hostId: HOST_B,
          category: "unavailable",
          message: "Laptop transport rejected.",
        },
      ],
    });

    expect(merged.items.map((entry) => entry.title)).toEqual(["Healthy"]);
    expect(merged.failures).toEqual([
      expect.objectContaining({
        hostId: HOST_B,
        category: "unavailable",
      }),
    ]);
    expect(merged.hostStates.map((state) => state.hostId)).toContain(HOST_A);
  });

  it("uses cached stale rows for a failed host without clearing healthy hosts", () => {
    const cache = createHostReadModelCache();
    cache.put(
      contribution({
        hostId: HOST_B,
        displayName: "Laptop",
        freshness: "ready",
        items: [
          item({
            hostId: HOST_B,
            entityId: "cached-thread",
            kind: "thread",
            title: "Cached Laptop",
            sortKey: EARLIER,
          }),
        ],
      }),
    );

    const result = cache.applyRefreshResults([
      {
        hostId: HOST_A,
        status: "fulfilled",
        contribution: contribution({
          hostId: HOST_A,
          displayName: "Studio",
          freshness: "ready",
          items: [
            item({
              hostId: HOST_A,
              entityId: "fresh-thread",
              kind: "thread",
              title: "Fresh Studio",
              sortKey: LATER,
            }),
          ],
        }),
      },
      {
        hostId: HOST_B,
        status: "rejected",
        reason: "transport down",
        category: "unavailable",
      },
    ]);

    expect(result.items.map((entry) => entry.title)).toEqual(["Fresh Studio", "Cached Laptop"]);
    expect(result.items.find((entry) => entry.ref.hostId === HOST_B)?.freshness).toBe("stale");
    expect(result.failures).toEqual([
      expect.objectContaining({ hostId: HOST_B, category: "unavailable" }),
    ]);
    expect(
      allowAuthorityBearingMutation(result.hostStates.find((s) => s.hostId === HOST_B)!.freshness),
    ).toBe(false);
  });

  it("removes only the revoked host cache and never invents ownership merge", () => {
    const cache = createHostReadModelCache();
    cache.put(
      contribution({
        hostId: HOST_A,
        displayName: "Studio",
        freshness: "ready",
        items: [
          item({
            hostId: HOST_A,
            entityId: "same-id",
            kind: "project",
            title: "Studio same",
            sortKey: NOW,
          }),
        ],
      }),
    );
    cache.put(
      contribution({
        hostId: HOST_B,
        displayName: "Laptop",
        freshness: "ready",
        items: [
          item({
            hostId: HOST_B,
            entityId: "same-id",
            kind: "project",
            title: "Laptop same",
            sortKey: LATER,
          }),
        ],
      }),
    );

    cache.remove(HOST_A);
    const remaining = mergeAllHostsReadModels(cache.list());
    expect(remaining.items).toHaveLength(1);
    expect(remaining.items[0]?.ref.hostId).toBe(HOST_B);
    expect(remaining.items[0]?.title).toBe("Laptop same");
  });

  it("maps transport states to read freshness and builds namespaced items", () => {
    expect(freshnessFromTransportState({ kind: "local-ready" })).toBe("ready");
    expect(
      freshnessFromTransportState({
        kind: "ready",
        hostId: HOST_A,
        displayName: "Studio",
      }),
    ).toBe("ready");
    expect(
      freshnessFromTransportState({
        kind: "stale",
        hostId: HOST_A,
        displayName: "Studio",
      }),
    ).toBe("stale");
    expect(
      freshnessFromTransportState({
        kind: "unauthorized",
        reason: "revoked",
        reasonCode: "revoked",
      }),
    ).toBe("unauthorized");
    expect(freshnessFromTransportState({ kind: "idle" })).toBe("unavailable");

    const built = buildFederatedReadItem({
      hostId: HOST_A,
      entityId: "approval-1",
      kind: "approval",
      hostDisplayName: "Studio",
      title: "Approve shell",
      sortKey: NOW,
      tags: ["approval"],
    });
    expect(built.ref).toEqual(globalEntityReference(HOST_A, "approval-1"));
    expect(built.readOnly).toBe(false);
  });

  it("refreshes through transport fan-out while preserving stale cache on failure", async () => {
    const cache = createHostReadModelCache();
    cache.put(
      contribution({
        hostId: HOST_B,
        displayName: "Laptop",
        freshness: "ready",
        items: [
          item({
            hostId: HOST_B,
            entityId: "cached",
            kind: "thread",
            title: "Cached",
            sortKey: EARLIER,
          }),
        ],
      }),
    );

    const transports = {
      fanOut: vi.fn(async (execute) => {
        const localSlot = {
          hostId: LOCAL_HOST_ID,
          kind: "local" as const,
          displayName: "This Mac",
          state: { kind: "local-ready" as const },
        };
        const remoteSlot = {
          hostId: HOST_B,
          kind: "remote" as const,
          displayName: "Laptop",
          state: {
            kind: "unavailable" as const,
            reason: "down",
            hostId: HOST_B,
            displayName: "Laptop",
          },
        };
        const settled = await Promise.allSettled([execute(localSlot), execute(remoteSlot)]);
        return settled.map((result, index) => {
          const hostId = index === 0 ? LOCAL_HOST_ID : HOST_B;
          if (result.status === "fulfilled") {
            return { hostId, status: "fulfilled" as const, value: result.value };
          }
          return { hostId, status: "rejected" as const, reason: result.reason };
        });
      }),
    } as unknown as HostFederationTransports;

    const merged = await refreshAllHostsReadModels({
      transports,
      cache,
      fetchContribution: async (slot) => [
        buildFederatedReadItem({
          hostId: slot.hostId,
          entityId: "live-thread",
          kind: "thread",
          hostDisplayName: slot.displayName,
          title: "Live local",
          sortKey: LATER,
        }),
      ],
    });

    expect(merged.items.map((entry) => entry.title)).toEqual(["Live local", "Cached"]);
    expect(merged.items.find((entry) => entry.ref.hostId === HOST_B)?.freshness).toBe("stale");
    expect(merged.failures).toEqual([
      expect.objectContaining({ hostId: HOST_B, category: "unavailable" }),
    ]);
    expect(allowAuthorityBearingMutation("stale")).toBe(false);
  });
});

function federatedRefsAreDistinct(
  left: FederatedReadItem["ref"],
  right: FederatedReadItem["ref"],
): boolean {
  return !(left.hostId === right.hostId && left.entityId === right.entityId);
}
