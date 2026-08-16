import { describe, expect, it } from "vitest";
import {
  decodeLocalServerCommand,
  decodeLocalServerCommandResult,
  decodeLocalServerListener,
  decodeLocalServerSnapshot,
  decodeLocalServerUrl,
} from "./localServers";

const ids = {
  thread: "11111111-1111-4111-8111-111111111111",
  project: "22222222-2222-4222-8222-222222222222",
  request: "33333333-3333-4333-8333-333333333333",
} as const;

const listenerId = "lsn_0123456789abcdef0123456789abcdef";
const observedAt = "2026-08-14T08:00:00.000Z";

const listener = {
  listenerId,
  port: 5173,
  url: "http://127.0.0.1:5173/",
  processName: "node",
  framework: "vite",
  workingDirectory: "/Users/example/code/octant",
  workspaceLabel: "octant",
  attribution: "current-checkout",
  startSource: "octant",
  bindScope: "loopback",
  health: "listening",
  openAvailable: true,
  stop: { status: "available", confirmationRequired: false },
} as const;

const snapshot = {
  threadId: ids.thread,
  projectId: ids.project,
  currentCheckout: [listener],
  other: [],
  observedAt,
} as const;

describe("local server contracts", () => {
  it("decodes a classified listener and its snapshot grouping", () => {
    expect(decodeLocalServerListener(listener).port).toBe(5173);
    const decoded = decodeLocalServerSnapshot(snapshot);
    expect(decoded.currentCheckout).toHaveLength(1);
    expect(decoded.other).toHaveLength(0);
  });

  it("rejects a listener carrying a raw command line or PID", () => {
    expect(() =>
      decodeLocalServerListener({ ...listener, commandLine: "node ./bin/vite --host" }),
    ).toThrow();
    expect(() => decodeLocalServerListener({ ...listener, pid: 4213 })).toThrow();
  });

  it("rejects a non-loopback or credentialed open URL", () => {
    expect(() => decodeLocalServerUrl("http://example.com:5173/")).toThrow();
    expect(() => decodeLocalServerUrl("http://user:secret@127.0.0.1:5173/")).toThrow();
    expect(() => decodeLocalServerUrl("http://127.0.0.1/")).toThrow();
    expect(() => decodeLocalServerUrl("file:///etc/passwd")).toThrow();
    expect(String(decodeLocalServerUrl("https://localhost:8443/"))).toBe("https://localhost:8443/");
    // The IPv6 loopback is loopback: a server bound only to `::1` is reachable
    // at the bracketed authority and nowhere else.
    expect(String(decodeLocalServerUrl("http://[::1]:5174/"))).toBe("http://[::1]:5174/");
    expect(() => decodeLocalServerUrl("http://[2001:db8::1]:5174/")).toThrow();
  });

  it("carries a health the host never determined as its own value", () => {
    // A listener the host ran out of time on is neither answering nor proven
    // silent, so it must have a value of its own rather than borrow the one
    // that asserts the port is held without an answer.
    expect(
      decodeLocalServerListener({ ...listener, health: "unknown", openAvailable: false }).health,
    ).toBe("unknown");
    expect(
      decodeLocalServerListener({ ...listener, health: "unresponsive", openAvailable: false })
        .health,
    ).toBe("unresponsive");
    expect(() => decodeLocalServerListener({ ...listener, health: "wedged" })).toThrow();
  });

  it("rejects a port outside the TCP range", () => {
    expect(() => decodeLocalServerListener({ ...listener, port: 0 })).toThrow();
    expect(() => decodeLocalServerListener({ ...listener, port: 65_536 })).toThrow();
  });

  it("carries a stop unavailability reason in words", () => {
    const decoded = decodeLocalServerListener({
      ...listener,
      stop: { status: "unavailable", reason: "Plan threads cannot stop local servers." },
    });
    expect(decoded.stop).toEqual({
      status: "unavailable",
      reason: "Plan threads cannot stop local servers.",
    });
  });

  it("decodes list, open, and confirmed stop commands", () => {
    const base = { requestId: ids.request, threadId: ids.thread, projectId: ids.project } as const;
    expect(decodeLocalServerCommand({ kind: "list-local-servers", ...base }).kind).toBe(
      "list-local-servers",
    );
    expect(decodeLocalServerCommand({ kind: "open-local-server", ...base, listenerId }).kind).toBe(
      "open-local-server",
    );
    const stop = decodeLocalServerCommand({
      kind: "stop-local-server",
      ...base,
      listenerId,
      confirmation: {
        acknowledgedProcessName: "node",
        acknowledgedPort: 5173,
        acknowledgedWorkingDirectory: "/Users/example/code/octant",
      },
    });
    expect(stop.kind).toBe("stop-local-server");
  });

  it("decodes each typed result including the fail-closed rejection", () => {
    expect(
      decodeLocalServerCommandResult({
        kind: "local-servers-listed",
        requestId: ids.request,
        snapshot,
      }).kind,
    ).toBe("local-servers-listed");
    expect(
      decodeLocalServerCommandResult({
        kind: "local-server-open-prepared",
        requestId: ids.request,
        listenerId,
        target: {
          url: "http://127.0.0.1:5173/",
          allowedOrigin: "http://127.0.0.1:5173",
          acceptsLocalCertificate: false,
        },
      }).kind,
    ).toBe("local-server-open-prepared");
    expect(
      decodeLocalServerCommandResult({
        kind: "local-server-rejected",
        requestId: ids.request,
        failure: {
          category: "local-host-required",
          message: "Leftover Stop must happen on the host.",
        },
      }).kind,
    ).toBe("local-server-rejected");
  });
});
