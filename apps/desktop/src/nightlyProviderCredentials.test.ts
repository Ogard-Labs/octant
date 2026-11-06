import { randomBytes } from "node:crypto";
import { decodeNightlyWindowBootstrap } from "@octant/contracts/nightly-browser";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_IPC_CHANNELS, KEYRING_ADVICE_MARKER } from "./ipcChannels";
import { NEEDS_NEWER_OCTANT } from "./nightlyClientChannels";
import { createNativeMainAuthority } from "./nightlyNativeMainAuthority";
import { installNightlyProviderCredentials } from "./nightlyProviderCredentials";

const token = () => randomBytes(32).toString("base64url");
const INSTANCE = "80000000-0000-4000-8000-000000000401";

function harness(features: ReadonlyArray<string>, answer: () => Response) {
  const nativeMainToken = token();
  const window = decodeNightlyWindowBootstrap({
    kind: "registered",
    protocol: 1,
    windowId: "10000000-0000-4000-8000-0000000006a1",
    generation: 1,
    hostOrigin: "http://127.0.0.1:13773",
    hostInstance: "00000000-0000-4000-8000-000000000594",
    capability: token(),
    rendererIdentity: token(),
    leaseMs: 15_000,
    nativeMainToken,
    hostFeatures: features,
  });
  const nativeMain = createNativeMainAuthority();
  nativeMain.remember(7, window);
  const handlers = new Map<string, (event: unknown, ...values: unknown[]) => unknown>();
  const fetch = vi.fn(async () => answer());
  installNightlyProviderCredentials({
    register: (channel, handler) => handlers.set(channel, handler as never),
    bootstrap: (id) => (id === 7 ? window : undefined),
    nativeMain,
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  const invoke = async (channel: string, ...values: unknown[]) =>
    await handlers.get(channel)?.({ sender: { id: 7 } }, ...values);
  return { window, nativeMainToken, fetch, invoke };
}

describe("Nightly provider keys through Octant's host", () => {
  it("adds a key on the host with the window's own authority and answers its label only", async () => {
    const key = { id: "c7cc27a9-4e34-45f0-bf3b-9b8a60dcfae8", label: "Key 1", active: true };
    const { window, nativeMainToken, fetch, invoke } = harness(["provider-api-keys"], () =>
      Response.json({ key }),
    );
    await expect(
      invoke(DESKTOP_IPC_CHANNELS.addProviderApiKey, INSTANCE, "sk-test", undefined),
    ).resolves.toEqual(key);
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("http://127.0.0.1:13773/api/desktop/provider-credentials/keys/add");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      "x-octant-window-capability": window.capability,
      "x-octant-native-main-authority": nativeMainToken,
    });
    expect(JSON.parse(String(init.body))).toEqual({ instance: INSTANCE, credential: "sk-test" });
  });

  it("stores a single key by replacing it, and reads its status", async () => {
    const { fetch, invoke } = harness(["provider-credentials"], () =>
      Response.json({ outcome: "stored", instanceId: INSTANCE, displayName: "Gateway" }),
    );
    await invoke(DESKTOP_IPC_CHANNELS.setProviderCredential, INSTANCE, "sk-test");
    expect(
      JSON.parse(String((fetch.mock.calls[0] as unknown as [URL, RequestInit])[1].body)),
    ).toEqual({ instance: INSTANCE, credential: "sk-test", replace: true });
    await expect(invoke(DESKTOP_IPC_CHANNELS.providerCredentialStatus, INSTANCE)).resolves.toBe(
      "stored",
    );
  });

  it("shows the pool's, the link's and the keyring's own sentences", async () => {
    let body: unknown = {};
    const { invoke } = harness(["provider-credentials", "provider-api-keys"], () =>
      Response.json(body, { status: 409 }),
    );
    body = {
      category: "api-key-pool",
      reason: "unknown-key",
      message: "That API key is no longer stored.",
    };
    await expect(
      invoke(DESKTOP_IPC_CHANNELS.removeProviderApiKey, INSTANCE, "default"),
    ).rejects.toThrow("That API key is no longer stored.");
    body = { category: "linked-secret", message: "x" };
    await expect(invoke(DESKTOP_IPC_CHANNELS.clearProviderCredential, INSTANCE)).rejects.toThrow(
      "This provider's key comes from a linked secret store. Remove the link in Settings first.",
    );
    body = { category: "credential-store-unavailable", message: "x", cause: "locked" };
    await expect(invoke(DESKTOP_IPC_CHANNELS.listProviderApiKeys, INSTANCE)).rejects.toThrow(
      `${KEYRING_ADVICE_MARKER}Your keyring is locked.`,
    );
  });

  it("says it needs a newer Octant when the host does not broker API keys, without asking it", async () => {
    const { fetch, invoke } = harness(["provider-credentials"], () => Response.json({}));
    await expect(invoke(DESKTOP_IPC_CHANNELS.listProviderApiKeys, INSTANCE)).rejects.toThrow(
      NEEDS_NEWER_OCTANT,
    );
    await expect(
      invoke(DESKTOP_IPC_CHANNELS.moveProviderApiKey, INSTANCE, "default", "up"),
    ).rejects.toThrow(NEEDS_NEWER_OCTANT);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a malformed request before it reaches the host", async () => {
    const { fetch, invoke } = harness(["provider-api-keys"], () => Response.json({}));
    await expect(
      invoke(DESKTOP_IPC_CHANNELS.moveProviderApiKey, INSTANCE, "default", "left"),
    ).rejects.toThrow("Octant rejected an invalid API key request.");
    await expect(invoke(DESKTOP_IPC_CHANNELS.listProviderApiKeys, "../etc")).rejects.toThrow(
      "Octant rejected an invalid credential request.",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
