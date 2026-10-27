import type { Duplex } from "node:stream";
import { Schema } from "effect";
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
  type ToolEgressLaunch,
} from "@octant/contracts";
import type { ProviderInstanceId } from "@octant/contracts/providers";
import type { SshConnectionId, SshTargetId } from "@octant/contracts/ssh-target";
import {
  PROVIDER_RUNTIME_EGRESS_AGGREGATE,
  PROVIDER_RUNTIME_EGRESS_EVENT_NAMES,
  type ProviderRuntimeEgressDecisionsRecorded,
  type ProviderRuntimeEgressLaunchStarted,
  type ProviderRuntimeEgressLaunchSummarized,
} from "@octant/contracts/ssh-target-events";
import {
  startToolEgressProxy,
  type ToolEgressProxyEndpoint,
  type ToolEgressProxyEndpointRequest,
  type ToolEgressRecordAppend,
} from "../harness/nativeHarnessEgressProxy";
import type { Journal } from "../persistence/journal";

/**
 * The network of a provider runtime placed on an SSH target: a proxy of its
 * own on this host for each launch, deciding every connection under the
 * runtime rule, with its launch and decisions journaled. Canonical:
 * docs/design/remote-ssh-environments.md § Runtime placement (R3).
 *
 * The runtime rule allows any public name and no private, loopback, or
 * link-local answer, so the target's own network and a cloud machine's
 * metadata service stay out of reach while inference never waits on a rule.
 * Thread and Project rules do not apply and nothing is proposed. The records
 * are the proxy's own payloads on an aggregate of the launch's, naming the
 * thread, provider instance, and target, and without a thread's taint: the
 * runtime's traffic is its own, as locally, and taints no thread. A launch
 * whose start cannot be recorded gets no proxy and does not run.
 */

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeLaunchId = Schema.decodeUnknownSync(ToolEgressLaunchId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

/** Whose runtime the launch is, and how its connections reach the target. */
export interface ProviderRuntimeEgressScope {
  readonly threadId: string;
  readonly projectId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly targetId: SshTargetId;
  readonly connectionId: SshConnectionId;
  /** Every address a name resolves to, asked of the target. */
  readonly resolveAll: (host: string) => Promise<ReadonlyArray<string>>;
  /** A connection the target opens to an address the proxy checked. */
  readonly connect: (destination: { readonly address: string; readonly port: number }) => Duplex;
}

export type ProviderRuntimeEgressStart =
  | {
      readonly status: "listening";
      readonly endpoint: ToolEgressProxyEndpoint;
      /** The launch token the runtime's proxy variables carry; never journaled. */
      readonly token: string;
      /** Closes the listener and every tunnel, and records the launch's summary. */
      readonly close: () => Promise<void>;
    }
  /** No listener, or no record that the launch started: the runtime must not run. */
  | { readonly status: "refused" };

export interface ProviderRuntimeEgress {
  readonly start: (scope: ProviderRuntimeEgressScope) => Promise<ProviderRuntimeEgressStart>;
}

export interface ProviderRuntimeEgressOptions {
  readonly journal: Pick<Journal, "append">;
  readonly endpoint: ToolEgressProxyEndpointRequest;
  readonly hostActor: EventActorValue;
  readonly uuid: () => string;
  readonly clock: () => string;
}

export function createProviderRuntimeEgress(
  options: ProviderRuntimeEgressOptions,
): ProviderRuntimeEgress {
  const hostActor = decodeActor(options.hostActor);
  return {
    start: async (scope) => {
      let launch: ToolEgressLaunch;
      try {
        launch = {
          launchId: decodeLaunchId(options.uuid()),
          threadId: decodeAggregateId(scope.threadId),
          projectId: decodeAggregateId(scope.projectId),
        };
      } catch {
        return { status: "refused" };
      }
      let version = 0;
      const record = (
        eventName: string,
        payload:
          | ProviderRuntimeEgressLaunchStarted
          | ProviderRuntimeEgressDecisionsRecorded
          | ProviderRuntimeEgressLaunchSummarized,
      ): ToolEgressRecordAppend => {
        try {
          options.journal.append({
            aggregate: {
              aggregateType: PROVIDER_RUNTIME_EGRESS_AGGREGATE,
              aggregateId: decodeAggregateId(String(launch.launchId)),
            },
            expectedVersion: decodeAggregateVersion(version),
            events: [
              {
                eventId: decodeEventId(options.uuid()),
                eventName: decodeEventName(eventName),
                eventVersion: 1,
                correlationId: decodeCorrelationId(options.uuid()),
                actor: hostActor,
                occurredAt: decodeTimestamp(options.clock()),
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
      const names = PROVIDER_RUNTIME_EGRESS_EVENT_NAMES;
      const started = await startToolEgressProxy({
        launch,
        decision: "public-destinations",
        // The runtime rule reads neither taint nor rules.
        taint: () => ({ threadTainted: false, parentTainted: false }),
        rules: () => [],
        clock: options.clock,
        endpoint: options.endpoint,
        resolveAll: scope.resolveAll,
        connect: scope.connect,
        records: {
          launchStarted: async (payload) =>
            record(names.launchStarted, {
              launch: payload.launch,
              providerInstanceId: scope.providerInstanceId,
              targetId: scope.targetId,
              connectionId: scope.connectionId,
              startedAt: payload.startedAt,
            }),
          decisionsRecorded: async (payload) =>
            record(names.decisionsRecorded, { launch: payload.launch, entries: payload.entries }),
          launchSummarized: async (payload) =>
            record(names.launchSummarized, {
              launch: payload.launch,
              endedAt: payload.endedAt,
              bytesSent: payload.bytesSent,
              bytesReceived: payload.bytesReceived,
              malformedRequests: payload.malformedRequests,
              entries: payload.entries,
              truncated: payload.truncated,
            }),
        },
      });
      if (started.status === "refused") return { status: "refused" };
      const proxy = started.proxy;
      return {
        status: "listening",
        endpoint: proxy.endpoint,
        token: proxy.token,
        close: async () => {
          await proxy.close().catch(() => undefined);
        },
      };
    },
  };
}
