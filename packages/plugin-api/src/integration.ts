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
