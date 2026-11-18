import { act, cleanup, renderHook } from "@testing-library/react";
import type { SandboxRestrictionsClient } from "@octant/client-runtime/sandbox-restrictions-client";
import {
  decodeSandboxRestrictionsSnapshot,
  type SandboxRestrictionsScope,
  type SandboxRestrictionsSnapshot,
} from "@octant/contracts/sandbox-policy";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  publishSandboxRestrictionsSnapshot,
  useSandboxRestrictionsSnapshot,
} from "./useSandboxRestrictionsSnapshot";

const code = { kind: "settings", mode: "code" } as const;
const work = { kind: "settings", mode: "work" } as const;

function snapshot(scope: SandboxRestrictionsScope, version: number) {
  return decodeSandboxRestrictionsSnapshot({
    kind: "sandbox-restrictions",
    scope,
    version,
    source: "settings",
    inherited: false,
    running: false,
    summary: "Sandbox restrictions",
    limitations: [],
    denials: [],
    capabilities: {
      folders: true,
      protectedPaths: true,
      isolatedCredentials: true,
      blockedHostServices: true,
    },
  });
}

const clientWith = (settings: SandboxRestrictionsClient["settings"]) => ({
  settings: vi.fn(settings),
  change: vi.fn<SandboxRestrictionsClient["change"]>(),
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("shares a single read across consumers and pauses polling while hidden", async () => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const client = clientWith(async (scope) => snapshot(scope, 1));
  const first = renderHook(() => useSandboxRestrictionsSnapshot(client, { ...code }));
  const second = renderHook(() => useSandboxRestrictionsSnapshot(client, { ...code }));

  await act(() => vi.advanceTimersByTimeAsync(9000));
  expect(client.settings).not.toHaveBeenCalled();
  await act(async () => {
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(client.settings).toHaveBeenCalledOnce();
  expect(first.result.current.snapshot).toBe(second.result.current.snapshot);
  first.unmount();
  await act(() => vi.advanceTimersByTimeAsync(3000));
  expect(client.settings).toHaveBeenCalledTimes(2);
  second.unmount();
  await act(() => vi.advanceTimersByTimeAsync(9000));
  expect(client.settings).toHaveBeenCalledTimes(2);
});

it("publishes a successful change without letting an older read overwrite it", async () => {
  const pending = Promise.withResolvers<SandboxRestrictionsSnapshot>();
  const client = clientWith(() => pending.promise);
  const read = renderHook(() => useSandboxRestrictionsSnapshot(client, code));
  await act(() => vi.advanceTimersByTimeAsync(9000));
  expect(client.settings).toHaveBeenCalledOnce();
  act(() => publishSandboxRestrictionsSnapshot(client, snapshot(code, 2)));
  expect(read.result.current.snapshot?.version).toBe(2);
  await act(async () => pending.resolve(snapshot(code, 1)));
  expect(read.result.current.snapshot?.version).toBe(2);
});

it("drops a retired scope's results and waits for its aborted read before reusing it", async () => {
  const before = Promise.withResolvers<SandboxRestrictionsSnapshot>();
  const after = Promise.withResolvers<SandboxRestrictionsSnapshot>();
  const client = clientWith(async () => {
    throw new Error("Unexpected read.");
  });
  client.settings
    .mockReturnValueOnce(before.promise)
    .mockResolvedValueOnce(snapshot(work, 4))
    .mockReturnValueOnce(after.promise);
  const read = renderHook<
    ReturnType<typeof useSandboxRestrictionsSnapshot>,
    { scope: SandboxRestrictionsScope }
  >(
    ({ scope }: { readonly scope: SandboxRestrictionsScope }) =>
      useSandboxRestrictionsSnapshot(client, scope),
    { initialProps: { scope: code } },
  );
  const oldRead = client.settings.mock.calls[0]?.[1];
  read.rerender({ scope: work });
  await act(async () => {});
  expect(oldRead?.aborted).toBe(true);
  expect(read.result.current.snapshot?.scope).toEqual(work);

  read.rerender({ scope: code });
  expect(read.result.current.snapshot).toBeUndefined();
  expect(client.settings).toHaveBeenCalledTimes(2);
  await act(async () => before.resolve(snapshot(code, 1)));
  expect(client.settings).toHaveBeenCalledTimes(3);
  expect(read.result.current.snapshot).toBeUndefined();
  await act(async () => after.resolve(snapshot(code, 5)));
  expect(read.result.current.snapshot?.version).toBe(5);
});
