import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { ExtensionProviderFamily } from "@octant/contracts/extensions";
import { Schema } from "effect";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

  it("restores a refused selection to its original Project without replacing the active draft", async () => {
    const { client } = pendingClient();
    const { result, rerender } = renderHook(
      ({ projectId }) =>
        useExtensionDraftSelections({ client, mode: "code", projectId, providerFamily }),
      { initialProps: { projectId: projectA } },
    );
    await act(async () => {
      await result.current.resolveReference("@Browser");
    });
    const original = result.current.receipts;
    const restoreOriginal = result.current.restore;
    act(() => result.current.clear());
    rerender({ projectId: projectB });
    await act(async () => {
      await result.current.resolveReference("@Browser");
    });
    const active = result.current.receipts;
    act(() => restoreOriginal(original));
    expect(result.current.receipts).toEqual(active);
    rerender({ projectId: projectA });
    expect(result.current.receipts).toEqual(original);
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
});
