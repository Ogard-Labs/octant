import type { CredentialOperation } from "./credentialRequest";
import type {
  IntegrationCommand,
  IntegrationCredentialRequestResult,
  IntegrationObservation,
} from "@octant/contracts/integration";

/**
 * Typed server port for the Integration plugin kind.
 *
 * Integration plugins run inside the host process and receive only the host
 * ports their declared capabilities allow. These types are the wire contract
 * between a plugin's runtime and the host.
 */
export * from "@octant/contracts/integration";

/** Read-only contributed sources. Discovery and event data never grant execution authority. */
export interface IntegrationEventSourceProvider {
  readonly choices: () => Promise<
    ReadonlyArray<import("@octant/contracts").AutomationEventSourceChoice>
  >;
  readonly bind: (
    selection: import("@octant/contracts").AutomationIntegrationEventTrigger,
    signal: AbortSignal,
  ) => Promise<IntegrationEventSource | undefined>;
}

export interface IntegrationEventSource {
  readonly identity: string;
  readonly label: string;
  /** Assignment sets detect absent-to-present transitions; append sources retain seen event ids. */
  readonly semantics: "assignment-set" | "append";
  readonly current: () => boolean;
  readonly read: (signal: AbortSignal) => Promise<
    | {
        readonly kind: "complete";
        readonly events: ReadonlyArray<import("@octant/contracts").AutomationIntegrationEvent>;
        /** The complete bounded observation before event filters are applied. */
        readonly window?: import("@octant/contracts").AutomationEventSourceWindow;
      }
    | {
        readonly kind: "unavailable";
        readonly reason: "source-unavailable" | "source-limit";
        readonly retryAfterSeconds?: number;
      }
  >;
}

/**
 * Request header a plugin uses to ask the host fetch interceptor to attach
 * the named credential reference as an Authorization bearer token. The header
 * is stripped before the request leaves the host; its value is an opaque
 * reference, never raw token material.
 */
export const INTEGRATION_CREDENTIAL_REF_HEADER = "x-octant-credential-ref";

/**
 * Host-owned PKCE authorization request. The plugin names the external
 * endpoints and public client id; the host generates the verifier, stores it,
 * and never returns token material.
 */
export interface IntegrationPkceAuthorizationRequest {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: ReadonlyArray<string>;
  readonly extraParams?: Readonly<Record<string, string>>;
}

export type IntegrationPkceBeginResult =
  | { readonly kind: "redirect"; readonly authorizationUrl: string }
  | { readonly kind: "refused"; readonly reason: string };

export type IntegrationPkceRefreshResult =
  | { readonly kind: "ready" }
  | { readonly kind: "invalid_grant" }
  | { readonly kind: "failed"; readonly reason: string };

export type IntegrationRevokeResult = { readonly kind: "revoked" } | { readonly kind: "cleared" };

/**
 * The host port passed to an Integration plugin. It exposes only the narrow
 * capabilities the plugin declared: outbound network requests as a configured
 * fetch, opaque credential references through the host's credential broker, and
 * host-owned PKCE authorization that never returns raw tokens. Raw tokens,
 * filesystem handles, and shell access are never handed over.
 */
export interface IntegrationHostPort {
  /** Register a fixed one-use operation. Availability never grants consent. */
  readonly registerCredentialOperation?: (
    operation: CredentialOperation,
  ) => { readonly kind: "registered"; readonly release: () => void } | { readonly kind: "refused" };
  readonly fetch: (input: Request) => Promise<Response>;
  readonly requestCredential: (scope: string) => Promise<IntegrationCredentialRequestResult>;
  readonly beginPkceAuthorization: (
    request: IntegrationPkceAuthorizationRequest,
  ) => Promise<IntegrationPkceBeginResult>;
  readonly refreshPkceAuthorization: (request: {
    readonly scope: string;
    readonly tokenEndpoint: string;
    readonly clientId: string;
  }) => Promise<IntegrationPkceRefreshResult>;
  readonly revokeCredential: (request: {
    readonly scope: string;
    readonly revokeEndpoint: string;
  }) => Promise<IntegrationRevokeResult>;
}

/**
 * Runtime an Integration plugin returns after being constructed with a host
 * port. The host routes authentication and operation commands here and receives
 * observations in return.
 */
export interface IntegrationRuntime {
  readonly observe: (
    command: IntegrationCommand,
    signal?: AbortSignal,
  ) => Promise<IntegrationObservation>;
  readonly execute: (
    command: IntegrationCommand,
    signal?: AbortSignal,
  ) => Promise<IntegrationObservation>;
  readonly close: () => Promise<void>;
}
