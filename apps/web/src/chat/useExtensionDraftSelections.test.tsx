import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { ExtensionProviderFamily } from "@octant/contracts/extensions";
import { Schema } from "effect";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { browserUseSelection } from "@octant/plugin-host/browser-use";
import { computerUseSelection } from "@octant/plugin-host/computer-use";
import { useExtensionDraftSelections } from "./useExtensionDraftSelections";

const projectA = "70000000-0000-4000-8000-000000000001";
const projectB = "70000000-0000-4000-8000-000000000002";
const providerFamily = Schema.decodeUnknownSync(ExtensionProviderFamily)("codex");

function pendingClient() {
  const snapshot = Promise.withResolvers<ExtensionSnapshot>();
  return {
    snapshot,
    client: {
      snapshot: vi.fn(() => snapshot.promise),
      effectiveState: vi.fn<ExtensionClient["effectiveState"]>(),
    },
  };
}

describe("draft extension selections", () => {
  it("ignores a completed lookup after the Project changes", async () => {
    const { snapshot, client } = pendingClient();
    const { result, rerender } = renderHook(
      ({ projectId }) =>
        useExtensionDraftSelections({ client, mode: "code", projectId, providerFamily }),
      { initialProps: { projectId: projectA } },
    );
    const pending = result.current.resolveReference("$review");
    rerender({ projectId: projectB });
    await act(async () => {
      snapshot.reject(new Error("Unavailable"));
      await pending;
    });
    expect(result.current.receipts).toEqual([]);
  });

  it("does not resurrect cleared selections when their lookup finishes", async () => {
    const { snapshot, client } = pendingClient();
    const { result } = renderHook(() =>
      useExtensionDraftSelections({
        client,
        mode: "code",
        projectId: projectA,
        providerFamily,
      }),
    );
    const pending = result.current.resolveReference("$review");
    act(() => result.current.clear());
    await act(async () => {
      snapshot.reject(new Error("Unavailable"));
      await pending;
    });
    expect(result.current.receipts).toEqual([]);
  });

  it("restores a refused selection to its original Project without replacing the active draft", () => {
    const { client } = pendingClient();
    const { result, rerender } = renderHook(
      ({ projectId }) =>
        useExtensionDraftSelections({ client, mode: "code", projectId, providerFamily }),
      { initialProps: { projectId: projectA } },
    );
    const receipt = (reference: string) => ({
      reference,
      label: reference,
      status: { kind: "blocked" as const, reason: "unavailable" },
    });
    act(() => result.current.restore([receipt("$review")]));
    const original = result.current.receipts;
    const restoreOriginal = result.current.restore;
    act(() => result.current.clear());
    rerender({ projectId: projectB });
    act(() => result.current.restore([receipt("$deploy")]));
    const active = result.current.receipts;
    act(() => restoreOriginal(original));
    expect(result.current.receipts).toEqual(active);
    rerender({ projectId: projectA });
    expect(result.current.receipts).toEqual(original);
  });

  it("leaves @browser and @computer as text, since both are offered tools", async () => {
    const { client } = pendingClient();
    const { result } = renderHook(() =>
      useExtensionDraftSelections({ client, mode: "code", projectId: projectA, providerFamily }),
    );
    const taken: boolean[] = [];
    await act(async () => {
      taken.push(await result.current.resolveReference("@browser"));
      taken.push(await result.current.resolveReference("@computer"));
    });
    expect(taken).toEqual([false, false]);
    expect(result.current.receipts).toEqual([]);
    expect(client.snapshot).not.toHaveBeenCalled();
  });

  it("drops Browser and Computer selections from an older draft and says neither needs one", () => {
    const { client } = pendingClient();
    const { result } = renderHook(() =>
      useExtensionDraftSelections({ client, mode: "work", projectId: projectA, providerFamily }),
    );
    act(() =>
      result.current.restore([
        {
          reference: "Browser",
          label: "Browser",
          selection: browserUseSelection("older-draft"),
          status: { kind: "selected" },
        },
        {
          reference: "Computer",
          label: "Computer",
          selection: computerUseSelection("older-draft"),
          status: { kind: "selected" },
        },
      ]),
    );
    expect(result.current.receipts).toEqual([
      {
        reference: "Browser",
        label: "Browser",
        status: { kind: "blocked", reason: "not needed; the agent is offered Browser on its own" },
      },
      {
        reference: "Computer",
        label: "Computer",
        status: { kind: "blocked", reason: "not needed; the agent is offered Computer on its own" },
      },
    ]);
  });

  it("refuses an invalid Project identity without querying a broader scope", async () => {
    const { client } = pendingClient();
    const { result } = renderHook(() =>
      useExtensionDraftSelections({
        client,
        mode: "code",
        projectId: "invalid",
        providerFamily,
      }),
    );
    await act(async () => {
      await result.current.resolveReference("$review");
    });
    expect(client.snapshot).not.toHaveBeenCalled();
    expect(client.effectiveState).not.toHaveBeenCalled();
    expect(result.current.receipts).toMatchObject([
      { status: { kind: "blocked", reason: "invalid-scope" } },
    ]);
  });

  it("offers a Project-root skill only in its own Project's palette", async () => {
    const digest = `sha256:${"d".repeat(64)}`;
    const snapshot = {
      sequence: 3,
      snapshotAt: "2026-10-14T00:00:00.000Z",
      packages: [],
      collisions: [],
      skills: [
        {
          skill: {
            qualifiedId: `agents-skills-directory:project:${projectA}:root:alpha-notes:${digest}`,
            name: "alpha-notes",
            sourceKind: "agents-skills-directory",
            digest,
            available: true,
          },
          source: { kind: "agents-skills-directory", sourceRef: `project:${projectA}:root` },
          displayName: "alpha-notes",
          provenance: { reviewed: true },
          contentBytes: 16,
          reviewed: true,
          desiredEnabled: true,
          effectiveState: { kind: "effective" },
          projectScope: { mode: "code", projectId: projectA },
        },
      ],
    } as unknown as ExtensionSnapshot;
    const client = {
      snapshot: vi.fn(async () => snapshot),
      effectiveState: vi.fn<ExtensionClient["effectiveState"]>(async ({ scope }) => ({
        sequence: snapshot.sequence,
        snapshotAt: snapshot.snapshotAt,
        scope,
        catalogEpoch: `sha256:${"e".repeat(64)}` as never,
        catalogStatus: "available",
        stale: false,
        packages: [],
        collisions: [],
      })),
    };
    const { result, rerender } = renderHook(
      ({ projectId }) =>
        useExtensionDraftSelections({ client, mode: "code", projectId, providerFamily }),
      { initialProps: { projectId: projectA } },
    );
    await act(async () => {
      await result.current.resolveReference("$alpha-notes");
    });
    expect(result.current.receipts.map((receipt) => receipt.status)).toEqual([
      { kind: "selected" },
    ]);

    act(() => result.current.clear());
    rerender({ projectId: projectB });
    await act(async () => {
      await result.current.resolveReference("$alpha-notes");
    });
    expect(result.current.receipts.map((receipt) => receipt.status.kind)).not.toContain("selected");
  });
});
