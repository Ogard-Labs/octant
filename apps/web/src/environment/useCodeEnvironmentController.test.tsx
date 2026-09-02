import type { ProjectClient } from "@octant/client-runtime/project-client";
import {
  decodeCodeThreadId,
  decodeProjectId,
  type CodeEnvironmentObservation,
  type ProjectId,
  type ProjectSummary,
} from "@octant/contracts";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCodeEnvironmentController } from "./useCodeEnvironmentController";

const codeId = decodeProjectId("00000000-0000-4000-8000-000000000901");
const threadId = decodeCodeThreadId("00000000-0000-4000-8000-000000000905");
const otherCodeId = decodeProjectId("00000000-0000-4000-8000-000000000902");
const chatId = decodeProjectId("00000000-0000-4000-8000-000000000903");
const workId = decodeProjectId("00000000-0000-4000-8000-000000000904");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, reject, resolve };
}

function project(id: ProjectId, type: ProjectSummary["type"]): ProjectSummary {
  const common = {
    id,
    type,
    name: type === "chat" ? "Research" : "Octant",
    lifecycle: "active" as const,
    pinned: type === "code",
    rank: "0/1" as ProjectSummary["rank"],
    version: 1 as ProjectSummary["version"],
    createdAt: "2026-07-16T08:00:00.000Z" as ProjectSummary["createdAt"],
    updatedAt: "2026-07-16T08:00:00.000Z" as ProjectSummary["updatedAt"],
  };
  if (type === "chat") return common as ProjectSummary;
  return {
    ...common,
    binding: { canonicalRoot: "/Users/example/Dev/Repos/octant" },
    ...(type === "code" ? { codeAccessPersistence: "current-session" as const } : {}),
  } as ProjectSummary;
}

function observation(
  projectId: ProjectId,
  overrides: Partial<Extract<CodeEnvironmentObservation, { status: "ready" }>> = {},
): CodeEnvironmentObservation {
  const base = {
    projectId,
    projectName: projectId === otherCodeId ? "Other" : "Octant",
    observedAt: "2026-07-16T09:00:00.000Z" as CodeEnvironmentObservation["observedAt"],
  };
  return {
    ...base,
    status: "ready",
    repositoryRoot: "/Users/example/Dev/Repos/octant",
    worktreeRoot: "/Users/example/Dev/Repos/octant",
    branch: { kind: "named", name: "feature/issue-52" },
    changes: "clean",
    ...overrides,
  };
}

function failureObservation(status: "unavailable" | "failed"): CodeEnvironmentObservation {
  return {
    status,
    projectId: codeId,
    projectName: "Octant",
    observedAt: "2026-07-16T09:00:00.000Z" as CodeEnvironmentObservation["observedAt"],
    reason: status === "unavailable" ? "Root missing." : "Git inspection failed.",
  };
}

function client(environment = vi.fn<ProjectClient["environment"]>()): ProjectClient {
  const environmentForThread = vi.fn<NonNullable<ProjectClient["environmentForThread"]>>();
  environmentForThread.mockImplementation((projectId, _threadId, signal) =>
    environment(projectId, signal),
  );
  return {
    bootstrap: vi.fn(),
    search: vi.fn(),
    executeProject: vi.fn(),
    memory: vi.fn(),
    environment,
    environmentForThread,
    executeMemory: vi.fn(),
  };
}

