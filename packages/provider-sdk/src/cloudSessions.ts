import type { ProviderInstance, ProviderInstanceId, ProviderModelId } from "@octant/contracts";
import type {
  ProviderCloudJobId,
  ProviderCloudRemoteId,
} from "@octant/contracts/provider-cloud-sessions";

export type CloudSessionObservation =
  | {
      readonly status: "observed";
      readonly remoteId: ProviderCloudRemoteId;
      readonly state: "running" | "completed" | "failed" | "cancelled";
      readonly output: string;
      readonly truncated: boolean;
    }
  | {
      readonly status: "unavailable" | "uncertain" | "unsupported";
    };

export interface CloudSessionAdapter {
  readonly create: (input: {
    readonly jobId: ProviderCloudJobId;
    readonly modelId: ProviderModelId;
    readonly text: string;
    readonly signal?: AbortSignal;
  }) => Promise<CloudSessionObservation>;
  readonly read: (
    remoteId: ProviderCloudRemoteId,
    signal?: AbortSignal,
  ) => Promise<CloudSessionObservation>;
  readonly cancel: (
    remoteId: ProviderCloudRemoteId,
    jobId: ProviderCloudJobId,
    signal?: AbortSignal,
  ) => Promise<{
    readonly status: "requested" | "uncertain" | "unavailable";
  }>;
}

export interface CloudSessionHttpRequest {
  readonly path: string;
  readonly method: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

/** The host owns endpoint admission, credentials, redirects, time and byte bounds. */
export interface CloudSessionPorts {
  readonly current: () => boolean;
  readonly request: (request: CloudSessionHttpRequest) => Promise<Response>;
}

/** An optional provider capability, independent of the local acquire/session path. */
export interface CloudSessionDriver {
  readonly protocol: "openai-agents-v1";
  readonly supports: (instance: ProviderInstance) => boolean;
  readonly create: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly ports: CloudSessionPorts;
  }) => CloudSessionAdapter;
}

export type CloudSessionIntent =
  | {
      readonly kind: "create";
      readonly jobId: ProviderCloudJobId;
      readonly modelId: ProviderModelId;
      readonly text: string;
    }
  | { readonly kind: "read"; readonly remoteId: ProviderCloudRemoteId }
  | {
      readonly kind: "cancel";
      readonly remoteId: ProviderCloudRemoteId;
      readonly jobId: ProviderCloudJobId;
    };

/** Known refusal before HTTP dispatch, distinct from an ambiguous lost provider reply. */
export class CloudSessionRequestRefused extends Error {
  constructor() {
    super("Provider cloud request refused before dispatch.");
  }
}
