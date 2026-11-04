import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeCodeThreadId,
  decodeProjectId,
  decodeProviderInstance,
  decodeWindowId,
} from "@octant/contracts";
import {
  decodeProviderCloudRequest,
  decodeProviderCloudRemoteId,
  decodeProviderCloudJob,
  decodeProviderCloudJobId,
  type ProviderCloudJob,
  type ProviderCloudRemoteId,
} from "@octant/contracts/provider-cloud-sessions";
import { ProviderCloudSessionService } from "./providerCloudSessionService";
import { supportsOpenAiCloudSessions } from "../providers/openAiCloudSessions";
import type { CloudSessionObservation } from "@octant/provider-sdk/cloud-sessions";

const id = (last: number) => `a7550000-0000-4000-8000-${String(last).padStart(12, "0")}`;
const threadId = decodeCodeThreadId(id(3));
const windowId = decodeWindowId(id(4));
const now = "2026-11-04T12:00:00.000Z";
const text = "Explain a synthetic pure function.";
const digest = createHash("sha256").update(text).digest("hex");
const instance = decodeProviderInstance({
  id: id(1),
  driverKind: "openai-compatible",
  displayName: "Fixture API",
  enabled: true,
  environmentPolicy: "inherit-host",
  version: 1,
  createdAt: now,
  updatedAt: now,
  configuration: {
    kind: "openai-compatible-http",
    baseUrl: "https://api.openai.com/v1/",
    authentication: "bearer",
    protocol: "responses",
    manualModelIds: ["fixture-model"],
  },
});

function fixture(
  create?: () => Promise<CloudSessionObservation>,
  observedId?: ProviderCloudRemoteId,
) {
  const jobs = new Map<string, ProviderCloudJob>();
  const enabled = new Map<string, boolean>();
  let current = true;
  let starts = 0;
  let cancels = 0;
  const dispatched = new Set<string>();
  const service = new ProviderCloudSessionService({
    now: () => now,
    instances: () => [instance],
    supports: supportsOpenAiCloudSessions,
    models: () =>
      instance.driverKind === "openai-compatible" ? instance.configuration.manualModelIds : [],
    canManageProvider: () => current,
    context: () => ({
      threadId,
      projectId: decodeProjectId(id(5)),
      executionPolicy: "full-access",
      current: () => current,
      requiresUnsupportedBound: () => false,
    }),
    store: {
      get: (key) => jobs.get(String(key)),
      put: (job) => {
        const next = decodeProviderCloudJob({
          ...job,
          version: (jobs.get(job.id)?.version ?? 0) + 1,
        });
        jobs.set(String(job.id), next);
        return next;
      },
      list: (thread) =>
        [...jobs.values()].filter(
          (job) => thread === undefined || String(job.threadId) === String(thread),
        ),
      active: () =>
        [...jobs.values()].filter(
          (job) =>
            !["completed", "failed", "cancelled", "unavailable"].includes(job.state) &&
            job.uncertaintyAcknowledgedAt === undefined,
        ),
      hasCreateDispatch: (id) => dispatched.has(id),
      enabled: (key) => enabled.get(String(key)) ?? false,
      setEnabled: (key, value) => {
        enabled.set(String(key), value);
      },
    },
    adapter: (_instance, intent, _admission, onCreated) => ({
      create: async () => {
        starts += 1;
        if (intent.kind === "create") dispatched.add(intent.jobId);
        const result = create === undefined ? { status: "uncertain" as const } : await create();
        if (result.status === "observed") onCreated?.(observedId ?? result.remoteId);
        return result;
      },
      read: async () => ({ status: "unavailable" }),
      cancel: async () => {
        cancels += 1;
        return { status: "requested" };
      },
    }),
  });
  const start = decodeProviderCloudRequest({
    kind: "start",
    jobId: id(2),
    threadId,
    instanceId: instance.id,
    modelId: "fixture-model",
    input: text,
    reviewedInputDigest: digest,
    cloudExecutionConsent: true,
  });
  return {
    service,
    start,
    jobs,
    starts: () => starts,
    cancels: () => cancels,
    revoke: () => {
      current = false;
    },
  };
}

