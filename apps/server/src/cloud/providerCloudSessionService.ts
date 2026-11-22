import { createHash } from "node:crypto";
import {
  decodeUtcTimestamp,
  type CodeThreadId,
  type EventActor,
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
import type {
  ProviderCloudEventRecordPrincipal,
  ProviderCloudSessionStore,
} from "./providerCloudSessionStore";

export type ProviderCloudPrincipal =
  | { readonly kind: "local-window"; readonly scopeId: WindowId }
  | {
      readonly kind: "person-paired-device";
      readonly scopeId: WindowId;
      readonly deviceId: string;
      readonly sessionId: string;
      readonly credentialGeneration: number;
      readonly actor: EventActor;
    }
  | { readonly kind: "remote-device"; readonly scopeId: WindowId };

/** A `WindowId` alone denotes a local window; routes pass the full authenticated principal. */
export type ProviderCloudCaller = WindowId | ProviderCloudPrincipal;

export interface ProviderCloudAdapterCallOptions {
  readonly principalKind?: "local-window" | "person-paired-device";
  readonly onCredentialUnlockRequired?: () => void;
}

export interface ProviderCloudThreadContext {
  readonly threadId: CodeThreadId;
  readonly projectId: ProjectId;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly current: () => boolean;
  readonly canSubmit: () => boolean;
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
    options?: ProviderCloudAdapterCallOptions,
  ) => CloudSessionAdapter;
  readonly context: (
    windowId: WindowId,
    threadId: CodeThreadId,
    signal?: AbortSignal,
    principal?: ProviderCloudPrincipal,
  ) => ProviderCloudThreadContext | undefined;
  readonly canManageProvider: (windowId: WindowId, principal?: ProviderCloudPrincipal) => boolean;
  readonly now: () => string;
}

function normalizeCaller(caller: ProviderCloudCaller): ProviderCloudPrincipal {
  return typeof caller === "string" ? { kind: "local-window", scopeId: caller } : caller;
}

function recordPrincipalOf(
  principal: ProviderCloudPrincipal,
): ProviderCloudEventRecordPrincipal | undefined {
  if (principal.kind === "person-paired-device") {
    return {
      kind: "person-paired-device",
      credentialGeneration: principal.credentialGeneration,
      actor: principal.actor,
    };
  }
  if (principal.kind === "local-window") return { kind: "local-window" };
  return undefined;
}

const terminal = (state: ProviderCloudJob["state"]) =>
  ["completed", "failed", "cancelled", "unavailable"].includes(state);

export class ProviderCloudSessionService {
  readonly #input: ProviderCloudSessionServiceInput;
  readonly #busy = new Set<string>();
  readonly #watchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #requests = new Set<Promise<ProviderCloudResponse>>();
  #closed = false;
  #closing: Promise<void> | undefined;

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

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    for (const timer of this.#watchdogs.values()) clearTimeout(timer);
    this.#watchdogs.clear();
    this.#closing = this.#closeActive();
    return this.#closing;
  }

