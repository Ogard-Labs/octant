import type {
  CodeThreadId,
  LocalServerCommand,
  LocalServerCommandResult,
  LocalServerListenerId,
  ProjectId,
} from "@octant/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocalServersController } from "./useLocalServersController";

const threadId = "00000000-0000-4000-8000-000000000901" as CodeThreadId;
const projectId = "00000000-0000-4000-8000-000000000902" as ProjectId;
const listenerId = "lsn_0123456789abcdef0123456789abcdef" as LocalServerListenerId;

function listedResult(): LocalServerCommandResult {
  return {
    kind: "local-servers-listed",
    requestId: "00000000-0000-4000-8000-000000000903",
    snapshot: {
      threadId,
      projectId,
      currentCheckout: [],
      other: [],
      observedAt: "2026-08-14T08:00:00.000Z",
    },
  } as unknown as LocalServerCommandResult;
}

function fakeClient(results: ReadonlyArray<LocalServerCommandResult>) {
  const commands: LocalServerCommand[] = [];
  let index = 0;
  return {
    commands,
    client: {
      execute: vi.fn(async (command: LocalServerCommand) => {
        commands.push(command);
        return results[Math.min(index++, results.length - 1)] ?? listedResult();
      }),
    },
  };
}

function options(client: { execute: unknown }, enabled = true) {
  return {
    client: client as never,
    enabled,
    threadId,
    projectId,
    newRequestId: () => "00000000-0000-4000-8000-000000000903",
    refreshIntervalMs: 1_000,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useLocalServersController", () => {
  it("scans as soon as the section is visible", async () => {
    const { client, commands } = fakeClient([listedResult()]);
    const { result } = renderHook(() => useLocalServersController(options(client)));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(commands[0]?.kind).toBe("list-local-servers");
    expect(result.current.snapshot?.currentCheckout).toEqual([]);
  });

  it("never scans while the section is hidden", async () => {
    const { client } = fakeClient([listedResult()]);
    const { result } = renderHook(() => useLocalServersController(options(client, false)));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(client.execute).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
  });

  it("refreshes on an interval while it stays visible", async () => {
    const { client } = fakeClient([listedResult()]);
    renderHook(() => useLocalServersController(options(client)));

    await waitFor(() => expect(client.execute).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(client.execute.mock.calls.length).toBeGreaterThan(1);
  });

  it("returns the prepared open target for a new Browser tab", async () => {
    const target = {
      url: "http://127.0.0.1:5173/",
      allowedOrigin: "http://127.0.0.1:5173",
      acceptsLocalCertificate: false,
    };
    const { client } = fakeClient([
      listedResult(),
      {
        kind: "local-server-open-prepared",
        requestId: "00000000-0000-4000-8000-000000000903",
        listenerId,
        target,
      } as unknown as LocalServerCommandResult,
    ]);
    const { result } = renderHook(() => useLocalServersController(options(client)));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let opened: unknown;
    await act(async () => {
      opened = await result.current.open(listenerId);
    });
    expect(opened).toEqual(target);
  });

  it("adopts the host's post-stop observation instead of re-deriving one", async () => {
    const stopped = {
      kind: "local-server-stopped",
      requestId: "00000000-0000-4000-8000-000000000903",
      listenerId,
      snapshot: {
        threadId,
        projectId,
        currentCheckout: [],
        other: [],
        observedAt: "2026-08-14T08:00:05.000Z",
      },
    } as unknown as LocalServerCommandResult;
    const { client } = fakeClient([listedResult(), stopped]);
    const { result } = renderHook(() => useLocalServersController(options(client)));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      expect(await result.current.stop(listenerId)).toBe(true);
    });
    expect(result.current.snapshot?.observedAt).toBe("2026-08-14T08:00:05.000Z");
  });

  it("keeps a typed refusal so the panel can state it in words", async () => {
    const rejected = {
      kind: "local-server-rejected",
      requestId: "00000000-0000-4000-8000-000000000903",
      failure: {
        category: "confirmation-required",
        message: "Confirm stopping node on port 3000 before Octant signals it.",
      },
    } as unknown as LocalServerCommandResult;
    const { client } = fakeClient([listedResult(), rejected]);
    const { result } = renderHook(() => useLocalServersController(options(client)));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      expect(await result.current.stop(listenerId)).toBe(false);
    });
    expect(result.current.failure?.category).toBe("confirmation-required");

    act(() => result.current.dismissFailure());
    expect(result.current.failure).toBeUndefined();
  });

  it("reports a transport failure as an error rather than an empty host", async () => {
    const client = {
      execute: vi.fn(async () => {
        throw new Error("Local servers are unavailable.");
      }),
    };
    const { result } = renderHook(() => useLocalServersController(options(client)));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.errorMessage).toBe("Local servers are unavailable.");
    expect(result.current.snapshot).toBeUndefined();
  });

  it("keeps a refused listing out of the snapshot so no empty host is shown", async () => {
    const { client } = fakeClient([
      {
        kind: "local-server-rejected",
        requestId: "00000000-0000-4000-8000-000000000903",
        failure: {
          category: "unavailable",
          message: "Octant could not check this computer for local servers.",
        },
      } as unknown as LocalServerCommandResult,
    ]);
    const { result } = renderHook(() => useLocalServersController(options(client)));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.errorMessage).toBe(
      "Octant could not check this computer for local servers.",
    );
    expect(result.current.snapshot).toBeUndefined();
  });
});
