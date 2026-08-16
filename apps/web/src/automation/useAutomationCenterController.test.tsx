import { AutomationClientFailure, type AutomationClient } from "@octant/client-runtime";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AUTOMATION_UI_TEST_IDS,
  automationDefinitionFixture,
  automationRunFixture,
  automationSummaryFixture,
} from "./automationTestFixtures";
import { useAutomationCenterController } from "./useAutomationCenterController";

const definition = automationDefinitionFixture();
const summary = automationSummaryFixture();
const run = automationRunFixture(definition, { lifecycle: "completed" });

function fakeClient(overrides: Partial<AutomationClient> = {}): AutomationClient {
  return {
    list: vi.fn(async () => ({ kind: "automation-list" as const, items: [summary] })),
    get: vi.fn(async () => ({
      kind: "automation-detail" as const,
      automation: definition,
      runs: [run],
    })),
    history: vi.fn(async () => ({
      kind: "automation-history" as const,
      automationId: definition.id,
      runs: [run],
    })),
    execute: vi.fn(async () => ({ kind: "automation-paused" as const, automation: definition })),
    ...overrides,
  } as AutomationClient;
}

describe("useAutomationCenterController", () => {
  it("loads the automation list on mount and re-queries when filters change", async () => {
    const client = fakeClient();
    const { result } = renderHook(() => useAutomationCenterController({ client }));

    expect(result.current.list.status).toBe("loading");
    await waitFor(() => expect(result.current.list.status).toBe("ready"));
    expect(client.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "all" }),
      expect.anything(),
    );

    act(() => result.current.setFilter("work"));
    await waitFor(() =>
      expect(client.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ mode: "work" }),
        expect.anything(),
      ),
    );

    act(() => result.current.setSearch("weekly"));
    await waitFor(() =>
      expect(client.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ mode: "work", search: "weekly" }),
        expect.anything(),
      ),
    );
  });

  it("names an unavailable list and recovers through retry", async () => {
    let fail = true;
    const client = fakeClient({
      list: vi.fn(async () => {
        if (fail) throw new AutomationClientFailure("network", "The host is unreachable.");
        return { kind: "automation-list" as const, items: [summary] };
      }),
    });
    const { result } = renderHook(() => useAutomationCenterController({ client }));

    await waitFor(() => expect(result.current.list.status).toBe("unavailable"));
    if (result.current.list.status !== "unavailable") return;
    expect(result.current.list.message).toBe("The host is unreachable.");

    fail = false;
    act(() => result.current.retryList());
    await waitFor(() => expect(result.current.list.status).toBe("ready"));
  });

  it("loads detail for the selected automation and recovers from a failed load", async () => {
    let fail = true;
    const client = fakeClient({
      get: vi.fn(async () => {
        if (fail) throw new AutomationClientFailure("http", "Automation is unavailable.", 404);
        return { kind: "automation-detail" as const, automation: definition, runs: [run] };
      }),
    });
    const { result } = renderHook(() => useAutomationCenterController({ client }));
    await waitFor(() => expect(result.current.list.status).toBe("ready"));

    act(() => result.current.select(String(definition.id)));
    await waitFor(() => expect(result.current.detail.status).toBe("unavailable"));

    fail = false;
    act(() => result.current.retryDetail());
    await waitFor(() => expect(result.current.detail.status).toBe("ready"));
    if (result.current.detail.status !== "ready") return;
    expect(result.current.detail.automation.id).toBe(definition.id);
    expect(result.current.detail.runs).toHaveLength(1);

    act(() => result.current.select(undefined));
    expect(result.current.detail.status).toBe("idle");
  });

  it("expands bounded history lazily and appends pages through the opaque cursor", async () => {
    const olderRun = automationRunFixture(definition, {
      id: AUTOMATION_UI_TEST_IDS.otherRun,
      lifecycle: "completed",
    });
    const history = vi.fn(async (input: { cursor?: string }) =>
      input.cursor === undefined
        ? {
            kind: "automation-history" as const,
            automationId: definition.id,
            runs: [run],
            nextCursor: "cursor-1",
          }
        : {
            kind: "automation-history" as const,
            automationId: definition.id,
            runs: [olderRun],
          },
    );
    const client = fakeClient({ history: history as never });
    const { result } = renderHook(() => useAutomationCenterController({ client }));
    await waitFor(() => expect(result.current.list.status).toBe("ready"));
    act(() => result.current.select(String(definition.id)));
    await waitFor(() => expect(result.current.detail.status).toBe("ready"));

    expect(result.current.history.status).toBe("collapsed");
    await act(() => result.current.expandHistory());
    await waitFor(() => expect(result.current.history.status).toBe("ready"));
    if (result.current.history.status !== "ready") return;
    expect(result.current.history.runs).toHaveLength(1);
    expect(result.current.history.nextCursor).toBe("cursor-1");

    await act(() => result.current.loadMoreHistory());
    await waitFor(() => {
      if (result.current.history.status !== "ready") throw new Error("history not ready");
      expect(result.current.history.runs).toHaveLength(2);
    });
    if (result.current.history.status !== "ready") return;
    expect(result.current.history.nextCursor).toBeUndefined();
  });

  it("executes a command, reports the named notice, and refreshes list and detail", async () => {
    const client = fakeClient();
    const { result } = renderHook(() => useAutomationCenterController({ client }));
    await waitFor(() => expect(result.current.list.status).toBe("ready"));
    act(() => result.current.select(String(definition.id)));
    await waitFor(() => expect(result.current.detail.status).toBe("ready"));
    const listCalls = (client.list as ReturnType<typeof vi.fn>).mock.calls.length;
    const getCalls = (client.get as ReturnType<typeof vi.fn>).mock.calls.length;

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.execute(
        {
          kind: "pause-automation",
          automationId: definition.id,
          expectedVersion: definition.version,
        },
        "Automation paused.",
      );
    });
    expect((outcome as { kind: string }).kind).toBe("automation-paused");
    expect(result.current.notice).toBe("Automation paused.");
    await waitFor(() => {
      expect((client.list as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
        listCalls,
      );
      expect((client.get as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(getCalls);
    });
  });

  it("surfaces typed command failures and active-run conflicts without refreshing", async () => {
    const client = fakeClient({
      execute: vi.fn(async () => ({
        kind: "automation-command-failed" as const,
        reason: "stale-version" as const,
        message: "The automation changed. Reload before editing.",
      })),
    });
    const { result } = renderHook(() => useAutomationCenterController({ client }));
    await waitFor(() => expect(result.current.list.status).toBe("ready"));

    await act(async () => {
      await result.current.execute({
        kind: "pause-automation",
        automationId: definition.id,
        expectedVersion: definition.version,
      });
    });
    expect(result.current.notice).toBe("The automation changed. Reload before editing.");

    (client.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      kind: "automation-run-active-conflict",
      automationId: definition.id,
      runId: run.id,
      lifecycle: "running",
    });
    await act(async () => {
      await result.current.execute({
        kind: "run-now-automation",
        automationId: definition.id,
        expectedVersion: definition.version,
        runNowRequestId: AUTOMATION_UI_TEST_IDS.runNowRequest,
      } as never);
    });
    expect(result.current.notice).toBe(
      "This automation already has an active run. Wait for it to finish or cancel it first.",
    );
  });

  it("reports a transport failure as a named notice instead of throwing", async () => {
    const client = fakeClient({
      execute: vi.fn(async () => {
        throw new AutomationClientFailure("network", "The host is unreachable.");
      }),
    });
    const { result } = renderHook(() => useAutomationCenterController({ client }));
    await waitFor(() => expect(result.current.list.status).toBe("ready"));

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.execute({
        kind: "pause-automation",
        automationId: definition.id,
        expectedVersion: definition.version,
      });
    });
    expect((outcome as { kind: string }).kind).toBe("automation-transport-failed");
    expect(result.current.notice).toBe("The host is unreachable.");
  });

  it("aborts the in-flight list request on unmount", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const client = fakeClient({
      list: vi.fn((_input: unknown, signal?: AbortSignal) => {
        signals.push(signal);
        return new Promise(() => {});
      }) as never,
    });
    const { unmount } = renderHook(() => useAutomationCenterController({ client }));
    unmount();
    expect(signals[0]?.aborted).toBe(true);
  });
});
