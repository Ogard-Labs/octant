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
import { CODE_DEBUG_EGRESS_AGGREGATE, CODE_DEBUG_EVENT_NAMES } from "@octant/contracts/code-debug";
import { Schema } from "effect";
import type {
  ToolEgressProxyEndpointRequest,
  ToolEgressProxyOptions,
  ToolEgressRecordAppend,
} from "../harness/nativeHarnessEgressProxy";
import type { ToolEgressRules } from "../harness/nativeHarnessEgressRules";
import type { Journal } from "../persistence/journal";
import type { EgressProxyEndpoint } from "../process/threadEgressPolicy";

/**
 * The `proxied` network of one debug session below Full access. Canonical:
 * docs/design/language-services.md § Session network (decision DB5).
 *
 * The session belongs to one thread, so its connections are decided exactly
 * as that thread's harness commands are: on the thread's and its Project's
 * rules, with the thread's taint suspending standing rules, through the
 * proxy those commands use. What it is refused for becomes a proposal on the
 * thread's Network access list. Its launch records go to an aggregate of the
 * session's own, under the session's id, so the session's journaled start
 * names its configuration; the program's bytes reach no model, so it marks
 * no thread.
 */

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeLaunchId = Schema.decodeUnknownSync(ToolEgressLaunchId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export interface DebugSessionEgressScope {
  /** The session's id, which is also its egress launch's id. */
  readonly sessionId: string;
  readonly projectId: string;
  readonly threadId: string;
}

export type DebugSessionEgressStart =
  | {
      readonly status: "listening";
      readonly endpoint: EgressProxyEndpoint;
      readonly token: string;
      /** Closes the listener and its tunnels, records the summary, and raises proposals. */
      readonly close: () => Promise<void>;
    }
  /** No listener, or no record that the launch started: the session must not run. */
  | { readonly status: "refused" };

export interface DebugSessionEgress {
  readonly start: (scope: DebugSessionEgressScope) => Promise<DebugSessionEgressStart>;
}

export interface DebugSessionEgressOptions {
  readonly journal: Pick<Journal, "append">;
  readonly rules: Pick<ToolEgressRules, "startProgramLaunch">;
  readonly endpoint: ToolEgressProxyEndpointRequest;
  readonly resolveAll?: ToolEgressProxyOptions["resolveAll"];
  readonly connect?: ToolEgressProxyOptions["connect"];
  readonly hostActor: EventActorValue;
  readonly uuid: () => string;
  readonly clock: () => string;
}

export function createDebugSessionEgress(options: DebugSessionEgressOptions): DebugSessionEgress {
  const hostActor = decodeActor(options.hostActor);
  return {
    start: async (scope) => {
      let launch: ToolEgressLaunch;
      try {
        launch = {
          launchId: decodeLaunchId(scope.sessionId),
          threadId: decodeAggregateId(scope.threadId),
          projectId: decodeAggregateId(scope.projectId),
        };
      } catch {
        return { status: "refused" };
      }
      let version = 0;
      const record = async (
        eventName: string,
        payload: unknown,
      ): Promise<ToolEgressRecordAppend> => {
        try {
          options.journal.append({
            aggregate: {
              aggregateType: CODE_DEBUG_EGRESS_AGGREGATE,
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
      const started = await options.rules.startProgramLaunch({
        launch,
        endpoint: options.endpoint,
        ...(options.resolveAll === undefined ? {} : { resolveAll: options.resolveAll }),
        ...(options.connect === undefined ? {} : { connect: options.connect }),
        records: {
          launchStarted: (payload) => record(CODE_DEBUG_EVENT_NAMES.egressLaunchStarted, payload),
          decisionsRecorded: (payload) =>
            record(CODE_DEBUG_EVENT_NAMES.egressDecisionsRecorded, payload),
          launchSummarized: (payload) =>
            record(CODE_DEBUG_EVENT_NAMES.egressLaunchSummarized, payload),
        },
      });
      if (started.status !== "listening") return { status: "refused" };
      const { proxy, finish } = started.launch;
      return {
        status: "listening",
        endpoint:
          proxy.endpoint.kind === "loopback"
            ? { kind: "loopback", port: proxy.endpoint.port }
            : { kind: "unix-socket", path: proxy.endpoint.path },
        token: proxy.token,
        close: async () => {
          await finish().catch(() => undefined);
        },
      };
    },
  };
}
