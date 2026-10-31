import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  EventName,
  ToolEgressLaunchId,
  UtcTimestamp,
  type EventActor as EventActorValue,
  type ProviderExecutionPolicy,
  type ProviderFailure,
  type ToolEgressDecisionEntry,
  type ToolEgressLaunch,
} from "@octant/contracts";
import {
  MAX_SAFE_NETWORK_REFUSALS,
  RUNTIME_NETWORK_AGGREGATE,
  RUNTIME_NETWORK_EVENT_NAMES,
  type RuntimeNetworkLaunch,
  type RuntimeNetworkRuntime,
  type SafeNetworkRefusalView,
} from "@octant/contracts/safe-networks";
import {
  decideProviderRuntimeEgress,
  runtimeEgressPrivateAddressAllowed,
  type RuntimeEgressProjectRule,
} from "@octant/domain/safe-network-policy";
import type { ToolEgressRule } from "@octant/domain/tool-egress-policy";
import { Effect, Schema, type Scope } from "effect";
import {
  startToolEgressProxy,
  type ToolEgressProxyOptions,
  type ToolEgressRecordAppend,
} from "../harness/nativeHarnessEgressProxy";
import type { ToolEgressRecheckable } from "../harness/nativeHarnessEgressRules";
import type { Journal } from "../persistence/journal";
import { proxiedLaunchEnvironment } from "../process/proxiedNetworkEgress";
import type { EgressProxyEndpoint } from "../process/threadEgressPolicy";
import type { AcpProviderKind } from "../providers/acpProfiles";
import { providerRuntimeDomains } from "./providerRuntimeEndpoints";
import type { SafeNetworkStore } from "./safeNetworkStore";

