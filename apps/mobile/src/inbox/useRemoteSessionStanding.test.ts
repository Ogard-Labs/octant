// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRemoteSessionStanding } from "./useRemoteSessionStanding";

const { appStateListeners, appState } = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  return {
    appStateListeners: listeners,
    appState: {
      currentState: "active",
      addEventListener: (_type: string, listener: (state: string) => void) => {
        listeners.add(listener);
        return {
          remove: () => {
            listeners.delete(listener);
          },
        };
      },
    },
  };
});

vi.mock("react-native", () => ({ AppState: appState }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];
const containers: HTMLElement[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
  appStateListeners.clear();
  appState.currentState = "active";
  vi.useRealTimers();
});

const device = {
  deviceId: "22222222-2222-4222-8222-222222222222",
  deviceLabel: "Ada's phone",
  origin: "https://mac.example.test",
  credentialGeneration: 1,
  createdAt: "2026-08-03T00:00:00.000Z",
  expiresAt: "2026-09-03T00:00:00.000Z",
  lastSeenAt: "2026-08-03T07:00:00.000Z",
  state: "active",
};

function transport(answering: () => Response) {
  const authenticatedFetch = vi.fn(async (): Promise<Response> => answering());
  return {
    transport: { authenticatedFetch },
    authenticatedFetch,
  };
}

const RESTRICTED = { actsAsHostPerson: false, accessLevel: "read-only" };