describe("useCodeEnvironmentController", () => {
  it("stays idle without requesting for disabled, absent, Chat, or Work Projects", () => {
    const api = client();
    const { result, rerender } = renderHook(
      ({
        activeProject,
        enabled,
      }: {
        activeProject: ProjectSummary | undefined;
        enabled: boolean;
      }) => useCodeEnvironmentController({ client: api, project: activeProject, enabled }),
      {
        initialProps: {
          activeProject: project(codeId, "code") as ProjectSummary | undefined,
          enabled: false,
        },
      },
    );

    expect(result.current.status).toBe("idle");
    rerender({ activeProject: undefined, enabled: true });
    expect(result.current.status).toBe("idle");
    rerender({ activeProject: project(chatId, "chat"), enabled: true });
    expect(result.current.status).toBe("idle");
    rerender({ activeProject: project(workId, "work"), enabled: true });
    expect(result.current.status).toBe("idle");
    expect(api.environment).not.toHaveBeenCalled();
  });

  it("loads when opened for Code and becomes ready", async () => {
    const request = deferred<CodeEnvironmentObservation>();
    const api = client(vi.fn(() => request.promise));
    const codeProject = project(codeId, "code");
    const ready = observation(codeId);
    const { result } = renderHook(() =>
      useCodeEnvironmentController({
        client: api,
        project: codeProject,
        threadId,
        enabled: true,
      }),
    );

    expect(result.current).toMatchObject({ status: "loading", observation: undefined });
    expect(api.environmentForThread).toHaveBeenCalledWith(
      codeId,
      threadId,
      expect.any(AbortSignal),
    );
    await act(async () => request.resolve(ready));
    expect(result.current).toMatchObject({ status: "ready", observation: ready });
  });

  it("suppresses an old Project response and loads the new Project", async () => {
    const first = deferred<CodeEnvironmentObservation>();
    const second = deferred<CodeEnvironmentObservation>();
    const environment = vi
      .fn<ProjectClient["environment"]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const api = client(environment);
    const { result, rerender } = renderHook(
      ({ activeProject }) =>
        useCodeEnvironmentController({
          client: api,
          project: activeProject,
          threadId,
          enabled: true,
        }),
      { initialProps: { activeProject: project(codeId, "code") } },
    );

    rerender({ activeProject: project(otherCodeId, "code") });
    expect(api.environmentForThread).toHaveBeenLastCalledWith(
      otherCodeId,
      threadId,
      expect.any(AbortSignal),
    );
    await act(async () => first.resolve(observation(codeId)));
    expect(result.current).toMatchObject({ status: "loading", observation: undefined });
    const newest = observation(otherCodeId);
    await act(async () => second.resolve(newest));
    expect(result.current).toMatchObject({ status: "ready", observation: newest });
  });

  it("invalidates an in-flight request and clears state when closed", async () => {
    const request = deferred<CodeEnvironmentObservation>();
    const api = client(vi.fn(() => request.promise));
    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useCodeEnvironmentController({ client: api, project: project(codeId, "code"), enabled }),
      { initialProps: { enabled: true } },
    );

    rerender({ enabled: false });
    expect(result.current).toMatchObject({
      status: "idle",
      observation: undefined,
      errorMessage: undefined,
    });
    await act(async () => request.resolve(observation(codeId)));
    expect(result.current).toMatchObject({ status: "idle", observation: undefined });
  });

  it("exposes a redacted transport error and retries", async () => {
    const retry = deferred<CodeEnvironmentObservation>();
    const environment = vi
      .fn<ProjectClient["environment"]>()
      .mockRejectedValueOnce(new Error("Project service unavailable."))
      .mockReturnValueOnce(retry.promise);
    const api = client(environment);
    const { result } = renderHook(() =>
      useCodeEnvironmentController({
        client: api,
        project: project(codeId, "code"),
        enabled: true,
      }),
    );

    await act(async () => {});
    expect(result.current).toMatchObject({
      status: "error",
      observation: undefined,
      errorMessage: "Project service unavailable.",
    });
    let retryPromise!: Promise<void>;
    act(() => {
      retryPromise = result.current.retry();
    });
    expect(result.current).toMatchObject({ status: "loading", errorMessage: undefined });
    await act(async () => retry.resolve(observation(codeId)));
    await retryPromise;
    expect(result.current.status).toBe("ready");
  });

  it.each(["unavailable", "failed"] as const)(
    "keeps a %s observation as a successful normalized payload",
    async (status) => {
      const normalized = failureObservation(status);
      const api = client(vi.fn(async () => normalized));
      const { result } = renderHook(() =>
        useCodeEnvironmentController({
          client: api,
          project: project(codeId, "code"),
          enabled: true,
        }),
      );

      await act(async () => {});
      expect(result.current).toMatchObject({ status: "ready", observation: normalized });
    },
  );

  it("refreshes without exposing the previous observation", async () => {
    const initial = observation(codeId);
    const refresh = deferred<CodeEnvironmentObservation>();
    const environment = vi
      .fn<ProjectClient["environment"]>()
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(refresh.promise);
    const api = client(environment);
    const { result } = renderHook(() =>
      useCodeEnvironmentController({
        client: api,
        project: project(codeId, "code"),
        enabled: true,
      }),
    );
    await act(async () => {});
    expect(result.current.observation).toBe(initial);

    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = result.current.refresh();
    });
    expect(result.current).toMatchObject({ status: "loading", observation: undefined });
    const updated = observation(codeId, { changes: "dirty" });
    await act(async () => refresh.resolve(updated));
    await refreshPromise;
    expect(result.current).toMatchObject({ status: "ready", observation: updated });
    expect(environment).toHaveBeenNthCalledWith(2, codeId, expect.any(AbortSignal), true);
  });

  it("aborts the superseded request during rapid refresh", async () => {
    const first = deferred<CodeEnvironmentObservation>();
    const second = deferred<CodeEnvironmentObservation>();
    const signals: AbortSignal[] = [];
    const environment = vi
      .fn<ProjectClient["environment"]>()
      .mockImplementationOnce((_projectId, signal) => {
        if (signal !== undefined) signals.push(signal);
        return first.promise;
      })
      .mockImplementationOnce((_projectId, signal) => {
        if (signal !== undefined) signals.push(signal);
        return second.promise;
      });
    const api = client(environment);
    const { result } = renderHook(() =>
      useCodeEnvironmentController({
        client: api,
        project: project(codeId, "code"),
        enabled: true,
      }),
    );

    act(() => void result.current.refresh());

    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    await act(async () => second.resolve(observation(codeId, { changes: "dirty" })));
    expect(result.current).toMatchObject({ status: "ready" });
  });

  it("does not abort a slow environment request when the polling interval elapses", async () => {
    vi.useFakeTimers();
    try {
      const request = deferred<CodeEnvironmentObservation>();
      const signals: AbortSignal[] = [];
      const environment = vi.fn<ProjectClient["environment"]>((_projectId, signal) => {
        if (signal !== undefined) signals.push(signal);
        return request.promise;
      });
      const api = client(environment);
      const { result } = renderHook(() =>
        useCodeEnvironmentController({
          client: api,
          project: project(codeId, "code"),
          threadId,
          enabled: true,
        }),
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });

      expect(api.environmentForThread).toHaveBeenCalledTimes(1);
      expect(signals[0]?.aborted).toBe(false);

      const ready = observation(codeId);
      await act(async () => request.resolve(ready));
      expect(result.current).toMatchObject({ status: "ready", observation: ready });
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the active request when the inspector closes", () => {
    const request = deferred<CodeEnvironmentObservation>();
    let signal: AbortSignal | undefined;
    const api = client(
      vi.fn((_projectId, requestSignal) => {
        signal = requestSignal;
        return request.promise;
      }),
    );
    const { rerender } = renderHook(
      ({ enabled }) =>
        useCodeEnvironmentController({ client: api, project: project(codeId, "code"), enabled }),
      { initialProps: { enabled: true } },
    );

    rerender({ enabled: false });

    expect(signal?.aborted).toBe(true);
  });

  it("aborts the active request when unmounted", () => {
    const request = deferred<CodeEnvironmentObservation>();
    let signal: AbortSignal | undefined;
    const api = client(
      vi.fn((_projectId, requestSignal) => {
        signal = requestSignal;
        return request.promise;
      }),
    );
    const { unmount } = renderHook(() =>
      useCodeEnvironmentController({
        client: api,
        project: project(codeId, "code"),
        enabled: true,
      }),
    );

    unmount();

    expect(signal?.aborted).toBe(true);
  });

  it("does not spawn periodic Git observations while the thread remains open", async () => {
    vi.useFakeTimers();
    try {
      const api = client(
        vi.fn<ProjectClient["environment"]>().mockResolvedValue(observation(codeId)),
      );
      renderHook(() =>
        useCodeEnvironmentController({
          client: api,
          project: project(codeId, "code"),
          threadId,
          enabled: true,
        }),
      );

      await act(async () => {});
      expect(api.environmentForThread).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(api.environmentForThread).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
