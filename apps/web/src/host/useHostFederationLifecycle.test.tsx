import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeHostId } from "@octant/contracts/host";
import { createClientHostRegistry } from "@octant/client-runtime/host-federation-registry";
import type { PairedComputersBridge } from "../shell/hostBridge";
import { createBrowserHostRegistryStorage } from "./browserHostRegistryStorage";
import { useHostFederationLifecycle } from "./useHostFederationLifecycle";

const HOST = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "https://100.101.102.103:8443";

afterEach(() => {
  localStorage.clear();
});

async function pairedHostRecord(keyId: string) {
  await createClientHostRegistry(createBrowserHostRegistryStorage()).upsertRemote({
    hostId: decodeHostId(HOST),
    kind: "remote",
    displayName: "Studio Mac",
    origin: ORIGIN,
    enabled: true,
    credential: {
      keyId,
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
      deviceId: "device-1",
      listenerTrust: { current: { kind: "pinned", pin: "sha256-pinned" } },
    },
  });
}

describe("the main window's view of computers paired through Other computers", () => {
  it("picks up a computer from this window's registry and lists it as a host", async () => {
    await pairedHostRecord("key-1");
    const { result } = renderHook(() => useHostFederationLifecycle());

    await waitFor(() => expect(result.current).toBeDefined());

    const identities = result.current?.lifecycle.toHostIdentities() ?? [];
    expect(identities.map((host) => host.displayName)).toContain("Studio Mac");
  });

  it("reaches a paired computer only through the desktop, never with the page's own fetch", async () => {
    const pageFetch = vi.spyOn(globalThis, "fetch");
    const requestPairedComputer = vi.fn<PairedComputersBridge["requestPairedComputer"]>(
      async () => ({ status: "refused", message: "Octant isn't paired with that computer." }),
    );
    const { result } = renderHook(() =>
      useHostFederationLifecycle({
        forgetPairedComputer: vi.fn(),
        requestPairedComputer,
      }),
    );
    await waitFor(() => expect(result.current).toBeDefined());
    const stack = result.current;
    if (stack === undefined) throw new Error("expected a federation stack");
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]);
    const keyId = await stack.deviceKeyStore.set(keyPair, {
      origin: ORIGIN,
      hostId: HOST as never,
      deviceId: "device-1",
    });
    await stack.deviceKeyStore.updateMetadata(keyId, {
      deviceId: "device-1",
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
      listenerTrust: { current: { kind: "pinned", pin: "sha256-pinned" } },
    });
    await pairedHostRecord(keyId);

    await stack.lifecycle.sync();

    await waitFor(() => expect(requestPairedComputer).toHaveBeenCalled());
    expect(requestPairedComputer.mock.calls[0]?.[0]).toMatchObject({
      origin: ORIGIN,
      method: "GET",
    });
    expect(requestPairedComputer.mock.calls[0]?.[0].path).toMatch(/^\/api\/remote\/hello\?/);
    expect(pageFetch).not.toHaveBeenCalledWith(expect.stringContaining(ORIGIN), expect.anything());
    pageFetch.mockRestore();
  });

  it("drops the desktop's pin when a computer is removed from this window", async () => {
    await pairedHostRecord("key-1");
    const forgetPairedComputer = vi.fn<PairedComputersBridge["forgetPairedComputer"]>(async () => ({
      status: "forgotten",
    }));
    const { result } = renderHook(() =>
      useHostFederationLifecycle({ forgetPairedComputer, requestPairedComputer: vi.fn() }),
    );
    await waitFor(() => expect(result.current).toBeDefined());

    await result.current?.lifecycle.removeLocal(HOST);

    expect(forgetPairedComputer).toHaveBeenCalledWith(ORIGIN);
    expect(await result.current?.registry.get(HOST)).toBeUndefined();
  });

  it("says so when the desktop could not clear everything the computer left", async () => {
    await pairedHostRecord("key-1");
    const { result } = renderHook(() =>
      useHostFederationLifecycle({
        forgetPairedComputer: async () => ({ status: "forgotten", warning: "Quit and reopen." }),
        requestPairedComputer: vi.fn(),
      }),
    );
    await waitFor(() => expect(result.current).toBeDefined());

    const removed = await result.current?.lifecycle.removeLocal(HOST);

    expect(removed?.warning).toBe("Quit and reopen.");
  });
});
