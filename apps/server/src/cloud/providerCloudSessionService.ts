import { createHash } from "node:crypto";
import {
  decodeUtcTimestamp,
  type CodeThreadId,
  type ProjectId,
  type ProviderExecutionPolicy,
  type ProviderInstance,
  type ProviderModelId,
  type WindowId,
} from "@octant/contracts";
import {
  decodeProviderCloudInputDigest,
  decodeProviderCloudJob,
  type ProviderCloudJob,
  type ProviderCloudRequest,
  type ProviderCloudResponse,
  type ProviderCloudRemoteId,
} from "@octant/contracts/provider-cloud-sessions";
import { decideProviderCloudSubmission } from "@octant/domain";
import type { CloudSessionAdapter, CloudSessionIntent } from "@octant/provider-sdk/cloud-sessions";
import type { ProviderCloudSessionStore } from "./providerCloudSessionStore";

export interface ProviderCloudThreadContext {
  readonly threadId: CodeThreadId;
  readonly projectId: ProjectId;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly current: () => boolean;
  readonly requiresUnsupportedBound: () => boolean;
}

export interface ProviderCloudSessionServiceInput {
  readonly store: Pick<
    ProviderCloudSessionStore,
    "enabled" | "setEnabled" | "get" | "put" | "list" | "active" | "hasCreateDispatch"
  >;
  readonly instances: () => ReadonlyArray<ProviderInstance>;
  readonly supports: (instance: ProviderInstance) => boolean;
  readonly models: (instance: ProviderInstance) => ReadonlyArray<ProviderModelId>;
  readonly adapter: (
    instance: ProviderInstance,
    intent: CloudSessionIntent,
    admission?: () => boolean,
    onCreated?: (remoteId: ProviderCloudRemoteId) => void,
  ) => CloudSessionAdapter;
  readonly context: (
    windowId: WindowId,
    threadId: CodeThreadId,
    signal?: AbortSignal,
  ) => ProviderCloudThreadContext | undefined;
  readonly canManageProvider: (windowId: WindowId) => boolean;
  readonly now: () => string;
}

const terminal = (state: ProviderCloudJob["state"]) =>
  ["completed", "failed", "cancelled", "unavailable"].includes(state);

export class ProviderCloudSessionService {
  readonly #input: ProviderCloudSessionServiceInput;
  readonly #busy = new Set<string>();
  readonly #watchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  #closed = false;

