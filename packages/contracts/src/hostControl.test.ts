import { describe, expect, it } from "vitest";
import {
  decodeHostBackupOutcome,
  decodeHostControlStatus,
  decodeHostLifecycleOutcome,
  decodeHostLifecycleRequest,
  decodeHostMemoryLimits,
  decodeHostMemoryLimitsChanged,
  decodeHostRestoreOutcome,
  decodeSetHostMemoryLimitsOutcome,
  decodeSetHostMemoryLimitsRequest,
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

  it("decodes the memory report with a relief and a previous stop", () => {
    const decoded = decodeHostControlStatus({
      ...status,
      memory: {
        pressure: "elevated",
        processMegabytes: 2300,
        limits: { kind: "automatic" },
        effectiveLimits: { pressuredMegabytes: 2048, criticalMegabytes: 4096 },
        lastRelief: {
          at: "2026-10-31T10:00:00.000Z",
          pressure: "elevated",
          source: "system",
          idleProviderRuntimesStopped: 2,
          idleSessionsReleased: 1,
          cachesTrimmed: true,
          activeTurnsKept: 1,
        },
        previousStop: {
          lastSeenAt: "2026-10-31T09:00:00.000Z",
          pressure: "critical",
          processMegabytes: 4100,
        },
      },
    });
    expect(decoded.memory?.lastRelief?.idleProviderRuntimesStopped).toBe(2);
    expect(decoded.memory?.previousStop?.pressure).toBe("critical");
  });

  it("refuses a memory report that names more than counts", () => {
    expect(() =>
      decodeHostControlStatus({
        ...status,
        memory: {
          pressure: "normal",
          processMegabytes: 300,
          limits: { kind: "automatic" },
          effectiveLimits: { pressuredMegabytes: 2048, criticalMegabytes: 4096 },
          lastRelief: {
            at: "2026-10-31T10:00:00.000Z",
            pressure: "elevated",
            source: "system",
            idleProviderRuntimesStopped: 0,
            idleSessionsReleased: 0,
            cachesTrimmed: false,
            activeTurnsKept: 0,
            providers: ["codex"],
          },
        },
      }),
    ).toThrow();
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

describe("HostMemoryLimits", () => {
  it("decodes automatic and a custom pair with the critical limit above the pressured one", () => {
    expect(decodeHostMemoryLimits({ kind: "automatic" })).toEqual({ kind: "automatic" });
    expect(decodeHostMemoryLimits({ kind: "custom", pressuredGb: 0.5, criticalGb: 64 })).toEqual({
      kind: "custom",
      pressuredGb: 0.5,
      criticalGb: 64,
    });
  });

  it.each([
    [{ kind: "custom", pressuredGb: 4, criticalGb: 4 }],
    [{ kind: "custom", pressuredGb: 6, criticalGb: 3 }],
    [{ kind: "custom", pressuredGb: 0.25, criticalGb: 2 }],
    [{ kind: "custom", pressuredGb: 2, criticalGb: 65 }],
    [{ kind: "custom", pressuredGb: Number.NaN, criticalGb: 8 }],
    [{ kind: "custom", pressuredGb: 2 }],
    [{ kind: "automatic", pressuredGb: 2 }],
  ])("refuses stored limits that are out of order, out of range, or incomplete: %j", (limits) => {
    expect(() => decodeHostMemoryLimits(limits)).toThrow();
  });

  it("accepts any pair of numbers in a request so the policy can refuse it with a message", () => {
    expect(
      decodeSetHostMemoryLimitsRequest({
        limits: { kind: "custom", pressuredGb: 90, criticalGb: 1 },
      }),
    ).toEqual({ limits: { kind: "custom", pressuredGb: 90, criticalGb: 1 } });
    expect(() =>
      decodeSetHostMemoryLimitsRequest({
        limits: { kind: "custom", pressuredGb: "2", criticalGb: 4 },
      }),
    ).toThrow();
    expect(() =>
      decodeSetHostMemoryLimitsRequest({ limits: { kind: "automatic" }, extra: true }),
    ).toThrow();
  });

  it("decodes a saved outcome and a refusal, and nothing in between", () => {
    expect(
      decodeSetHostMemoryLimitsOutcome({ kind: "saved", limits: { kind: "automatic" } }).kind,
    ).toBe("saved");
    expect(
      decodeSetHostMemoryLimitsOutcome({
        kind: "refused",
        code: "out-of-range",
        message: "Memory limits must be between 0.5 and 64 GB.",
      }).kind,
    ).toBe("refused");
    expect(() =>
      decodeSetHostMemoryLimitsOutcome({ kind: "refused", code: "unknown", message: "No." }),
    ).toThrow();
  });

  it("records who changed the limits, when, and the values before and after", () => {
    const change = {
      kind: "memory-limits-changed",
      previous: { kind: "automatic" },
      next: { kind: "custom", pressuredGb: 3, criticalGb: 6 },
      changedBy: "local-window",
      changedAt: "2026-10-31T12:00:00.000Z",
    };
    expect(decodeHostMemoryLimitsChanged(change)).toEqual(change);
    expect(() =>
      decodeHostMemoryLimitsChanged({ ...change, changedBy: "remote-device" }),
    ).toThrow();
  });
});
