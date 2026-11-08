import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveHostServiceState,
  nextRestartBackoff,
  ServicePolicyStore,
  BoundedHostLogStore,
} from "./index";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("headless service state", () => {
  it.each([
    ["disabled", { enabled: false, manager: "available" as const, owner: "none" as const }],
    ["stopped", { enabled: true, manager: "available" as const, owner: "none" as const }],
    ["starting", { enabled: true, manager: "available" as const, owner: "starting" as const }],
    ["ready", { enabled: true, manager: "available" as const, owner: "ready" as const }],
    ["degraded", { enabled: true, manager: "available" as const, owner: "degraded" as const }],
    [
      "crash-loop",
      { enabled: true, manager: "available" as const, owner: "none" as const, crashLoop: true },
    ],
    [
      "incompatible",
      { enabled: true, manager: "available" as const, owner: "incompatible" as const },
    ],
    [
      "unauthorized",
      { enabled: true, manager: "available" as const, owner: "unauthorized" as const },
    ],
    [
      "manager-unavailable",
      { enabled: true, manager: "unavailable" as const, owner: "none" as const },
    ],
  ])("keeps %s distinct and actionable", (state, input) => {
    expect(deriveHostServiceState(input)).toMatchObject({ state });
    expect(deriveHostServiceState(input).actionable.length).toBeGreaterThan(0);
  });
});

describe("restart backoff", () => {
  it("uses deterministic bounded delays and enters crash-loop after repeated failures", () => {
    expect(nextRestartBackoff({ failures: 0, now: 1_000 })).toEqual({
      delayMs: 1_000,
      retryAt: 2_000,
      crashLoop: false,
    });
    expect(nextRestartBackoff({ failures: 4, now: 1_000 })).toEqual({
      delayMs: 16_000,
      retryAt: 17_000,
      crashLoop: false,
    });
    expect(nextRestartBackoff({ failures: 5, now: 1_000 })).toEqual({
      delayMs: 30_000,
      retryAt: 31_000,
      crashLoop: true,
    });
  });
});

describe("service policy and bounded logs", () => {
  it("refuses unsafe native storage instead of reading ordinary files or writing a replacement log", async () => {
    const replace = vi.fn(() => ({ status: "committed" as const }));
    const file = {
      dataDirectory: "/unused",
      read: () => ({ status: "refused" as const }),
      replace,
    };
    const policy = new ServicePolicyStore({ path: "/unused/policy", privateFile: file });
    const logs = new BoundedHostLogStore({ path: "/unused/log", privateFile: file });
    await expect(policy.read()).rejects.toThrow(/unsafe|unavailable/);
    await expect(
      logs.append({
        timestamp: new Date().toISOString(),
        level: "info",
        event: "ready",
        message: "ready",
      }),
    ).rejects.toThrow(/unsafe|unavailable/);
    expect(replace).not.toHaveBeenCalled();
  });

  it("refuses invalid native UTF-8 rather than treating it as absent policy", async () => {
    const bytes = Buffer.from([0xff]);
    const file = {
      dataDirectory: "/unused",
      read: () => ({ status: "ready" as const, bytes }),
      replace: () => ({ status: "refused" as const }),
    };
    const policy = new ServicePolicyStore({ path: "/unused/policy", privateFile: file });
    await expect(policy.read()).rejects.toThrow();
    expect(bytes.equals(Buffer.alloc(1))).toBe(true);
  });

  it("persists policy without deleting the data store", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-service-policy-"));
    roots.push(root);
    const dataPath = join(root, "octant.sqlite3");
    const policy = new ServicePolicyStore({ path: join(root, "config", "service-policy.json") });
    await writeFile(dataPath, "durable-state");

    await policy.setEnabled(false);

    expect((await policy.read()).enabled).toBe(false);
    expect(await readFile(dataPath, "utf8")).toBe("durable-state");
    expect((await stat(join(root, "config", "service-policy.json"))).mode & 0o777).toBe(0o600);
  });

  it("redacts sensitive fields and supports bounded since/limit/follow reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-service-logs-"));
    roots.push(root);
    const logs = new BoundedHostLogStore({ path: join(root, "logs", "service.log") });
    await logs.append({
      timestamp: "2026-08-10T10:00:00.000Z",
      level: "info",
      event: "provider.failure",
      message: "provider failed authorization=Bearer top-secret",
      details: {
        prompt: "private prompt",
        content: "private content",
        credential: "api-key",
        providerPayload: { secret: "payload" },
      },
    });
    await logs.append({
      timestamp: "2026-08-10T10:00:01.000Z",
      level: "warn",
      event: "service.degraded",
      message: "retrying",
    });

    const result = await logs.read({
      since: "2026-08-10T09:59:59.000Z",
      limit: 1,
      follow: true,
    });
    expect(result.follow).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(JSON.stringify(result.entries)).not.toContain("top-secret");
    expect(JSON.stringify(result.entries)).not.toContain("private prompt");
    expect(JSON.stringify(result.entries)).not.toContain("private content");
    expect(JSON.stringify(result.entries)).not.toContain("api-key");
    expect(JSON.stringify(result.entries)).not.toContain("payload");
  });

  it("does not retain a sensitive event message without an assignment marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-sensitive-event-"));
    roots.push(root);
    const logs = new BoundedHostLogStore({ path: join(root, "logs", "service.log") });

    await logs.append({
      timestamp: "2026-08-10T10:00:00.000Z",
      level: "info",
      event: "provider.payload.received",
      message: "raw provider response with private material",
    });

    const result = await logs.read();
    expect(result.entries[0]?.event).toBe("redacted.event");
    expect(result.entries[0]?.message).toBe("[REDACTED]");
    expect(JSON.stringify(result.entries)).not.toContain("private material");
  });

  it("keeps a stable cursor for entries sharing a timestamp", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-equal-time-logs-"));
    roots.push(root);
    const logs = new BoundedHostLogStore({ path: join(root, "logs", "service.log") });
    const timestamp = "2026-08-10T10:00:00.000Z";

    await logs.append({ timestamp, level: "info", event: "first", message: "first" });
    const first = await logs.read({ limit: 1 });
    await logs.append({ timestamp, level: "info", event: "second", message: "second" });
    const cursor = first.nextSince;
    if (cursor === undefined) throw new Error("expected a cursor after the first entry");

    const second = await logs.read({ since: cursor, limit: 1 });

    expect(second.entries.map((entry) => entry.event)).toEqual(["second"]);
    expect(second.nextSince).not.toBe(cursor);
  });
});