/** A host whose answers are given one by one. */
function heldTransport() {
  const reads: Array<{
    readonly resolve: (response: Response) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  const read = (index: number) => {
    const held = reads[index];
    if (held === undefined) throw new Error(`Read ${index} was never asked`);
    return held;
  };
  return {
    reads,
    transport: {
      authenticatedFetch: () =>
        new Promise<Response>((resolve, reject) => {
          reads.push({ resolve, reject });
        }),
    },
    answer: (index: number, standing: Record<string, unknown>) =>
      act(async () => read(index).resolve(Response.json({ ...device, ...standing }))),
    fail: (index: number) => act(async () => read(index).reject(new Error("host unreachable"))),
  };
}

function render(initial: Parameters<typeof useRemoteSessionStanding>[0], offlineDemo = false) {
  const seen: string[] = [];
  const Harness = ({ transport }: { readonly transport: typeof initial }) => {
    const standing = useRemoteSessionStanding(transport, offlineDemo);
    seen.push(JSON.stringify(standing));
    return createElement("output", null, JSON.stringify(standing));
  };
  const container = document.createElement("section");
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  return {
    seen,
    output: () => container.querySelector("output")?.textContent ?? "",
    flush: async () => {
      await act(async () => {});
    },
    mount: async () => {
      await act(async () => {
        root.render(createElement(Harness, { transport: initial }));
      });
    },
    select: async (transport: typeof initial) => {
      await act(async () => {
        root.render(createElement(Harness, { transport }));
      });
    },
    unmount: () => act(() => root.unmount()),
  };
}

const emit = (state: string) => {
  appState.currentState = state;
  for (const listener of [...appStateListeners]) listener(state);
};

describe("useRemoteSessionStanding", () => {
  it("picks up access changes while the same computer stays selected and the app is active", async () => {
    vi.useFakeTimers();
    let accessLevel = "read-only";
    const { transport: session, authenticatedFetch } = transport(() =>
      Response.json({ ...device, actsAsHostPerson: false, accessLevel }),
    );
    const harness = render(session);
    await harness.mount();
    expect(JSON.parse(harness.output()).accessLevel).toBe("read-only");

    accessLevel = "approve-and-steer";
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(JSON.parse(harness.output()).accessLevel).toBe("approve-and-steer");

    accessLevel = "read-only";
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(JSON.parse(harness.output()).accessLevel).toBe("read-only");

    await act(async () => {
      emit("background");
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(authenticatedFetch).toHaveBeenCalledTimes(3);
  });

  it("rereads the device's standing when the app returns to the foreground", async () => {
    const { transport: session, authenticatedFetch } = transport(
      () => new Response(JSON.stringify({ ...device, actsAsHostPerson: true }), { status: 200 }),
    );
    const harness = render(session);
    await harness.mount();
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      emit("background");
      emit("active");
    });
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    expect(harness.output()).toBe(JSON.stringify({ actsAsHostPerson: true }));
  });

  it("does not reread while the app leaves or stays out of the foreground", async () => {
    const { transport: session, authenticatedFetch } = transport(
      () => new Response(JSON.stringify({ ...device, actsAsHostPerson: false }), { status: 200 }),
    );
    const harness = render(session);
    await harness.mount();
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      emit("active");
      emit("background");
      emit("background");
    });
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });

  it("rereads once, after the running read settles, when the app wakes while it runs", async () => {
    vi.useFakeTimers();
    const session = heldTransport();
    const harness = render(session.transport);
    await harness.mount();
    expect(session.reads).toHaveLength(1);
    await act(async () => {
      for (let wakes = 0; wakes < 3; wakes += 1) {
        emit("background");
        emit("active");
      }
    });
    // One read at a time, however often the phone wakes.
    expect(session.reads).toHaveLength(1);
    expect(JSON.parse(harness.output())).toEqual(RESTRICTED);

    await session.answer(0, { actsAsHostPerson: true });
    expect(session.reads).toHaveLength(2);
    await session.answer(1, { actsAsHostPerson: false, accessLevel: "read-only" });
    expect(JSON.parse(harness.output())).toEqual(RESTRICTED);
    expect(session.reads).toHaveLength(2);
  });

  it("rereads once after a read that outlasts the timer, also when that read fails", async () => {
    vi.useFakeTimers();
    const session = heldTransport();
    const harness = render(session.transport);
    await harness.mount();
    await act(async () => vi.advanceTimersByTimeAsync(25_000));
    expect(session.reads).toHaveLength(1);
    await session.fail(0);
    expect(JSON.parse(harness.output())).toEqual(RESTRICTED);
    expect(session.reads).toHaveLength(2);
    await session.answer(1, { actsAsHostPerson: true });
    expect(JSON.parse(harness.output())).toEqual({ actsAsHostPerson: true });
    expect(session.reads).toHaveLength(2);
  });

  it("drops the owed reread when the app is in the background once the read settles", async () => {
    vi.useFakeTimers();
    const session = heldTransport();
    const harness = render(session.transport);
    await harness.mount();
    await act(async () => {
      emit("background");
      emit("active");
      emit("background");
    });
    await session.answer(0, { actsAsHostPerson: false, accessLevel: "read-only" });
    expect(session.reads).toHaveLength(1);
    // Coming back reads anyway.
    await act(async () => emit("active"));
    expect(session.reads).toHaveLength(2);
  });

  it("drops the owed reread when the screen closes or another computer is selected", async () => {
    vi.useFakeTimers();
    const first = heldTransport();
    const second = heldTransport();
    const harness = render(first.transport);
    await harness.mount();
    await act(async () => {
      emit("background");
      emit("active");
    });
    await harness.select(second.transport);
    expect(JSON.parse(harness.output())).toEqual(RESTRICTED);
    await first.answer(0, { actsAsHostPerson: true });
    expect(first.reads).toHaveLength(1);
    expect(second.reads).toHaveLength(1);
    expect(JSON.parse(harness.output())).toEqual(RESTRICTED);

    await act(async () => {
      emit("background");
      emit("active");
    });
    harness.unmount();
    await second.answer(0, { actsAsHostPerson: true });
    expect(second.reads).toHaveLength(1);
  });

  it("stays restricted without a transport and asks nothing", async () => {
    const harness = render(undefined);
    await harness.mount();
    await act(async () => {
      emit("background");
      emit("active");
    });
    expect(appStateListeners.size).toBe(0);
    expect(harness.output()).toBe(
      JSON.stringify({ actsAsHostPerson: false, accessLevel: "read-only" }),
    );
  });

  it("stands as the person in the offline demo, asking nothing", async () => {
    const harness = render(undefined, true);
    await harness.mount();
    await act(async () => {
      emit("background");
      emit("active");
    });
    // No host exists to ask; the sample session acts as the person.
    expect(appStateListeners.size).toBe(0);
    expect(harness.output()).toBe(JSON.stringify({ actsAsHostPerson: true }));
  });

  it("falls back to read-only reach when a standing reread fails on wake", async () => {
    let paused = false;
    const { transport: session } = transport(() =>
      paused
        ? new Response("{}", { status: 403 })
        : new Response(JSON.stringify({ ...device, actsAsHostPerson: true }), { status: 200 }),
    );
    const harness = render(session);
    await harness.mount();
    expect(harness.output()).toBe(JSON.stringify({ actsAsHostPerson: true }));

    paused = true;
    await act(async () => {
      emit("background");
      emit("active");
    });
    // A pause refuses the read; the session keeps nothing editable.
    expect(harness.output()).toBe(
      JSON.stringify({ actsAsHostPerson: false, accessLevel: "read-only" }),
    );
  });
});
