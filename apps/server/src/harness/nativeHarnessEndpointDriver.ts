import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { ProviderFailure, ProviderInstanceId, ProviderModelId } from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import type {
  HarnessEndpointDriver,
  HarnessEndpointTransport,
} from "@octant/provider-sdk/harness-endpoint";
import { Effect } from "effect";
import { sendWithEndpointRetry, type EndpointRetryOptions } from "../providers/endpointRetry";
import type { ProviderRuntimeRegistry } from "../providers/providerRuntimeRegistry";
import type { NativeHarnessEndpointHooks } from "./nativeHarnessEndpointRegistry";
import { createNativeHarnessConnection } from "./nativeHarnessLoop";
import {
  MemoryNativeHarnessTranscriptStore,
  type NativeHarnessTranscriptStore,
} from "./nativeHarnessTranscriptStore";

/** What the host lends a harness endpoint driver's sessions. */
export interface NativeHarnessEndpointHost {
  readonly instanceId: ProviderInstanceId;
  readonly runtimeRegistry: ProviderRuntimeRegistry;
  /** Where the sessions keep their conversation; shared so a later turn resumes an earlier one. */
  readonly transcripts?: NativeHarnessTranscriptStore;
  /** How requests are retried and where the lead goes when its model stays down. */
  readonly harness?: NativeHarnessEndpointHooks;
  readonly clock?: () => string;
  readonly correlationId?: () => string;
  readonly onConnectionReleased?: () => void;
}

/**
 * Runs a driver that supplies only an endpoint through the provider-sdk
 * harness endpoint port. The host owns what the driver cannot reach: the
 * agent loop and its journal, retries around each request, the registry
 * another instance's lead falls back through, and the instance's session
 * count. The driver keeps its probe, verification, and authentication.
 */
export function runOnNativeHarness(
  driver: HarnessEndpointDriver,
  host: NativeHarnessEndpointHost,
): ProviderDriver {
  const { harnessEndpoint, ...ownCapabilities } = driver;
  const clock = host.clock ?? (() => new Date().toISOString());
  const correlationId = host.correlationId ?? randomUUID;
  const transcripts = host.transcripts ?? new MemoryNativeHarnessTranscriptStore();
  const transport = retryingTransport(harnessEndpoint, host.harness?.retry);
  // The host refuses tools for a model it holds no Verify tools record for
  // before the driver is asked, so a driver whose own verdict admits every
  // turn still cannot hand Octant's tools to an unverified model.
  const admitTurn: HarnessEndpointDriver["harnessEndpoint"]["admitTurn"] = (turn, modelId) =>
    refusesUnverifiedTools(host, turn.tools.length, modelId) ??
    harnessEndpoint.admitTurn(turn, modelId);
  // Registered retrying, so a lead that falls back onto this endpoint gets the
  // same recovery its own sessions do.
  host.harness?.endpoints?.register(host.instanceId, { open: transport.open, admitTurn });

  return {
    ...ownCapabilities,
    conversationOwnership: "host",
    acquire: ({ instanceId, projectRoot, mode }) => {
      if (String(instanceId) !== String(host.instanceId)) {
        return Effect.fail(
          failure("invalid-configuration", "Provider instance does not match driver."),
        );
      }
      // The harness scopes its tools by mode, so a connection without one is refused.
      if (mode === undefined) {
        return Effect.fail(
          failure("invalid-configuration", "This provider requires an explicit product mode."),
        );
      }
      if (!isAbsolute(projectRoot) || resolve(projectRoot) !== projectRoot) {
        return Effect.fail(
          failure(
            "invalid-configuration",
            "Provider Project root must be an absolute normalized path.",
          ),
        );
      }
      return createNativeHarnessConnection({
        instanceId: host.instanceId,
        driverKind: driver.kind,
        projectRoot,
        mode,
        transport,
        transcripts,
        ...(host.harness?.leadFallback === undefined
          ? {}
          : { leadFallback: host.harness.leadFallback }),
        admitTurn,
        onSessionCountChange: (delta) =>
          host.runtimeRegistry.setActiveSessionCount(
            host.instanceId,
            Math.max(0, host.runtimeRegistry.activeSessionCount(host.instanceId) + delta),
          ),
        ...(host.onConnectionReleased === undefined
          ? {}
          : { onReleased: host.onConnectionReleased }),
        clock,
        correlationId,
      });
    },
  };
}

/** The endpoint with every request sent again, on the host's policy, while its failure usually passes. */
function retryingTransport(
  endpoint: HarnessEndpointTransport,
  retry: EndpointRetryOptions | undefined,
): HarnessEndpointTransport {
  return {
    open: async (modelId) => {
      const session = await endpoint.open(modelId);
      return {
        fits: (request) => session.fits(request),
        send: (request, stream) =>
          sendWithEndpointRetry({
            signal: stream.signal,
            onEvent: stream.onEvent,
            options: retry,
            // The host announces its own retries; a notice the driver streams
            // would report a retry the host never ran, or report one twice.
            attempt: (attempt) =>
              session.send(request, {
                signal: attempt.signal,
                onEvent: (event) => {
                  if (event.kind !== "retrying") attempt.onEvent(event);
                },
              }),
          }),
        release: () => session.release(),
      };
    },
  };
}

/**
 * Tools go only to a model a person verified on this instance. The record is
 * per model, as for every direct endpoint, so one verified model never
 * unlocks tools for its siblings.
 */
function refusesUnverifiedTools(
  host: NativeHarnessEndpointHost,
  toolCount: number,
  modelId: ProviderModelId,
): ProviderFailure | undefined {
  if (toolCount === 0) return undefined;
  const verified = host.runtimeRegistry
    .observedState(host.instanceId)
    ?.verifiedToolModelIds?.some((candidate) => String(candidate) === String(modelId));
  return verified === true
    ? undefined
    : failure("unsupported", "App-managed tools are unsupported.");
}

function failure(category: ProviderFailure["category"], message: string): ProviderFailure {
  return { category, message };
}
