import type { RunningService } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createRemoteServerLiveOpener, type RemoteServerLiveHost } from "./remoteServerLiveOpener";

const GRANT_ID = `rsg_${"ab".repeat(32)}`;
const THREAD_ID = "77777777-7777-4777-8777-777777777777";
const SERVICE = { listenerId: `lsn_${"0".repeat(31)}1`, port: 5173 } as RunningService;

const HOST: RemoteServerLiveHost = {
  hostId: "11111111-1111-4111-8111-111111111111",
  hostName: "Studio Mac",
  origin: "https://192.168.1.20:9443",
  issueSession: async () => ({
    hostId: "11111111-1111-4111-8111-111111111111",
    deviceId: "22222222-2222-4222-8222-222222222222",
    sessionId: "proxy-1",
    credentialGeneration: 1,
    origin: "https://192.168.1.20:9443",
    protocolVersion: 1,
    authenticationVersion: 1,
    capabilityDigest: "a".repeat(64),
    csrfToken: "csrf",
    issuedAt: "2026-10-15T09:00:00.000Z",
    idleExpiresAt: "2026-10-15T09:15:00.000Z",
    absoluteExpiresAt: "2026-10-15T17:00:00.000Z",
  }),
  sign: async () => "signature",
};

function bridge() {
  let signer: ((request: unknown) => Promise<unknown>) | undefined;
  const openRemoteServerPage = vi.fn(async (_request: unknown) => ({ kind: "opened" as const }));
  return {
    openRemoteServerPage,
    subscribeRemoteServerPageSigning: (next: (request: unknown) => Promise<unknown>) => {
      signer = next;
      return () => {
        signer = undefined;
      };
    },
    sign: (request: unknown) => signer?.(request),
  };
}

const granted = () =>
  Response.json({
    kind: "remote-server-grant-opened",
    requestId: "33333333-3333-4333-8333-333333333333",
    grant: { grantId: GRANT_ID, threadId: THREAD_ID, port: 5173 },
  });

describe("opening another computer's server live from this window", () => {
  it("asks the host for the grant, then has the desktop show it, and signs the page's requests", async () => {
    const desktop = bridge();
    const opener = createRemoteServerLiveOpener(desktop, async () => granted());
    expect(await opener.openLive(HOST, SERVICE, "octant-browser")).toEqual({ kind: "opened" });
    expect(desktop.openRemoteServerPage).toHaveBeenCalledWith({
      hostId: HOST.hostId,
      hostName: "Studio Mac",
      listenerOrigin: HOST.origin,
      grant: { grantId: GRANT_ID, threadId: THREAD_ID, port: 5173 },
      mode: "octant-browser",
    });
    const signing = (await desktop.sign({
      hostId: HOST.hostId,
      grantId: GRANT_ID,
      method: "GET",
      pathQuery: `/api/server-proxy/${GRANT_ID}/`,
      bodyDigest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    })) as { status: string };
    expect(signing.status).toBe("signed");
  });

  it("asks for the grant over the host's own transport, so a computer reached through the desktop never meets the page's fetch", async () => {
    const desktop = bridge();
    const pageFetch = vi.fn(async () => granted());
    const hostFetch = vi.fn<typeof globalThis.fetch>(async () => granted());
    const opener = createRemoteServerLiveOpener(desktop, pageFetch);

    expect(await opener.openLive({ ...HOST, fetch: hostFetch }, SERVICE, "octant-browser")).toEqual(
      { kind: "opened" },
    );

    expect(hostFetch).toHaveBeenCalledOnce();
    expect(String(hostFetch.mock.calls[0]?.[0])).toBe(`${HOST.origin}/api/server-proxy/grants`);
    expect(pageFetch).not.toHaveBeenCalled();
  });

  it("shows the host's refusal and asks the desktop for nothing", async () => {
    const desktop = bridge();
    const opener = createRemoteServerLiveOpener(desktop, async () =>
      Response.json({
        kind: "remote-server-grant-refused",
        requestId: "33333333-3333-4333-8333-333333333333",
        refusal: {
          reason: "thread-unreadable",
          message: "This device can't open servers in that thread.",
        },
      }),
    );
    expect(await opener.openLive(HOST, SERVICE, "default-browser")).toEqual({
      kind: "refused",
      message: "This device can't open servers in that thread.",
    });
    expect(desktop.openRemoteServerPage).not.toHaveBeenCalled();
  });

  it("signs nothing for a host it holds no grant from, or after it is disposed", async () => {
    const desktop = bridge();
    const opener = createRemoteServerLiveOpener(desktop, async () => granted());
    await opener.openLive(HOST, SERVICE, "octant-browser");
    const request = {
      hostId: "99999999-9999-4999-8999-999999999999",
      grantId: GRANT_ID,
      method: "GET",
      pathQuery: `/api/server-proxy/${GRANT_ID}/`,
      bodyDigest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    };
    expect(await desktop.sign(request)).toEqual({ status: "refused" });
    opener.dispose();
    expect(await desktop.sign({ ...request, hostId: HOST.hostId })).toBeUndefined();
  });
});
