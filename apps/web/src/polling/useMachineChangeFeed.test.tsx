import type { MachineChangeClient } from "@octant/client-runtime/machine-change-client";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  MACHINE_CHANGE_COALESCE_MS,
  useMachineChangeFeed,
  withJitter,
} from "./useMachineChangeFeed";

describe("useMachineChangeFeed", () => {
  it("turns one host invalidation into the matching renderer revisions", async () => {
    const frame = deferred<{
      readonly kind: "changed";
      readonly sequence: 1;
      readonly topics: readonly ["work-navigation", "code-navigation"];
    }>();
    let delivered = false;
    const client: MachineChangeClient = {
      subscribe: async function* () {
        if (delivered) return;
        delivered = true;
        yield await frame.promise;
      },
    };
    const { result } = renderHook(() => useMachineChangeFeed(client));

    act(() =>
      frame.resolve({
        kind: "changed",
        sequence: 1,
        topics: ["work-navigation", "code-navigation"],
      }),
    );

    await waitFor(() => expect(result.current.workNavigation).toBe(1));
    expect(result.current.codeNavigation).toBe(1);
    expect(result.current.chatNavigation).toBe(0);
  });

  it("lets the first notice of a burst through at once and merges the rest into one revision", async () => {
    const frames = Array.from({ length: 8 }, (_, index) => ({
      kind: "changed" as const,
      sequence: index + 1,
      topics: ["chat-navigation" as const],
    }));
    let delivered = false;
    const client: MachineChangeClient = {
      subscribe: async function* () {
        if (delivered) return;
        delivered = true;
        for (const frame of frames) yield frame;
      },
    };
    const { result } = renderHook(() => useMachineChangeFeed(client));

    await waitFor(() => expect(result.current.chatNavigation).toBe(1));
    await new Promise((settle) => setTimeout(settle, MACHINE_CHANGE_COALESCE_MS / 2));
    expect(result.current.chatNavigation).toBe(1);
    await waitFor(() => expect(result.current.chatNavigation).toBe(2));
    await new Promise((settle) => setTimeout(settle, MACHINE_CHANGE_COALESCE_MS * 1.5));
    expect(result.current.chatNavigation).toBe(2);
  });

  it("counts an image job change on its own revision", async () => {
    let delivered = false;
    const client: MachineChangeClient = {
      subscribe: async function* () {
        if (delivered) return;
        delivered = true;
        yield { kind: "changed" as const, sequence: 1, topics: ["image-jobs" as const] };
      },
    };
    const { result } = renderHook(() => useMachineChangeFeed(client));

    await waitFor(() => expect(result.current.imageJobs).toBe(1));
    expect(result.current.chatNavigation).toBe(0);
  });

  it("counts each auxiliary thread topic on its own revision", async () => {
    let delivered = false;
    const client: MachineChangeClient = {
      subscribe: async function* () {
        if (delivered) return;
        delivered = true;
        yield {
          kind: "changed" as const,
          sequence: 1,
          topics: [
            "browser-captures" as const,
            "tool-approvals" as const,
            "thread-follow-ups" as const,
            "thread-message-queue" as const,
          ],
        };
      },
    };
    const { result } = renderHook(() => useMachineChangeFeed(client));

    await waitFor(() => expect(result.current.browserCaptures).toBe(1));
    expect(result.current.toolApprovals).toBe(1);
    expect(result.current.threadFollowUps).toBe(1);
    expect(result.current.threadMessageQueue).toBe(1);
    expect(result.current.chatNavigation).toBe(0);
  });

  it("reconnects with the epoch and sequence of the last frame it read", async () => {
    const cursors: Array<readonly [number, string | undefined]> = [];
    const client: MachineChangeClient = {
      subscribe: async function* (afterSequence, _signal, epoch) {
        cursors.push([afterSequence, epoch]);
        if (cursors.length === 1) {
          yield { kind: "changed" as const, sequence: 4, topics: ["projects"], epoch: "process-a" };
        }
      },
    };
    const { result } = renderHook(() => useMachineChangeFeed(client));

    await waitFor(() => expect(cursors.length).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
    expect(result.current.projects).toBe(1);
    expect(cursors.slice(0, 2)).toEqual([
      [0, undefined],
      [4, "process-a"],
    ]);
  });

  it("spreads retry delays between half and all of the backoff", () => {
    expect(withJitter(2_000, () => 0)).toBe(1_000);
    expect(withJitter(2_000, () => 0.999_9)).toBe(2_000);
    expect(withJitter(250, () => 0.5)).toBe(188);
  });

  it("bumps every revision, including the auxiliary topics, when the feed requires a snapshot", async () => {
    let delivered = false;
    const client: MachineChangeClient = {
      subscribe: async function* () {
        if (delivered) return;
        delivered = true;
        yield { kind: "snapshot-required" as const, sequence: 0 };
      },
    };
    const { result } = renderHook(() => useMachineChangeFeed(client));

    await waitFor(() => expect(result.current.browserCaptures).toBe(1));
    expect(result.current.toolApprovals).toBe(1);
    expect(result.current.threadFollowUps).toBe(1);
    expect(result.current.threadMessageQueue).toBe(1);
    expect(result.current.chatNavigation).toBe(1);
    expect(result.current.imageJobs).toBe(1);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
