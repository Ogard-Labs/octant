import { ContextClientFailure, type ContextClient } from "@octant/client-runtime/context-client";
import { decodeContextCompactionId } from "@octant/contracts/context";
import type { ContextCompactionState } from "@octant/contracts/context-rpc";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { compactionStateFixture, contextFixture } from "./contextFixtures";
import { useSessionCompaction } from "./useSessionCompaction";

const subject = contextFixture().subject;
const providerInstanceId = contextFixture().modelLimits.providerInstanceId;
const compactionId = "60000000-0000-4000-8000-000000000001";
const executor = { kind: "runtime", driverKind: "codex", providerInstanceId } as const;
const available = compactionStateFixture(subject, {
  compaction: { status: "available" },
  executor,
});
const running = compactionStateFixture(subject, {
  compaction: { status: "refused", reason: "compaction-running" },
  latestCompaction: {
    status: "running",
    compactionId,
    executor,
    requestedAt: "2026-07-18T20:00:00.000Z",
  },
});
const failed = compactionStateFixture(subject, {
  compaction: { status: "available" },
  executor,
  latestCompaction: {
    status: "failed",
    compactionId,
    executor,
    reason: "timed-out",
    sessionMayHaveChanged: true,
    failedAt: "2026-07-18T20:01:00.000Z",
  },
});

const newCompactionId = () => compactionId;