/**
 * The network of a provider runtime launched below Full access.
 * Canonical: docs/architecture.md § Provider runtime network.
 *
 * Each launch gets its own listener on the host's egress proxy, the one
 * harness commands use, and its OS rules reach nothing but that listener. A
 * request passes when it names the provider's own endpoints, a loopback port
 * the launch serves Octant's tools on, a host the Project's egress rules
 * allow, or a place the person trusts in Settings › Access; anything else is
 * refused with the host named. At Auto an unlisted host goes to the reviewer
 * hook first, and the refusal stands when no reviewer can answer. Every
 * decision is journaled per host on the launch's own `runtime-network`
 * aggregate, and the refusals Safe networks lists come from those records.
 *
 * Inference and the runtime's own tools share the process, so a runtime's
 * bytes taint no thread here: its tool results are marked where the runtime
 * reports them, as before.
 */

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeLaunchId = Schema.decodeUnknownSync(ToolEgressLaunchId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

const REPLAY_BATCH = 500;
/** Refusals a person can act on by trusting a place. Token, limit, and audit refusals name no place. */
const TRUSTABLE_REFUSALS = new Set(["no-rule", "expired", "ip-literal", "private-destination"]);

export interface ProviderRuntimeNetworkStartInput {
  readonly runtime: RuntimeNetworkRuntime;
  readonly profileId?: AcpProviderKind;
  /** The folder the runtime works in; the Project that owns it supplies the rules and places. */
  readonly root: string;
  readonly executionPolicy: ProviderExecutionPolicy;
  /** Loopback ports the launch serves Octant's own tools on. */
  readonly loopbackPorts?: ReadonlyArray<number>;
  /** The launch's environment, read for the base URLs the person configured. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** The thread runs at Auto, so an unlisted host may go to the reviewer before it is refused. */
  readonly autoReview?: boolean;
  /**
   * `none` for a client that cannot send the launch token: Claude's sandbox
   * points its commands at a bare loopback port.
   */
  readonly authentication?: "launch-token" | "none";
}

export type ProviderRuntimeNetworkStart =
  /** Full access, or a host that does not route runtimes through the proxy: open network, as before. */
  | { readonly status: "open" }
  | {
      readonly status: "proxied";
      readonly endpoint: Extract<EgressProxyEndpoint, { readonly kind: "loopback" }>;
      /** The proxy variables the runtime's clients read; empty for an unauthenticated listener. */
      readonly environment: Readonly<Record<string, string>>;
      /** Closes the listener and every tunnel and records the launch's summary. */
      readonly release: () => Promise<void>;
    }
  /** No listener, or no record that the launch started: the runtime must not start. */
  | { readonly status: "refused"; readonly message: string };

export interface ProviderRuntimeNetworkPort {
  readonly start: (input: ProviderRuntimeNetworkStartInput) => Promise<ProviderRuntimeNetworkStart>;
}

/** What a reviewer said about one unlisted host. Only `allow` lets it through, and only for this launch. */
export type RuntimeNetworkReview =
  | { readonly answer: "allow"; readonly reviewer: string; readonly reason: string }
  | { readonly answer: "ask" | "deny" };

/**
 * The reviewer hook. Octant Shield's Judge plugs in here; until a reviewer is
 * composed, every unlisted host at Auto goes to the person as at Ask first.
 */
export interface RuntimeNetworkReviewer {
  readonly review: (request: {
    readonly host: string;
    readonly port: number;
    readonly runtime: RuntimeNetworkRuntime;
    readonly projectId: string | undefined;
  }) => Promise<RuntimeNetworkReview>;
}

export interface ProviderRuntimeNetworkOptions {
  readonly journal: Pick<Journal, "append" | "replayAggregateType">;
  readonly safeNetworks: Pick<SafeNetworkStore, "placesFor" | "onChanged">;
  /** The Project's live egress rules, read for every decision. */
  readonly projectRules: (projectId: string) => ReadonlyArray<ToolEgressRule>;
  /** Puts the proxy on the egress rules' recheck, so a revocation closes an idle tunnel at once. */
  readonly joinRecheck: (proxy: ToolEgressRecheckable) => () => void;
  /** The Project that owns a runtime's folder, or `undefined` for a folder no Project holds. */
  readonly resolveProject: (root: string) => string | undefined;
  readonly reviewer?: RuntimeNetworkReviewer;
  /** Whether this host routes runtimes through the proxy; macOS does today. */
  readonly enforced: boolean;
  readonly resolveAll?: ToolEgressProxyOptions["resolveAll"];
  readonly connect?: ToolEgressProxyOptions["connect"];
  readonly limits?: ToolEgressProxyOptions["limits"];
  readonly hostActor: EventActorValue;
  readonly uuid: () => string;
  readonly clock: () => string;
}

interface RefusalTally {
  host: string;
  port: number;
  runtime: RuntimeNetworkRuntime;
  requests: number;
  lastRefusedAt: string;
}

export class ProviderRuntimeNetwork implements ProviderRuntimeNetworkPort {
  readonly #options: ProviderRuntimeNetworkOptions;
  readonly #actor: EventActorValue;
  /** Recent refusals per Project (`""` for no Project), newest last. */
  readonly #refusals = new Map<string, Map<string, RefusalTally>>();
  /**
   * What each open launch's records already counted per destination: a batch
   * carries a destination's running totals, so only the growth is added.
   */
  readonly #counted = new Map<string, number>();

  constructor(options: ProviderRuntimeNetworkOptions) {
    this.#options = options;
    this.#actor = decodeActor(options.hostActor);
  }

  get enforced(): boolean {
    return this.#options.enforced;
  }

  /**
   * Rebuilds the recent refusals from the journal: each launch's start names
   * its Project and runtime, and its summary holds every destination it was
   * refused. A launch still open at a restart left only batches; its
   * refusals are not listed again.
   */
  load(): void {
    this.#refusals.clear();
    const launches = new Map<string, RuntimeNetworkLaunch>();
    let after = 0;
    for (;;) {
      const batch = this.#options.journal.replayAggregateType({
        aggregateType: RUNTIME_NETWORK_AGGREGATE,
        afterSequence: after,
        limit: REPLAY_BATCH,
        exceptEventName: RUNTIME_NETWORK_EVENT_NAMES.decisionsRecorded,
      });
      for (const envelope of batch) {
        after = envelope.globalSequence;
        const payload = envelope.payload as {
          readonly launch?: RuntimeNetworkLaunch;
          readonly launchId?: string;
          readonly entries?: ReadonlyArray<ToolEgressDecisionEntry>;
          readonly endedAt?: string;
        } | null;
        if (envelope.eventName === RUNTIME_NETWORK_EVENT_NAMES.launchStarted) {
          if (payload?.launch !== undefined)
            launches.set(String(payload.launch.launchId), payload.launch);
          continue;
        }
        if (envelope.eventName !== RUNTIME_NETWORK_EVENT_NAMES.launchSummarized) continue;
        const launch = launches.get(String(payload?.launchId));
        if (launch === undefined || payload?.endedAt === undefined) continue;
        this.#noteRefusals(launch, payload.entries ?? [], payload.endedAt);
        launches.delete(String(launch.launchId));
      }
      if (batch.length < REPLAY_BATCH) break;
    }
    this.#counted.clear();
  }

  /** The hosts a Project's runtimes (or, with no Project, the folder-less ones) were recently refused, newest first. */
  refusals(projectId: string | undefined): ReadonlyArray<SafeNetworkRefusalView> {
    const tallies = [...(this.#refusals.get(projectId ?? "")?.values() ?? [])];
    return tallies
      .toSorted((a, b) => b.lastRefusedAt.localeCompare(a.lastRefusedAt))
      .slice(0, MAX_SAFE_NETWORK_REFUSALS)
      .map((tally) => ({
        host: tally.host as SafeNetworkRefusalView["host"],
        port: tally.port,
        runtime: tally.runtime,
        requests: tally.requests,
        lastRefusedAt: decodeTimestamp(tally.lastRefusedAt),
      }));
  }

  async start(input: ProviderRuntimeNetworkStartInput): Promise<ProviderRuntimeNetworkStart> {
    if (input.executionPolicy === "full-access" || !this.#options.enforced)
      return { status: "open" };
    const refused = {
      status: "refused",
      message:
        "Octant could not start this runtime's network guard, so the runtime did not start. Try again, or restart Octant.",
    } as const;
    let projectId: string | undefined;
    try {
      projectId = this.#options.resolveProject(input.root);
    } catch {
      projectId = undefined;
    }
    let launch: RuntimeNetworkLaunch;
    let proxyLaunch: ToolEgressLaunch;
    try {
      const launchId = decodeLaunchId(this.#options.uuid());
      launch = {
        launchId,
        runtime: input.runtime,
        ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
        ...(projectId === undefined ? {} : { projectId: decodeAggregateId(projectId) }),
        executionPolicy: input.executionPolicy,
      };
      // The proxy's own launch shape names a thread and a Project. A runtime
      // serves a folder rather than one thread, so both carry the launch's
      // own id: the runtime decider never reads them, and the records below
      // journal `launch` above, never this.
      const placeholder = decodeAggregateId(String(launchId));
      proxyLaunch = { launchId, threadId: placeholder, projectId: placeholder };
    } catch {
      return refused;
    }
    const providerDomains = providerRuntimeDomains({
      runtime: input.runtime,
      profileId: input.profileId,
      environment: input.environment,
    });
    const loopbackPorts = input.loopbackPorts ?? [];
    const reviewerAllowed: Array<{ readonly host: string; readonly port: number }> = [];
    const projectRules = (): ReadonlyArray<ToolEgressRule> =>
      projectId === undefined ? [] : this.#options.projectRules(projectId);
    const runtimeRules = (): ReadonlyArray<RuntimeEgressProjectRule> =>
      projectRules().flatMap((rule) =>
        rule.scope.kind === "project" && String(rule.scope.projectId) === projectId
          ? [
              {
                id: rule.id,
                projectId: rule.scope.projectId,
                host: rule.host,
                port: rule.port,
                expiresAt: rule.expiresAt,
              },
            ]
          : [],
      );
    let version = 0;
    const record = (eventName: string, payload: unknown): ToolEgressRecordAppend => {
      try {
        this.#options.journal.append({
          aggregate: {
            aggregateType: RUNTIME_NETWORK_AGGREGATE,
            aggregateId: decodeAggregateId(String(launch.launchId)),
          },
          expectedVersion: decodeAggregateVersion(version),
          events: [
            {
              eventId: decodeEventId(this.#options.uuid()),
              eventName: decodeEventName(eventName),
              eventVersion: 1,
              correlationId: decodeCorrelationId(this.#options.uuid()),
              actor: this.#actor,
              occurredAt: decodeTimestamp(this.#options.clock()),
              payload,
            },
          ],
        });
      } catch {
        return { status: "unavailable" };
      }
      version += 1;
      return { status: "appended" };
    };
    const reviewer = input.autoReview === true ? this.#options.reviewer : undefined;
    const started = await startToolEgressProxy({
      launch: proxyLaunch,
      taint: () => ({ threadTainted: false, parentTainted: false }),
      // Read only to wake an idle tunnel when the Project rule it rides expires.
      rules: projectRules,
      clock: this.#options.clock,
      endpoint: { kind: "loopback" },
      ...(this.#options.resolveAll === undefined ? {} : { resolveAll: this.#options.resolveAll }),
      ...(this.#options.connect === undefined ? {} : { connect: this.#options.connect }),
      ...(this.#options.limits === undefined ? {} : { limits: this.#options.limits }),
      authentication: input.authentication ?? "launch-token",
      decision: {
        kind: "provider-runtime",
        decide: (destination) =>
          decideProviderRuntimeEgress({
            destination,
            providerDomains,
            launchLoopbackPorts: loopbackPorts,
            places: this.#options.safeNetworks.placesFor(projectId),
            projectRules: runtimeRules(),
            reviewerAllowed,
            now: this.#options.clock(),
          }),
        privateAddressAllowed: ({ address, port, by }) =>
          runtimeEgressPrivateAddressAllowed({
            address,
            port,
            by,
            places: this.#options.safeNetworks.placesFor(projectId),
            launchLoopbackPorts: loopbackPorts,
          }),
        ...(reviewer === undefined
          ? {}
          : {
              escalate: async (destination: { readonly host: string; readonly port: number }) => {
                const review = await reviewer.review({
                  ...destination,
                  runtime: input.runtime,
                  projectId,
                });
                if (review.answer !== "allow") return;
                // Journal first: an allowance whose record is not written lets nothing through.
                const appended = record(RUNTIME_NETWORK_EVENT_NAMES.reviewerAllowed, {
                  launchId: launch.launchId,
                  host: destination.host,
                  port: destination.port,
                  reviewer: review.reviewer.slice(0, 64) || "reviewer",
                  reason: review.reason.slice(0, 280),
                });
                if (appended.status === "appended") reviewerAllowed.push(destination);
              },
            }),
      },
      records: {
        launchStarted: async (payload) =>
          record(RUNTIME_NETWORK_EVENT_NAMES.launchStarted, {
            launch,
            startedAt: payload.startedAt,
          }),
        decisionsRecorded: async (payload) => {
          const appended = record(RUNTIME_NETWORK_EVENT_NAMES.decisionsRecorded, {
            launchId: launch.launchId,
            entries: payload.entries,
          });
          if (appended.status === "appended") {
            this.#noteRefusals(launch, payload.entries, this.#options.clock());
          }
          return appended;
        },
        launchSummarized: async (payload) => {
          const appended = record(RUNTIME_NETWORK_EVENT_NAMES.launchSummarized, {
            launchId: launch.launchId,
            endedAt: payload.endedAt,
            bytesSent: payload.bytesSent,
            bytesReceived: payload.bytesReceived,
            malformedRequests: payload.malformedRequests,
            entries: payload.entries,
            truncated: payload.truncated,
          });
          if (appended.status === "appended") {
            this.#noteRefusals(launch, payload.entries, this.#options.clock());
          }
          for (const key of this.#counted.keys()) {
            if (key.startsWith(`${String(launch.launchId)} `)) this.#counted.delete(key);
          }
          return appended;
        },
      },
    });
    if (started.status === "refused") return refused;
    const proxy = started.proxy;
    let leaveRecheck: () => void;
    let leavePlaces: () => void;
    try {
      leaveRecheck = this.#options.joinRecheck(proxy);
      leavePlaces = this.#options.safeNetworks.onChanged(() => proxy.recheck());
    } catch {
      await proxy.close().catch(() => undefined);
      return refused;
    }
    const endpoint = proxy.endpoint;
    if (endpoint.kind !== "loopback") {
      await proxy.close().catch(() => undefined);
      return refused;
    }
    const loopback = { kind: "loopback", port: endpoint.port } as const;
    let released: Promise<void> | undefined;
    return {
      status: "proxied",
      endpoint: loopback,
      environment:
        input.authentication === "none" ? {} : proxiedLaunchEnvironment(loopback, proxy.token),
      release: () => {
        released ??= (async () => {
          leaveRecheck();
          leavePlaces();
          await proxy.close().catch(() => undefined);
        })();
        return released;
      },
    };
  }

  #noteRefusals(
    launch: RuntimeNetworkLaunch,
    entries: ReadonlyArray<ToolEgressDecisionEntry>,
    at: string,
  ): void {
    const key = launch.projectId === undefined ? "" : String(launch.projectId);
    let tallies = this.#refusals.get(key);
    for (const entry of entries) {
      if (entry.decision !== "refused" || !TRUSTABLE_REFUSALS.has(entry.reason)) continue;
      if (entry.host === "invalid" || entry.host.endsWith(".invalid")) continue;
      if (tallies === undefined) {
        tallies = new Map();
        this.#refusals.set(key, tallies);
      }
      const id = `${entry.host}:${String(entry.port)}`;
      const countedKey = `${String(launch.launchId)} ${id}`;
      const growth = entry.requests - (this.#counted.get(countedKey) ?? 0);
      if (growth <= 0) continue;
      this.#counted.set(countedKey, entry.requests);
      const tally = tallies.get(id);
      if (tally === undefined) {
        tallies.set(id, {
          host: entry.host,
          port: entry.port,
          runtime: launch.runtime,
          requests: growth,
          lastRefusedAt: at,
        });
      } else {
        tally.requests += growth;
        tally.lastRefusedAt = at;
        tally.runtime = launch.runtime;
      }
      // Bounded: the oldest refusal goes first.
      if (tallies.size > MAX_SAFE_NETWORK_REFUSALS * 2) {
        const oldest = [...tallies.entries()].toSorted((a, b) =>
          a[1].lastRefusedAt.localeCompare(b[1].lastRefusedAt),
        )[0];
        if (oldest !== undefined) tallies.delete(oldest[0]);
      }
    }
  }
}

/** The network a proxied runtime launch takes into its confinement. */
export interface ProviderRuntimeProxiedNetwork {
  readonly endpoint: Extract<EgressProxyEndpoint, { readonly kind: "loopback" }>;
  readonly environment: Readonly<Record<string, string>>;
}

const GUARD_UNAVAILABLE =
  "Octant could not start this runtime's network guard, so the runtime did not start. Try again, or restart Octant.";

/**
 * Starts a runtime's network for the scope it is acquired in. `undefined`
 * means open network (Full access, no port composed, or a host that does not
 * route runtimes); a proxied network is released when the scope closes; a
 * guard that cannot start fails the launch rather than opening the network.
 */
export function acquireProviderRuntimeNetwork(
  port: ProviderRuntimeNetworkPort | undefined,
  input: ProviderRuntimeNetworkStartInput,
): Effect.Effect<ProviderRuntimeProxiedNetwork | undefined, ProviderFailure, Scope.Scope> {
  if (port === undefined) return Effect.succeed(undefined);
  return Effect.acquireRelease(
    Effect.promise(() =>
      port
        .start(input)
        .catch(
          (): ProviderRuntimeNetworkStart => ({ status: "refused", message: GUARD_UNAVAILABLE }),
        ),
    ),
    (started) =>
      started.status === "proxied" ? Effect.promise(() => started.release()) : Effect.void,
  ).pipe(
    Effect.flatMap((started) => {
      if (started.status === "open") return Effect.succeed(undefined);
      if (started.status === "refused") {
        const refusal: ProviderFailure = {
          category: "incompatible",
          message: started.message,
        } as ProviderFailure;
        return Effect.fail(refusal);
      }
      return Effect.succeed({ endpoint: started.endpoint, environment: started.environment });
    }),
  );
}