  constructor(input: ProviderCloudSessionServiceInput) {
    this.#input = input;
    for (const job of input.store.active()) {
      if (job.state === "submitting")
        input.store.put({
          ...job,
          state: "submission-uncertain",
          updatedAt: decodeUtcTimestamp(input.now()),
        });
      else this.#watch(job);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const timer of this.#watchdogs.values()) clearTimeout(timer);
    this.#watchdogs.clear();
    await Promise.allSettled(
      this.#input.store.active().map(async (job) => {
        const instance = this.#input
          .instances()
          .find((item) => String(item.id) === String(job.instanceId));
        if (instance !== undefined) await this.#cancel(job, instance);
      }),
    );
  }

  async execute(
    windowId: WindowId,
    command: ProviderCloudRequest,
    signal?: AbortSignal,
  ): Promise<ProviderCloudResponse> {
    try {
      return await this.#execute(windowId, command, signal);
    } catch {
      return { status: "refused", reason: "journal-unavailable" };
    }
  }

  async #execute(
    windowId: WindowId,
    command: ProviderCloudRequest,
    signal?: AbortSignal,
  ): Promise<ProviderCloudResponse> {
    const input = this.#input;
    if (command.kind === "profiles")
      return input.canManageProvider(windowId)
        ? this.#view()
        : { status: "refused", reason: "unauthorized" };
    if (command.kind === "opt-in") {
      if (!input.canManageProvider(windowId)) return { status: "refused", reason: "unauthorized" };
      const instance = input
        .instances()
        .find((item) => String(item.id) === String(command.instanceId));
      if (instance === undefined || (command.enabled && !input.supports(instance)))
        return { status: "refused", reason: "unavailable" };
      input.store.setEnabled(instance.id, command.enabled);
      if (!command.enabled) {
        for (const job of input.store.active()) {
          if (
            String(job.instanceId) === String(instance.id) &&
            !terminal(job.state) &&
            job.remoteId !== undefined
          ) {
            await this.#cancel(job, instance);
          }
        }
      }
      return this.#view();
    }
    const existing =
      command.kind === "read" || command.kind === "cancel"
        ? input.store.get(command.jobId)
        : undefined;
    const threadId =
      command.kind === "start" || command.kind === "list" ? command.threadId : existing?.threadId;
    if (threadId === undefined) return { status: "refused", reason: "unknown-job" };
    const context = input.context(windowId, threadId, signal);
    if (context === undefined || !context.current())
      return { status: "refused", reason: "unauthorized" };
    if (command.kind === "list") return this.#view(threadId);
    const instanceId = command.kind === "start" ? command.instanceId : existing?.instanceId;
    const instance = input.instances().find((item) => String(item.id) === String(instanceId));
    if (instance === undefined || !input.supports(instance))
      return { status: "refused", reason: "unavailable" };
    if (command.kind === "start") {
      if (this.#closed) return { status: "refused", reason: "unavailable" };
      if (!input.models(instance).some((id) => String(id) === String(command.modelId)))
        return { status: "refused", reason: "unavailable" };
      const digest = decodeProviderCloudInputDigest(
        createHash("sha256").update(command.input).digest("hex"),
      );
      const decision = decideProviderCloudSubmission({
        principalKind: "local-window",
        personOwned: true,
        mode: "code",
        executionPolicy: context.executionPolicy,
        supported: true,
        enabled: input.store.enabled(instance.id),
        current: context.current(),
        inputDigest: digest,
        reviewedInputDigest: command.reviewedInputDigest,
        cloudExecutionConsent: command.cloudExecutionConsent,
        requiresUnsupportedBound: context.requiresUnsupportedBound(),
      });
      if (decision.status === "refused") return decision;
      const prior = input.store.get(command.jobId);
      if (prior !== undefined) {
        if (
          String(prior.threadId) !== String(threadId) ||
          String(prior.projectId) !== String(context.projectId) ||
          prior.inputDigest !== digest ||
          String(prior.instanceId) !== String(instance.id) ||
          String(prior.modelId) !== String(command.modelId)
        )
          return { status: "refused", reason: "review-required" };
        return this.#view(threadId);
      }
      for (const acknowledgement of command.acknowledgedUnknownJobs ?? []) {
        const unknown = input.store.get(acknowledgement.jobId);
        if (
          unknown === undefined ||
          unknown.version !== acknowledgement.expectedVersion ||
          unknown.state !== "submission-uncertain" ||
          unknown.remoteId !== undefined ||
          String(unknown.threadId) !== String(threadId) ||
          String(unknown.projectId) !== String(context.projectId)
        )
          return { status: "refused", reason: "review-required" };
      }
      for (const acknowledgement of command.acknowledgedUnknownJobs ?? []) {
        const unknown = input.store.get(acknowledgement.jobId);
        if (unknown !== undefined)
          input.store.put({
            ...unknown,
            uncertaintyAcknowledgedAt: decodeUtcTimestamp(input.now()),
            updatedAt: decodeUtcTimestamp(input.now()),
          });
      }
      const active = input.store.active();
      if (active.length >= 16 || active.some((job) => String(job.threadId) === String(threadId)))
        return { status: "refused", reason: "busy" };
      const now = decodeUtcTimestamp(input.now());
      const job = input.store.put(
        decodeProviderCloudJob({
          id: command.jobId,
          version: 1,
          threadId,
          projectId: context.projectId,
          instanceId: instance.id,
          modelId: command.modelId,
          input: command.input,
          inputDigest: digest,
          state: "submitting",
          output: "",
          truncated: false,
          createdAt: now,
          updatedAt: now,
        }),
      );
      if (!context.current() || !input.store.enabled(instance.id)) {
        input.store.put({
          ...job,
          state: "unavailable",
          updatedAt: decodeUtcTimestamp(input.now()),
        });
        return { status: "refused", reason: "unauthorized" };
      }
      let observedRemoteId: ProviderCloudRemoteId | undefined;
      const result = await input
        .adapter(
          instance,
          { kind: "create", jobId: job.id, modelId: job.modelId, text: job.input },
          () =>
            context.current() &&
            !context.requiresUnsupportedBound() &&
            input.store.enabled(instance.id) &&
            input
              .instances()
              .some(
                (current) =>
                  String(current.id) === String(instance.id) &&
                  current.version === instance.version &&
                  input.supports(current),
              ),
          (remoteId) => {
            observedRemoteId = remoteId;
            const latest = input.store.get(job.id);
            if (latest !== undefined)
              input.store.put({
                ...latest,
                remoteId,
                state: "running",
                updatedAt: decodeUtcTimestamp(input.now()),
              });
          },
        )
        .create({ jobId: job.id, modelId: job.modelId, text: job.input });
      if (input.store.get(job.id) === undefined) {
        if (observedRemoteId !== undefined)
          await input
            .adapter(instance, { kind: "cancel", remoteId: observedRemoteId, jobId: job.id })
            .cancel(observedRemoteId, job.id);
        return { status: "refused", reason: "unauthorized" };
      }
      const latest = input.store.get(job.id);
      if (latest === undefined) return { status: "refused", reason: "unauthorized" };
      try {
        // Creation proves a session identity, never a terminal turn or a result.
        // A concurrent read/cancel may already have advanced this host-owned job.
        input.store.put(
          observedRemoteId !== undefined
            ? {
                ...latest,
                remoteId: observedRemoteId,
                state: latest.state === "submitting" ? "running" : latest.state,
                updatedAt: decodeUtcTimestamp(input.now()),
              }
            : {
                ...latest,
                state:
                  result.status === "unavailable" ||
                  result.status === "unsupported" ||
                  !input.store.hasCreateDispatch(job.id)
                    ? "unavailable"
                    : "submission-uncertain",
                updatedAt: decodeUtcTimestamp(input.now()),
              },
        );
      } catch {
        if (observedRemoteId !== undefined)
          await input
            .adapter(instance, { kind: "cancel", remoteId: observedRemoteId, jobId: job.id })
            .cancel(observedRemoteId, job.id);
        return { status: "refused", reason: "journal-unavailable" };
      }
      const observed = input.store.get(job.id);
      if (observed !== undefined) {
        if (
          this.#closed ||
          !input.store.enabled(instance.id) ||
          !context.current() ||
          context.requiresUnsupportedBound()
        )
          await this.#cancel(observed, instance);
        else this.#watch(observed);
      }
      if (!context.current()) return { status: "refused", reason: "unauthorized" };
      return this.#view(threadId);
    }
    if (existing === undefined) return { status: "refused", reason: "unknown-job" };
    if (String(existing.projectId) !== String(context.projectId))
      return { status: "refused", reason: "unauthorized" };
    if (this.#busy.has(existing.id)) return { status: "refused", reason: "busy" };
    this.#busy.add(existing.id);
    try {
      if (command.kind === "cancel") await this.#cancel(existing, instance);
      else if (!terminal(existing.state) && existing.remoteId !== undefined) {
        const result = await input
          .adapter(instance, { kind: "read", remoteId: existing.remoteId }, context.current)
          .read(existing.remoteId);
        const latest = input.store.get(existing.id);
        if (latest === undefined) return { status: "refused", reason: "unauthorized" };
        if (result.status === "observed") {
          if (String(result.remoteId) !== String(existing.remoteId))
            return { status: "refused", reason: "unavailable" };
          input.store.put({
            ...latest,
            state:
              latest.state === "cancel-requested" && result.state === "running"
                ? "cancel-requested"
                : result.state,
            output: result.output,
            truncated: result.truncated,
            updatedAt: decodeUtcTimestamp(input.now()),
          });
          if (terminal(result.state)) {
            const timer = this.#watchdogs.get(existing.id);
            if (timer !== undefined) clearTimeout(timer);
            this.#watchdogs.delete(existing.id);
          }
        } else if (result.status === "unsupported") await this.#cancel(existing, instance);
        else return { status: "refused", reason: "unavailable" };
      }
    } finally {
      this.#busy.delete(existing.id);
    }
    if (!context.current()) return { status: "refused", reason: "unauthorized" };
    return this.#view(threadId);
  }

  async #cancel(job: ProviderCloudJob, instance: ProviderInstance): Promise<void> {
    const latest = this.#input.store.get(job.id);
    if (latest === undefined) {
      if (job.remoteId !== undefined)
        await this.#input
          .adapter(instance, { kind: "cancel", remoteId: job.remoteId, jobId: job.id })
          .cancel(job.remoteId, job.id);
      return;
    }
    if (terminal(latest.state) || latest.remoteId === undefined) return;
    this.#input.store.put({
      ...latest,
      state: "cancel-requested",
      updatedAt: decodeUtcTimestamp(this.#input.now()),
    });
    await this.#input
      .adapter(instance, { kind: "cancel", remoteId: latest.remoteId, jobId: latest.id })
      .cancel(latest.remoteId, latest.id);
  }

  #watch(job: ProviderCloudJob): void {
    if (terminal(job.state) || job.remoteId === undefined || this.#watchdogs.has(job.id)) return;
    const delay = Math.max(0, Date.parse(job.createdAt) + 600_000 - Date.parse(this.#input.now()));
    const timer = setTimeout(
      () => {
        this.#watchdogs.delete(job.id);
        const current = this.#input.store.get(job.id);
        const instance = this.#input
          .instances()
          .find((item) => String(item.id) === String(job.instanceId));
        if (current !== undefined && instance !== undefined && !terminal(current.state)) {
          void this.#cancel(current, instance).catch(() => undefined);
        }
      },
      Math.min(delay, 600_000),
    );
    timer.unref?.();
    this.#watchdogs.set(job.id, timer);
  }

  #view(threadId?: CodeThreadId): ProviderCloudResponse {
    return {
      status: "ready",
      profiles: this.#input
        .instances()
        .slice(0, 128)
        .map((instance) => ({
          instanceId: instance.id,
          label: instance.displayName,
          supported: this.#input.supports(instance),
          enabled: this.#input.store.enabled(instance.id),
          models: this.#input.models(instance),
        })),
      jobs: threadId === undefined ? [] : this.#input.store.list(threadId),
    };
  }
}
