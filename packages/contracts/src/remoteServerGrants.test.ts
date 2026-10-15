import { describe, expect, it } from "vitest";
import {
  decodeRemoteServerGrantClosedPayload,
  decodeRemoteServerGrantId,
  decodeRemoteServerGrantOpenedPayload,
  decodeRemoteServerGrantRequest,
  decodeRemoteServerGrantResult,
  decodeRemoteServerProxyRefusal,
  encodeRemoteServerGrantResult,
} from "./remoteServerGrants";

const ids = {
  thread: "11111111-1111-4111-8111-111111111111",
  project: "22222222-2222-4222-8222-222222222222",
  request: "33333333-3333-4333-8333-333333333333",
  device: "44444444-4444-4444-8444-444444444444",
} as const;

const listenerId = "lsn_0123456789abcdef0123456789abcdef";
const grantId = `rsg_${"ab".repeat(32)}`;

const fromLocalServers = {
  kind: "open-remote-server-grant",
  requestId: ids.request,
  source: {
    surface: "local-servers",
    threadId: ids.thread,
    projectId: ids.project,
    listenerId,
  },
} as const;

const fromRunningServices = {
  kind: "open-remote-server-grant",
  requestId: ids.request,
  source: { surface: "running-services", listenerId },
} as const;

describe("remote server grant contracts", () => {
  it("decodes a request naming a listener from either listing", () => {
    expect(decodeRemoteServerGrantRequest(fromLocalServers).source.surface).toBe("local-servers");
    expect(decodeRemoteServerGrantRequest(fromRunningServices).source.surface).toBe(
      "running-services",
    );
  });

  it("accepts no port, address, process, or command line from the client", () => {
    for (const extra of [
      { port: 5173 },
      { url: "http://127.0.0.1:5173/" },
      { pid: 4213 },
      { commandLine: "node ./bin/vite" },
    ]) {
      expect(() => decodeRemoteServerGrantRequest({ ...fromLocalServers, ...extra })).toThrow();
      expect(() =>
        decodeRemoteServerGrantRequest({
          ...fromLocalServers,
          source: { ...fromLocalServers.source, ...extra },
        }),
      ).toThrow();
    }
  });

  it("refuses a Running services request that names its own thread", () => {
    expect(() =>
      decodeRemoteServerGrantRequest({
        ...fromRunningServices,
        source: { ...fromRunningServices.source, threadId: ids.thread },
      }),
    ).toThrow();
  });

  it("refuses a listener id that is not the host's opaque token", () => {
    expect(() =>
      decodeRemoteServerGrantRequest({
        ...fromRunningServices,
        source: { surface: "running-services", listenerId: "5173" },
      }),
    ).toThrow();
  });

  it("round-trips an opened grant and every refusal", () => {
    const results = [
      {
        kind: "remote-server-grant-opened",
        requestId: ids.request,
        grant: { grantId, threadId: ids.thread, port: 5173 },
      },
      ...(
        [
          "local-principal",
          "thread-unreadable",
          "not-found",
          "not-octant-owned",
          "not-in-thread",
          "open-denied",
          "grant-limit",
        ] as const
      ).map((reason) => ({
        kind: "remote-server-grant-refused",
        requestId: ids.request,
        refusal: { reason, message: "Refused." },
      })),
      ...(["unresponsive", "unknown"] as const).map((health) => ({
        kind: "remote-server-grant-refused",
        requestId: ids.request,
        refusal: { reason: "not-listening", health, message: "Refused." },
      })),
    ];
    for (const result of results) {
      expect(encodeRemoteServerGrantResult(decodeRemoteServerGrantResult(result))).toEqual(result);
    }
  });

  it("never refuses a server for listening", () => {
    expect(() =>
      decodeRemoteServerGrantResult({
        kind: "remote-server-grant-refused",
        requestId: ids.request,
        refusal: { reason: "not-listening", health: "listening", message: "Refused." },
      }),
    ).toThrow();
  });

  it("keeps the host's loopback URL and process out of an opened grant", () => {
    const grant = { grantId, threadId: ids.thread, port: 5173 };
    for (const extra of [{ url: "http://127.0.0.1:5173/" }, { pid: 4213 }]) {
      expect(() =>
        decodeRemoteServerGrantResult({
          kind: "remote-server-grant-opened",
          requestId: ids.request,
          grant: { ...grant, ...extra },
        }),
      ).toThrow();
    }
  });

  it("refuses a grant id that is not 32 random bytes in hex", () => {
    expect(String(decodeRemoteServerGrantId(grantId))).toBe(grantId);
    expect(() => decodeRemoteServerGrantId(`rsg_${"ab".repeat(16)}`)).toThrow();
    expect(() => decodeRemoteServerGrantId(`rsg_${"AB".repeat(32)}`)).toThrow();
    expect(() => decodeRemoteServerGrantId("ab".repeat(32))).toThrow();
  });

  it("journals a grant with its device, thread, and port and nothing about the endpoint", () => {
    const opened = { grantId, deviceId: ids.device, threadId: ids.thread, port: 5173 };
    expect(decodeRemoteServerGrantOpenedPayload(opened).port).toBe(5173);
    expect(() =>
      decodeRemoteServerGrantOpenedPayload({ ...opened, url: "http://127.0.0.1:5173/" }),
    ).toThrow();
    expect(() => decodeRemoteServerGrantOpenedPayload({ ...opened, pid: 4213 })).toThrow();

    expect(
      decodeRemoteServerGrantClosedPayload({ ...opened, reason: "device-revoked" }).reason,
    ).toBe("device-revoked");
    expect(() => decodeRemoteServerGrantClosedPayload(opened)).toThrow();
    expect(() => decodeRemoteServerGrantClosedPayload({ ...opened, reason: "expired" })).toThrow();
  });

  it("states a relay refusal by reason and nothing about the server or the grant", () => {
    for (const reason of ["grant-closed", "server-unreachable", "upgrade-refused"] as const) {
      const refusal = { kind: "remote-server-proxy-refused", reason, message: "Refused." };
      expect(decodeRemoteServerProxyRefusal(refusal)).toEqual(refusal);
    }
    const refusal = {
      kind: "remote-server-proxy-refused",
      reason: "grant-closed",
      message: "Refused.",
    } as const;
    expect(() =>
      decodeRemoteServerProxyRefusal({ ...refusal, reason: "server-stopped" }),
    ).toThrow();
    for (const extra of [{ grantId }, { port: 5173 }, { pid: 4213 }]) {
      expect(() => decodeRemoteServerProxyRefusal({ ...refusal, ...extra })).toThrow();
    }
  });
});
