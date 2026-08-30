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
    const { result, unmount } = renderHook(() =>
      useWorkThreadNavigation({ bootstrap }, { navigationRefreshMs: 10 }),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.navigation[0]?.activity).toBeUndefined();

    executing = true;
    await waitFor(() => expect(result.current.navigation[0]?.activity).toBe("working"));
    expect(bootstrap.mock.calls.length).toBeGreaterThan(1);

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
      useWorkThreadNavigation({ bootstrap }, { navigationRefreshMs: 0 }),
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
});
