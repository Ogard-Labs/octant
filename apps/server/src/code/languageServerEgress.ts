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
import {
  CODE_LANGUAGE_SERVER_EGRESS_AGGREGATE,
  CODE_LANGUAGE_SERVER_EVENT_NAMES,
} from "@octant/contracts/code-language";
import type { ToolEgressRule } from "@octant/domain/tool-egress-policy";
import { Schema } from "effect";
import {
  startToolEgressProxy,
  type ToolEgressProxyEndpointRequest,
  type ToolEgressRecordAppend,
} from "../harness/nativeHarnessEgressProxy";
import type { Journal } from "../persistence/journal";
import type { EgressProxyEndpoint } from "../process/threadEgressPolicy";

/**
 * The `proxied` network of one `repo-tooling` language server launch.
 * Canonical: docs/design/language-services.md § Repository tooling.
 *
 * The server serves a checkout, not a thread, so its connections are decided
 * on its Code Project's rules alone (D6): no thread rule applies, and the
 * Project's rules are suspended while any active thread on the checkout has
 * taken in outside content, because that thread's agent may have written the
 * tooling the server runs. Every decision goes through the proxy harness
 * commands use, and its records are the same payloads on an aggregate of the
 * launch's own, which the thread egress store never reads: a server's bytes
 * reach no model, so they taint no thread and propose no rule.
 */

const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeLaunchId = Schema.decodeUnknownSync(ToolEgressLaunchId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

/** Who the server serves: the Project whose rules apply, and the thread whose read started it. */
export interface LanguageServerEgressScope {
  readonly projectId: string;
  readonly threadId: string;
  /** Whether any active thread on the server's checkout has taken in outside content now. */
  readonly checkoutTainted: () => boolean;
}

export type LanguageServerEgressStart =
  | {
      readonly status: "listening";
      readonly endpoint: EgressProxyEndpoint;
      readonly token: string;
      /** Closes the listener and every tunnel, and records the launch's summary. */
      readonly close: () => Promise<void>;
    }
  /** No listener, or no record that the launch started: the server must not run. */
  | { readonly status: "refused" };

export interface LanguageServerEgress {
  readonly start: (scope: LanguageServerEgressScope) => Promise<LanguageServerEgressStart>;
}

export interface LanguageServerEgressOptions {
  readonly journal: Pick<Journal, "append">;
  /** The Project's live rules, read for every decision. */
  readonly projectRules: (projectId: string) => ReadonlyArray<ToolEgressRule>;
  readonly endpoint: ToolEgressProxyEndpointRequest;
  readonly hostActor: EventActorValue;
  readonly uuid: () => string;
  readonly clock: () => string;
}

export function createLanguageServerEgress(
  options: LanguageServerEgressOptions,
): LanguageServerEgress {
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
      const record = (eventName: string, payload: unknown): ToolEgressRecordAppend => {
        try {
          options.journal.append({
            aggregate: {
              aggregateType: CODE_LANGUAGE_SERVER_EGRESS_AGGREGATE,
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
      const started = await startToolEgressProxy({
        launch,
        // Read for every decision. A read that throws counts as tainted, which
        // suspends the Project's rules rather than applying them.
        taint: () => {
          try {
            return { threadTainted: scope.checkoutTainted(), parentTainted: false };
          } catch {
            return { threadTainted: true, parentTainted: false };
          }
        },
        rules: () => options.projectRules(scope.projectId),
        clock: options.clock,
        endpoint: options.endpoint,
        records: {
          launchStarted: async (payload) =>
            record(CODE_LANGUAGE_SERVER_EVENT_NAMES.egressLaunchStarted, payload),
          decisionsRecorded: async (payload) =>
            record(CODE_LANGUAGE_SERVER_EVENT_NAMES.egressDecisionsRecorded, payload),
          launchSummarized: async (payload) =>
            record(CODE_LANGUAGE_SERVER_EVENT_NAMES.egressLaunchSummarized, payload),
        },
      });
      if (started.status === "refused") return { status: "refused" };
      const proxy = started.proxy;
      const endpoint: EgressProxyEndpoint =
        proxy.endpoint.kind === "loopback"
          ? { kind: "loopback", port: proxy.endpoint.port }
          : { kind: "unix-socket", path: proxy.endpoint.path };
      return {
        status: "listening",
        endpoint,
        token: proxy.token,
        close: async () => {
          await proxy.close().catch(() => undefined);
        },
      };
    },
  };
}
