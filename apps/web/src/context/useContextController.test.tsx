import type { ContextClient } from "@octant/client-runtime/context-client";
import { ContextClientFailure } from "@octant/client-runtime/context-client";
import type { ContextCommand } from "@octant/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { contextFixture, contextReconnectFixture, contextReplayFixture } from "./contextFixtures";
import { useContextController } from "./useContextController";

const subject = contextFixture().subject;

describe("useContextController", () => {
  it("stays idle without an active subject and loads when pane focus supplies one", async () => {
    const inspect = vi.fn<ContextClient["inspect"]>(async () => contextFixture());
    const client = fakeClient({ inspect });
    const { rerender, result } = renderHook(
      ({ activeSubject }) => useContextController({ client, subject: activeSubject }),
      { initialProps: { activeSubject: undefined as typeof subject | undefined } },
    );
    expect(result.current.status).toBe("idle");
    expect(inspect).not.toHaveBeenCalled();

    rerender({ activeSubject: subject });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(inspect).toHaveBeenCalledWith({ subject }, expect.any(AbortSignal));
  });

  it("loads a replay-aware snapshot and aborts the request on disposal", async () => {
    let signal: AbortSignal | undefined;
    const client = fakeClient({
      inspect: vi.fn(async (_request, requestSignal) => {
        signal = requestSignal;
        return contextFixture({ sequence: 9 });
      }),
    });
    const { result, unmount } = renderHook(() => useContextController({ client, subject }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(client.inspect).toHaveBeenCalledWith({ subject }, expect.any(AbortSignal));
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("sends turn-scoped pin/exclude commands with the expected manifest identity", async () => {
    const snapshot = contextFixture();
    const execute = vi.fn(async (command: ContextCommand) => ({
      kind: "context-updated" as const,
      snapshot: {
        ...snapshot,
        next: {
          ...snapshot.next,
          manifest: {
            ...snapshot.next.manifest,
            overrides:
              command.kind === "update-context-overrides"
                ? command.overrides
                : snapshot.next.manifest.overrides,
          },
        },
      },
    }));
    const client = fakeClient({ execute });
    const { result } = renderHook(() => useContextController({ client, subject }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const entryId = snapshot.next.manifest.entries[1]!.id;
    await act(() => result.current.setPinned(entryId, true));
    expect(execute).toHaveBeenLastCalledWith(
      {
        kind: "update-context-overrides",
        subject,
        expectedManifestId: snapshot.next.manifest.id,
        overrides: { pinnedEntryIds: [entryId], excludedEntryIds: [] },
      },
      expect.any(AbortSignal),
    );
    await act(() => result.current.setPinned(entryId, false));
    await act(() => result.current.setExcluded(entryId, true));
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "update-context-overrides",
        overrides: { pinnedEntryIds: [], excludedEntryIds: [entryId] },
      }),
      expect.any(AbortSignal),
    );
  });

  it("reloads authoritative state after a stale command", async () => {
    const inspect = vi
      .fn<ContextClient["inspect"]>()
      .mockResolvedValueOnce(contextFixture({ sequence: 8 }))
      .mockResolvedValueOnce(contextReplayFixture());
    const client = fakeClient({
      inspect,
      execute: vi.fn(async () => {
        throw new ContextClientFailure("stale", "Reload context.");
      }),
    });
    const { result } = renderHook(() => useContextController({ client, subject }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(() => result.current.rebuild());
    await waitFor(() => expect(result.current.snapshot?.sequence).toBe(10));
    expect(inspect).toHaveBeenLastCalledWith(
      { subject, afterSequence: 8 },
      expect.any(AbortSignal),
    );
  });

  it("classifies interruption separately and does not retain raw failures", async () => {
    const client = fakeClient({
      inspect: vi.fn(async () => {
        throw new ContextClientFailure("unavailable", "token=secret");
      }),
    });
    const { result } = renderHook(() => useContextController({ client, subject }));
    await waitFor(() => expect(result.current.status).toBe("disconnected"));
    expect(result.current.errorMessage).toBe("Context is unavailable. Retry the local connection.");
    expect(result.current.errorMessage).not.toContain("secret");
  });

  it("says a thread has no context plan yet rather than reporting a broken connection", async () => {
    const client = fakeClient({
      inspect: vi.fn(async () => {
        throw new ContextClientFailure("not-planned", "This thread has no context plan yet.");
      }),
    });
    const { result } = renderHook(() => useContextController({ client, subject }));
    await waitFor(() => expect(result.current.status).toBe("not-planned"));
    // Nothing to retry and nothing broke, so the panel carries no error at all.
    expect(result.current.errorMessage).toBeUndefined();
  });

  it("replays from the accepted sequence and recovers a reconnected snapshot", async () => {
    const inspect = vi
      .fn<ContextClient["inspect"]>()
      .mockResolvedValueOnce(contextFixture({ sequence: 8 }))
      .mockRejectedValueOnce(new ContextClientFailure("unavailable", "Disconnected."))
      .mockResolvedValueOnce(contextReconnectFixture());
    const client = fakeClient({ inspect });
    const { result } = renderHook(() => useContextController({ client, subject }));
    await waitFor(() => expect(result.current.snapshot?.sequence).toBe(8));
    await act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("disconnected"));
    expect(inspect).toHaveBeenLastCalledWith(
      { subject, afterSequence: 8 },
      expect.any(AbortSignal),
    );
    await act(() => result.current.retry());
    await waitFor(() => expect(result.current.snapshot?.sequence).toBe(12));
    expect(result.current.status).toBe("ready");
  });

  it("does not restart loading when an equivalent subject object is rerendered", async () => {
    const inspect = vi.fn<ContextClient["inspect"]>(async () => contextFixture());
    const client = fakeClient({ inspect });
    const { rerender, result } = renderHook(
      ({ activeSubject }) => useContextController({ client, subject: activeSubject }),
      { initialProps: { activeSubject: { ...subject } } },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender({ activeSubject: { ...subject } });
    await Promise.resolve();
    expect(inspect).toHaveBeenCalledTimes(1);
  });
});

function fakeClient(overrides: Partial<ContextClient> = {}): ContextClient {
  return {
    inspect: vi.fn(async () => contextFixture()),
    execute: vi.fn(async () => ({ kind: "context-rebuilt" as const, snapshot: contextFixture() })),
    ...overrides,
  };
}
