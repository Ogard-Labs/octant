import { describe, expect, it } from "vitest";
import {
  decodeHostBackupOutcome,
  decodeHostControlStatus,
  decodeHostLifecycleOutcome,
  decodeHostLifecycleRequest,
  decodeHostRestoreOutcome,
  HOST_LIFECYCLE_ACTIONS,
} from "./hostControl";

const status = {
  identity: {
    hostId: "host-a",
    instanceId: "instance-1",
    serviceMode: "web",
  },
  versions: { server: "0.1.0", wire: "1" },
  policy: { kind: "known", enabled: true, updatedAt: "2026-08-11T00:00:00.000Z" },
  readiness: {
    store: { state: "current", integrity: "ok" },
    replay: { journalHead: 12, projections: 3 },
    clientsConnected: 2,
    uptimeSeconds: 90,
  },
  capabilities: ["local-loopback", "provider:ollama"],
  work: { active: 1, attentionRequired: false },
  lifecycle: {
    stop: { kind: "available" },
    restart: {
      kind: "unavailable",
      reason: "Restart requires the per-user service manager.",
    },
    enable: { kind: "available" },
    disable: { kind: "available" },
  },
};

describe("HostControlStatus", () => {
  it("decodes a complete host control status report", () => {
    const decoded = decodeHostControlStatus(status);
    expect(decoded.identity.hostId).toBe("host-a");
    expect(decoded.identity.serviceMode).toBe("web");
    expect(decoded.policy).toEqual({
      kind: "known",
      enabled: true,
      updatedAt: "2026-08-11T00:00:00.000Z",
    });
    expect(decoded.readiness.replay.journalHead).toBe(12);
    expect(decoded.lifecycle.restart.kind).toBe("unavailable");
  });

  it("decodes an unavailable service policy", () => {
    const decoded = decodeHostControlStatus({
      ...status,
      policy: { kind: "unavailable", reason: "Service policy could not be read." },
    });
    expect(decoded.policy.kind).toBe("unavailable");
  });

  it("rejects a maintenance service mode, excess properties, and negative counters", () => {
    expect(() =>
      decodeHostControlStatus({
        ...status,
        identity: { ...status.identity, serviceMode: "maintenance" },
      }),
    ).toThrow();
    expect(() => decodeHostControlStatus({ ...status, secret: "nope" })).toThrow();
    expect(() =>
      decodeHostControlStatus({
        ...status,
        readiness: { ...status.readiness, clientsConnected: -1 },
      }),
    ).toThrow();
  });
});

describe("HostLifecycleRequest", () => {
  it("enumerates the durable lifecycle actions", () => {
    expect(HOST_LIFECYCLE_ACTIONS).toEqual(["stop", "restart", "enable", "disable"]);
  });

  it("decodes each lifecycle action and rejects unknown actions or excess keys", () => {
    for (const action of HOST_LIFECYCLE_ACTIONS) {
      expect(decodeHostLifecycleRequest({ action }).action).toBe(action);
    }
    expect(() => decodeHostLifecycleRequest({ action: "start" })).toThrow();
    expect(() => decodeHostLifecycleRequest({ action: "stop", force: true })).toThrow();
  });
});

describe("HostLifecycleOutcome", () => {
  it("decodes accepted and refused outcomes", () => {
    const accepted = decodeHostLifecycleOutcome({
      kind: "accepted",
      action: "stop",
      message: "The host is draining and will stop.",
    });
    expect(accepted.kind).toBe("accepted");
    const refused = decodeHostLifecycleOutcome({
      kind: "refused",
      action: "restart",
      code: "restart-unavailable",
      guidance: "Use `octant server restart` from a local terminal.",
    });
    expect(refused.kind).toBe("refused");
  });

  it("rejects unknown refusal codes", () => {
    expect(() =>
      decodeHostLifecycleOutcome({
        kind: "refused",
        action: "stop",
        code: "mystery",
        guidance: "n/a",
      }),
    ).toThrow();
  });
});

describe("HostBackupOutcome", () => {
  it("decodes created and failed outcomes", () => {
    const created = decodeHostBackupOutcome({
      kind: "created",
      label: "manual",
      migrationVersion: 4,
      journalHead: 42,
      byteLength: 4096,
    });
    expect(created.kind).toBe("created");
    const failed = decodeHostBackupOutcome({ kind: "failed", code: "backup-failed" });
    expect(failed.kind).toBe("failed");
  });

  it("never carries a raw filesystem path", () => {
    expect(() =>
      decodeHostBackupOutcome({
        kind: "created",
        label: "manual",
        migrationVersion: 4,
        journalHead: 42,
        byteLength: 4096,
        path: "/tmp/leak.sqlite",
      }),
    ).toThrow();
  });
});

describe("HostRestoreOutcome", () => {
  it("decodes the honest online refusal with recovery guidance", () => {
    const decoded = decodeHostRestoreOutcome({
      kind: "refused-online",
      guidance: "Stop the Octant host, then run the offline restore command with --confirm.",
    });
    expect(decoded.kind).toBe("refused-online");
  });
});
