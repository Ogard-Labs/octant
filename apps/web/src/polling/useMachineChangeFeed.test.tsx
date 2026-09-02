import type { MachineChangeClient } from "@octant/client-runtime/machine-change-client";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useMachineChangeFeed } from "./useMachineChangeFeed";

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
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
