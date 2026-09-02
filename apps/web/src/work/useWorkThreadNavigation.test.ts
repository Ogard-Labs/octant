import { decodeWorkThread, decodeWorkThreadBootstrap, decodeWorkThreadId } from "@octant/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildWorkThreadNavigation, useWorkThreadNavigation } from "./useWorkThreadNavigation";

const threadId = decodeWorkThreadId("10000000-0000-4000-8000-000000000101");

function workThread() {
  return decodeWorkThread({
    id: threadId,
    projectId: "20000000-0000-4000-8000-000000000101",
    title: "Research brief",
    lifecycle: "active",
    providerInstanceId: "80000000-0000-4000-8000-0000000000b1",
    modelId: "model-one",
    version: 2,
    createdAt: "2026-08-01T20:00:00.000Z",
    updatedAt: "2026-08-01T20:00:00.000Z",
  });
}

describe("buildWorkThreadNavigation", () => {
  it("projects active bound threads for the Project sidebar and omits deleted history", () => {
    const active = workThread();
    const archived = {
      ...active,
      id: decodeWorkThreadId("10000000-0000-4000-8000-000000000102"),
      lifecycle: "archived" as const,
    };

    expect(buildWorkThreadNavigation([active, archived])).toEqual([
      {
        threadId: String(threadId),
        title: "Research brief",
        projectId: "20000000-0000-4000-8000-000000000101",
        providerInstanceId: "80000000-0000-4000-8000-0000000000b1",
        updatedAt: "2026-08-01T20:00:00.000Z",
      },
    ]);
  });

  it("marks a Work row working when the host projects the thread as executing", () => {
    const active = workThread();

    expect(buildWorkThreadNavigation([active], [{ threadId, executing: true }])).toEqual([
      {
        activity: "working",
        threadId: String(threadId),
        title: "Research brief",
        projectId: "20000000-0000-4000-8000-000000000101",
        providerInstanceId: "80000000-0000-4000-8000-0000000000b1",
        updatedAt: "2026-08-01T20:00:00.000Z",
      },
    ]);
  });
});

describe("useWorkThreadNavigation", () => {
  it("refreshes executing state on a timer and clears it after settlement", async () => {
    let executing = false;
    const bootstrap = vi.fn(async () =>
      decodeWorkThreadBootstrap({
        threads: [workThread()],
        runtime: [{ threadId, executing }],
      }),
    );
    const navigation = vi.fn(async () => ({
      threads: [workThread()],
      runtime: [{ threadId, executing }],
    }));
    const { result, unmount } = renderHook(() =>
      useWorkThreadNavigation({ bootstrap, navigation }, { navigationRefreshMs: 10 }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.navigation[0]?.activity).toBeUndefined();

    executing = true;
    await waitFor(() => expect(result.current.navigation[0]?.activity).toBe("working"));
    expect(navigation.mock.calls.length).toBeGreaterThan(0);
    expect(bootstrap).toHaveBeenCalledTimes(1);

    executing = false;
    await waitFor(() => expect(result.current.navigation[0]?.activity).toBeUndefined());
    unmount();
  });

  it("keeps a fresh runtime sidecar when applyThread updates thread metadata", async () => {
    const bootstrap = vi.fn(async () =>
      decodeWorkThreadBootstrap({
        threads: [workThread()],
        runtime: [{ threadId, executing: true }],
      }),
    );
    const { result } = renderHook(() =>
      useWorkThreadNavigation({ bootstrap, navigation: vi.fn() }, { navigationRefreshMs: 0 }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.navigation[0]?.activity).toBe("working");

    act(() =>
      result.current.applyThread(
        decodeWorkThread({
          id: threadId,
          projectId: "20000000-0000-4000-8000-000000000101",
          title: "Renamed brief",
          lifecycle: "active",
          providerInstanceId: "80000000-0000-4000-8000-0000000000b1",
          modelId: "model-one",
          version: 3,
          createdAt: "2026-08-01T20:00:00.000Z",
          updatedAt: "2026-08-02T20:00:00.000Z",
        }),
      ),
    );

    expect(result.current.navigation[0]).toMatchObject({
      activity: "working",
      title: "Renamed brief",
      updatedAt: "2026-08-02T20:00:00.000Z",
    });
  });

  it("does not re-bootstrap or start navigation polling before the interval elapses", async () => {
    vi.useFakeTimers();
    const bootstrap = vi.fn(async () => decodeWorkThreadBootstrap({ threads: [workThread()] }));
    const navigation = vi.fn(async () => ({ threads: [workThread()], runtime: [] }));
    const { result, unmount } = renderHook(() =>
      useWorkThreadNavigation({ bootstrap, navigation }, { navigationRefreshMs: 1_000 }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("ready");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(navigation).not.toHaveBeenCalled();
    unmount();
    vi.useRealTimers();
  });

  it("drops a navigation response that began before the document became hidden", async () => {
    let resolveNavigation:
      | ((value: { threads: ReadonlyArray<ReturnType<typeof workThread>>; runtime: [] }) => void)
      | undefined;
    const navigation = vi.fn(
      () =>
        new Promise<{ threads: ReadonlyArray<ReturnType<typeof workThread>>; runtime: [] }>(
          (resolve) => {
            resolveNavigation = resolve;
          },
        ),
    );
    const { result, unmount } = renderHook(() =>
      useWorkThreadNavigation(
        {
          bootstrap: async () => decodeWorkThreadBootstrap({ threads: [workThread()] }),
          navigation,
        },
        { navigationRefreshMs: 10 },
      ),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    await waitFor(() => expect(navigation).toHaveBeenCalledTimes(1));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    resolveNavigation?.({
      threads: [decodeWorkThread({ ...workThread(), title: "Stale title" })],
      runtime: [],
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.navigation[0]?.title).toBe("Research brief");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    unmount();
  });

  it("does not let a slower timer read overwrite a newer Machine revision", async () => {
    const timerRead = deferred<{
      readonly threads: ReadonlyArray<ReturnType<typeof workThread>>;
      readonly runtime: [];
    }>();
    const revisionRead = deferred<{
      readonly threads: ReadonlyArray<ReturnType<typeof workThread>>;
      readonly runtime: [];
    }>();
    const navigation = vi
      .fn()
      .mockImplementationOnce(() => timerRead.promise)
      .mockImplementationOnce(() => revisionRead.promise);
    const { result, rerender, unmount } = renderHook(
      ({ changeRevision }) =>
        useWorkThreadNavigation(
          {
            bootstrap: async () => decodeWorkThreadBootstrap({ threads: [workThread()] }),
            navigation,
          },
          { changeRevision, navigationRefreshMs: 10 },
        ),
      { initialProps: { changeRevision: 0 } },
    );
    await waitFor(() => expect(navigation).toHaveBeenCalledOnce());

    rerender({ changeRevision: 1 });
    await waitFor(() => expect(navigation).toHaveBeenCalledTimes(2));
    revisionRead.resolve({
      threads: [
        decodeWorkThread({
          ...workThread(),
          title: "Newest title",
          updatedAt: "2026-08-02T20:00:00.000Z",
        }),
      ],
      runtime: [],
    });
    await waitFor(() => expect(result.current.navigation[0]?.title).toBe("Newest title"));
    timerRead.resolve({
      threads: [
        decodeWorkThread({
          ...workThread(),
          title: "Older title",
          updatedAt: "2026-08-01T20:30:00.000Z",
        }),
      ],
      runtime: [],
    });
    await act(async () => Promise.resolve());

    expect(result.current.navigation[0]?.title).toBe("Newest title");
    unmount();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