describe("useSessionCompaction", () => {
  it("asks the host for the thread's compaction state and again when its turns move on", async () => {
    const readCompaction = vi.fn<ContextClient["readCompaction"]>(async () => available);
    const client = fakeClient({ readCompaction });
    const { rerender, result } = renderHook(
      ({ revision }) => useSessionCompaction({ client, revision, subject }),
      { initialProps: { revision: 1 } },
    );

    await waitFor(() => expect(result.current.state).toEqual(available));
    expect(readCompaction).toHaveBeenCalledWith(subject, expect.any(AbortSignal));
    rerender({ revision: 2 });
    await waitFor(() => expect(readCompaction).toHaveBeenCalledTimes(2));
  });

  it("sends the person's request under a fresh id, then follows the compaction until it ends", async () => {
    const answers: Array<ContextCompactionState> = [available, running, running, failed];
    const readCompaction = vi.fn<ContextClient["readCompaction"]>(
      async () => answers.shift() ?? failed,
    );
    const execute = vi.fn<ContextClient["execute"]>(async () => ({
      kind: "compaction-started",
      compactionId: decodeContextCompactionId(compactionId),
      executor,
    }));
    const onSettled = vi.fn();
    const client = fakeClient({ execute, readCompaction });
    const { result } = renderHook(() =>
      useSessionCompaction({
        client,
        newCompactionId,
        onSettled,
        pollMs: 5,
        subject,
      }),
    );
    await waitFor(() => expect(result.current.state).toEqual(available));

    await act(() => result.current.compact());

    expect(execute).toHaveBeenCalledWith({ kind: "compact-session", subject, compactionId });
    await waitFor(() => expect(result.current.state?.latestCompaction?.status).toBe("failed"));
    expect(result.current.settledId).toBe(compactionId);
    expect(onSettled).toHaveBeenCalledOnce();
    expect(readCompaction).toHaveBeenCalledTimes(4);
  });

  it("does not announce a result that was already there when the thread opened", async () => {
    const onSettled = vi.fn();
    const client = fakeClient({ readCompaction: vi.fn(async () => failed) });
    const { result } = renderHook(() =>
      useSessionCompaction({
        client,
        onSettled,
        subject,
      }),
    );

    await waitFor(() => expect(result.current.state).toEqual(failed));
    expect(result.current.settledId).toBeUndefined();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("keeps the host's reason for refusing the request until it offers compaction again", async () => {
    const refused = compactionStateFixture(subject, {
      compaction: { status: "refused", reason: "turn-running" },
    });
    const answers: Array<ContextCompactionState> = [available, refused, available];
    const readCompaction = vi.fn<ContextClient["readCompaction"]>(
      async () => answers.shift() ?? available,
    );
    const execute = vi.fn<ContextClient["execute"]>(async () => {
      throw new ContextClientFailure("compaction-refused", "Refused.", "turn-running");
    });
    const client = fakeClient({ execute, readCompaction });
    const { rerender, result } = renderHook(
      ({ revision }) =>
        useSessionCompaction({
          client,
          newCompactionId,
          revision,
          subject,
        }),
      { initialProps: { revision: 1 } },
    );
    await waitFor(() => expect(result.current.state).toEqual(available));

    await act(() => result.current.compact());
    expect(result.current.refusal).toBe("turn-running");
    expect(result.current.starting).toBe(false);

    rerender({ revision: 2 });
    await waitFor(() => expect(result.current.refusal).toBeUndefined());
  });

  it("keeps a running compaction, and keeps asking, when one read fails", async () => {
    let release: (state: ContextCompactionState) => void = () => undefined;
    const third = new Promise<ContextCompactionState>((resolve) => {
      release = resolve;
    });
    const readCompaction = vi
      .fn<ContextClient["readCompaction"]>()
      .mockResolvedValueOnce(running)
      .mockRejectedValueOnce(new ContextClientFailure("unavailable", "Down."))
      .mockReturnValueOnce(third)
      .mockResolvedValue(failed);
    const client = fakeClient({ readCompaction });
    const { result } = renderHook(() => useSessionCompaction({ client, pollMs: 5, subject }));

    // The read after the failed one is under way, so polling went on.
    await waitFor(() => expect(readCompaction).toHaveBeenCalledTimes(3));
    expect(result.current.state?.latestCompaction?.status).toBe("running");
    release(failed);
    await waitFor(() => expect(result.current.state?.latestCompaction?.status).toBe("failed"));
    expect(result.current.settledId).toBe(compactionId);
  });

  it("keeps asking after a read the transport interrupted while a compaction runs", async () => {
    const readCompaction = vi
      .fn<ContextClient["readCompaction"]>()
      .mockResolvedValueOnce(running)
      .mockRejectedValueOnce(new ContextClientFailure("interrupted", "Cut off."))
      .mockResolvedValue(failed);
    const client = fakeClient({ readCompaction });
    const { result } = renderHook(() => useSessionCompaction({ client, pollMs: 5, subject }));

    await waitFor(() => expect(result.current.state?.latestCompaction?.status).toBe("failed"));
    expect(readCompaction).toHaveBeenCalledTimes(3);
  });

  it("lets go of a running compaction, and says its state is unknown, when the host stops answering", async () => {
    const readCompaction = vi
      .fn<ContextClient["readCompaction"]>()
      .mockResolvedValueOnce(running)
      .mockRejectedValue(new ContextClientFailure("unauthorized", "No longer yours."));
    const client = fakeClient({ readCompaction });
    const { result } = renderHook(() => useSessionCompaction({ client, pollMs: 1, subject }));

    await waitFor(() => expect(result.current.stateUnknown).toBe(true), { timeout: 3_000 });
    // Five failed reads after the running answer, each later than the last.
    expect(readCompaction).toHaveBeenCalledTimes(6);
    expect(result.current.state).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readCompaction).toHaveBeenCalledTimes(6);
  });

  it("takes the host's record over a request whose answer was lost", async () => {
    const answers: Array<ContextCompactionState> = [available, running, failed];
    const readCompaction = vi.fn<ContextClient["readCompaction"]>(
      async () => answers.shift() ?? failed,
    );
    const execute = vi.fn<ContextClient["execute"]>(async () => {
      throw new ContextClientFailure("unavailable", "Lost.");
    });
    const client = fakeClient({ execute, readCompaction });
    const { result } = renderHook(() =>
      useSessionCompaction({ client, newCompactionId, pollMs: 5, subject }),
    );
    await waitFor(() => expect(result.current.state).toEqual(available));

    await act(() => result.current.compact());

    expect(result.current.errorMessage).toBeUndefined();
    await waitFor(() => expect(result.current.state?.latestCompaction?.status).toBe("failed"));
    expect(result.current.settledId).toBe(compactionId);
  });

  it("offers nothing when the host cannot say", async () => {
    const client = fakeClient({
      readCompaction: vi.fn(async () => {
        throw new ContextClientFailure("unavailable", "Down.");
      }),
    });
    const { result } = renderHook(() => useSessionCompaction({ client, subject }));

    await waitFor(() => expect(result.current.state).toBeUndefined());
    await act(() => result.current.compact());
    expect(result.current.errorMessage).toBe(
      "Couldn't compact: the host did not answer. Try again.",
    );
  });
});

function fakeClient(overrides: Partial<ContextClient> = {}): ContextClient {
  return {
    inspect: vi.fn(async () => contextFixture()),
    execute: vi.fn(async () => {
      throw new ContextClientFailure("unavailable", "Down.");
    }),
    readCompaction: vi.fn(async () => available),
    externalContentAvailable: false,
    readExternalContent: vi.fn(),
    clearExternalContent: vi.fn(),
    ...overrides,
  };
}
