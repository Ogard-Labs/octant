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
  for (const root of roots.splice(0)) root.unmount();
  for (const container of containers.splice(0)) container.remove();
  appStateListeners.clear();
  appState.currentState = "active";
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

function render(transport: Parameters<typeof useRemoteSessionStanding>[0], offlineDemo = false) {
  const seen: string[] = [];
  const Harness = () => {
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
        root.render(createElement(Harness));
      });
    },
  };
}

const emit = (state: string) => {
  appState.currentState = state;
  for (const listener of [...appStateListeners]) listener(state);
};

describe("useRemoteSessionStanding", () => {
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