  async #closeActive(): Promise<void> {
    // A dispatched create can return an identity after shutdown starts. Keep
    // the journal alive until its receipt and cancellation path have settled.
    await Promise.allSettled(this.#requests);
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
    caller: ProviderCloudCaller,
    command: ProviderCloudRequest,
    signal?: AbortSignal,
    callerIsCurrent: () => boolean = () => true,
  ): Promise<ProviderCloudResponse> {
    if (this.#closed) return { status: "refused", reason: "unavailable" };
    const request = this.#execute(normalizeCaller(caller), command, signal, callerIsCurrent);
    this.#requests.add(request);
    try {
      return await request;
    } catch {
      return { status: "refused", reason: "journal-unavailable" };
    } finally {
      this.#requests.delete(request);
    }
  }

  async #execute(
    principal: ProviderCloudPrincipal,
    command: ProviderCloudRequest,
    signal: AbortSignal | undefined,
    callerIsCurrent: () => boolean,
  ): Promise<ProviderCloudResponse> {
    const input = this.#input;
    // A hub-introduced device, an agent grant or any unproved device session
    // never reads, opts in, spends or cancels cloud jobs.
    if (principal.kind === "remote-device" || !callerIsCurrent()) {
      return { status: "refused", reason: "unauthorized" };
    }
    const windowId = principal.scopeId;
    const recordPrincipal = recordPrincipalOf(principal);
    if (command.kind === "profiles")
      return input.canManageProvider(windowId, principal)
        ? this.#view()
        : { status: "refused", reason: "unauthorized" };
    if (command.kind === "opt-in") {
      if (!input.canManageProvider(windowId, principal))
        return { status: "refused", reason: "unauthorized" };
      const instance = input
        .instances()
        .find((item) => String(item.id) === String(command.instanceId));
      if (instance === undefined || (command.enabled && !input.supports(instance)))
        return { status: "refused", reason: "unavailable" };
      input.store.setEnabled(instance.id, command.enabled, recordPrincipal);
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
      return callerIsCurrent() ? this.#view() : { status: "refused", reason: "unauthorized" };
    }
    const existing =
      command.kind === "read" || command.kind === "cancel"
        ? input.store.get(command.jobId)
        : undefined;
    const threadId =
      command.kind === "start" || command.kind === "list" ? command.threadId : existing?.threadId;
    if (threadId === undefined) return { status: "refused", reason: "unknown-job" };
    const owned = input.context(windowId, threadId, signal, principal);
    if (owned === undefined || !callerIsCurrent() || !owned.current())
      return { status: "refused", reason: "unauthorized" };
    const context = { ...owned, current: () => callerIsCurrent() && owned.current() };
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
        principalKind: principal.kind,
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
          input.store.put(
            {
              ...unknown,
              uncertaintyAcknowledgedAt: decodeUtcTimestamp(input.now()),
              updatedAt: decodeUtcTimestamp(input.now()),
            },
            recordPrincipal,
          );
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
        recordPrincipal,
      );
      if (!context.current() || !context.canSubmit() || !input.store.enabled(instance.id)) {
        input.store.put({
          ...job,
          state: "unavailable",
          updatedAt: decodeUtcTimestamp(input.now()),
        });
        return { status: "refused", reason: "unauthorized" };
      }
      let observedRemoteId: ProviderCloudRemoteId | undefined;
      let credentialUnlockRequired = false;
      const result = await input
        .adapter(
          instance,
          { kind: "create", jobId: job.id, modelId: job.modelId, text: job.input },
          () =>
            context.current() &&
            context.canSubmit() &&
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
          {
            principalKind: principal.kind,
            onCredentialUnlockRequired: () => {
              credentialUnlockRequired = true;
            },
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
      if (
        credentialUnlockRequired &&
        observedRemoteId === undefined &&
        !input.store.hasCreateDispatch(job.id)
      ) {
        return { status: "refused", reason: "credential-unlock-needs-this-computer" };
      }
      const observed = input.store.get(job.id);
      if (observed !== undefined) {
        if (
          this.#closed ||
          !input.store.enabled(instance.id) ||
          !context.current() ||
          !context.canSubmit() ||
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
      let credentialUnlockRequired = false;
      const adapterOptions: ProviderCloudAdapterCallOptions = {
        principalKind: principal.kind,
        onCredentialUnlockRequired: () => {
          credentialUnlockRequired = true;
        },
      };
      if (command.kind === "cancel") {
        await this.#cancel(existing, instance, recordPrincipal, adapterOptions);
        if (credentialUnlockRequired)
          return { status: "refused", reason: "credential-unlock-needs-this-computer" };
      } else if (!terminal(existing.state) && existing.remoteId !== undefined) {
        const result = await input
          .adapter(
            instance,
            { kind: "read", remoteId: existing.remoteId },
            context.current,
            undefined,
            adapterOptions,
          )
          .read(existing.remoteId);
        if (credentialUnlockRequired)
          return { status: "refused", reason: "credential-unlock-needs-this-computer" };
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

  async #cancel(
    job: ProviderCloudJob,
    instance: ProviderInstance,
    person?: ProviderCloudEventRecordPrincipal,
    adapterOptions?: ProviderCloudAdapterCallOptions,
  ): Promise<void> {
    const latest = this.#input.store.get(job.id);
    if (latest === undefined) {
      if (job.remoteId !== undefined)
        await this.#input
          .adapter(
            instance,
            { kind: "cancel", remoteId: job.remoteId, jobId: job.id },
            undefined,
            undefined,
            adapterOptions,
          )
          .cancel(job.remoteId, job.id);
      return;
    }
    if (terminal(latest.state) || latest.remoteId === undefined) return;
    this.#input.store.put(
      {
        ...latest,
        state: "cancel-requested",
        updatedAt: decodeUtcTimestamp(this.#input.now()),
      },
      person,
    );
    await this.#input
      .adapter(
        instance,
        { kind: "cancel", remoteId: latest.remoteId, jobId: latest.id },
        undefined,
        undefined,
        adapterOptions,
      )
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