describe("provider cloud tasks", () => {
  it("requires independent opt-in and journals uncertain submission so a retry or restart cannot create it again", async () => {
    const f = fixture();
    expect(await f.service.execute(windowId, f.start)).toEqual({
      status: "refused",
      reason: "opt-in-required",
    });
    expect(f.starts()).toBe(0);
    await f.service.execute(windowId, { kind: "opt-in", instanceId: instance.id, enabled: true });
    await f.service.execute(windowId, f.start);
    expect(f.starts()).toBe(1);
    expect(f.jobs.get(id(2))?.state).toBe("submission-uncertain");
    await f.service.execute(windowId, f.start);
    expect(f.starts()).toBe(1);
    f.revoke();
    expect(await f.service.execute(windowId, f.start)).toEqual({
      status: "refused",
      reason: "unauthorized",
    });
  });

  it("does not accept a compatible gateway or subscription identity as the official cloud API", () => {
    expect(supportsOpenAiCloudSessions(instance)).toBe(true);
    expect(
      supportsOpenAiCloudSessions(
        decodeProviderInstance({
          ...instance,
          configuration: { ...instance.configuration, baseUrl: "https://gateway.invalid/v1" },
        }),
      ),
    ).toBe(false);
    expect(
      supportsOpenAiCloudSessions(
        decodeProviderInstance({
          ...instance,
          configuration: { ...instance.configuration, authentication: "none" },
        }),
      ),
    ).toBe(false);
  });

  it("does not resurrect a purged input when a submitted remote session answers late", async () => {
    const pending = Promise.withResolvers<CloudSessionObservation>();
    const f = fixture(() => pending.promise);
    await f.service.execute(windowId, { kind: "opt-in", instanceId: instance.id, enabled: true });
    const result = f.service.execute(windowId, f.start);
    expect(f.starts()).toBe(1);
    f.jobs.clear();
    const remoteId = decodeProviderCloudRemoteId("sess_fixture");
    pending.resolve({
      status: "observed",
      remoteId,
      state: "running",
      output: "",
      truncated: false,
    });
    expect(await result).toEqual({ status: "refused", reason: "unauthorized" });
    expect(f.jobs.size).toBe(0);
    expect(f.cancels()).toBe(1);
  });

  it("requests cancellation and withholds output when owner admission is lost during create", async () => {
    const pending = Promise.withResolvers<CloudSessionObservation>();
    const f = fixture(() => pending.promise);
    await f.service.execute(windowId, { kind: "opt-in", instanceId: instance.id, enabled: true });
    const result = f.service.execute(windowId, f.start);
    f.revoke();
    pending.resolve({
      status: "observed",
      remoteId: decodeProviderCloudRemoteId("sess_fixture"),
      state: "running",
      output: "synthetic private output",
      truncated: false,
    });
    expect(await result).toEqual({ status: "refused", reason: "unauthorized" });
    expect(f.jobs.get(id(2))?.state).toBe("cancel-requested");
    expect(f.cancels()).toBe(1);
    await f.service.close();
  });

  it("never adopts a remote identity asserted only by an outside adapter", async () => {
    const f = fixture(
      async () => ({
        status: "observed",
        remoteId: decodeProviderCloudRemoteId("sess_other"),
        state: "completed",
        output: "forged output",
        truncated: false,
      }),
      decodeProviderCloudRemoteId("sess_owned"),
    );
    await f.service.execute(windowId, { kind: "opt-in", instanceId: instance.id, enabled: true });
    await f.service.execute(windowId, f.start);
    expect(f.jobs.get(id(2))?.remoteId).toBe("sess_owned");
    expect(f.jobs.get(id(2))?.output).toBe("");
    expect(f.jobs.get(id(2))?.state).toBe("running");
    await f.service.close();
  });

  it("requires a fresh reviewed job and exact prior version to acknowledge unknown remote work", async () => {
    const f = fixture();
    await f.service.execute(windowId, { kind: "opt-in", instanceId: instance.id, enabled: true });
    await f.service.execute(windowId, f.start);
    const prior = f.jobs.get(id(2));
    if (prior === undefined || f.start.kind !== "start")
      throw new Error("Unknown fixture job missing.");
    const next = { ...f.start, jobId: decodeProviderCloudJobId(id(8)) };
    expect(await f.service.execute(windowId, next)).toEqual({ status: "refused", reason: "busy" });
    expect(
      await f.service.execute(
        windowId,
        decodeProviderCloudRequest({
          ...next,
          acknowledgedUnknownJobs: [{ jobId: prior.id, expectedVersion: prior.version + 1 }],
        }),
      ),
    ).toEqual({ status: "refused", reason: "review-required" });
    await f.service.execute(
      windowId,
      decodeProviderCloudRequest({
        ...next,
        acknowledgedUnknownJobs: [{ jobId: prior.id, expectedVersion: prior.version }],
      }),
    );
    expect(f.starts()).toBe(2);
    expect(f.jobs.get(prior.id)?.state).toBe("submission-uncertain");
    expect(f.jobs.get(prior.id)?.uncertaintyAcknowledgedAt).toBeDefined();
    expect(f.jobs.get(id(8))?.uncertaintyAcknowledgedAt).toBeUndefined();
    expect(f.cancels()).toBe(0);
    expect(
      await f.service.execute(windowId, { ...next, jobId: decodeProviderCloudJobId(id(9)) }),
    ).toEqual({ status: "refused", reason: "busy" });
    expect(
      await f.service.execute(
        windowId,
        decodeProviderCloudRequest({
          ...next,
          jobId: id(9),
          acknowledgedUnknownJobs: [{ jobId: prior.id, expectedVersion: prior.version }],
        }),
      ),
    ).toEqual({ status: "refused", reason: "review-required" });
    expect(f.starts()).toBe(2);
  });
});
