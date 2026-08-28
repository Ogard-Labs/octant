import type {
  IntegrationAccount,
  IntegrationAuthenticationSnapshot,
  IntegrationObservation,
} from "@octant/contracts/integration";
import type { IntegrationHostPort, IntegrationRuntime } from "@octant/plugin-api/integration";
import {
  LINEAR_AUTHORIZE_URL,
  LINEAR_OAUTH_SCOPES,
  LINEAR_OAUTH_UNCONFIGURED,
  LINEAR_RECONNECT_REASON,
  LINEAR_REVOKE_URL,
  LINEAR_TOKEN_URL,
} from "./linearConstants";
import {
  graphqlWithReference,
  LINEAR_ISSUE_RATE_LIMITED,
  LINEAR_ISSUE_UNAVAILABLE,
  isRecord,
  readName,
} from "./linearGraphql";
import { executeLinearIssueOperation, linearIssueBrowseCapabilities } from "./linearIssueBrowse";

export {
  LINEAR_AUTHORIZE_URL,
  LINEAR_GRAPHQL_URL,
  LINEAR_OAUTH_SCOPES,
  LINEAR_OAUTH_UNCONFIGURED,
  LINEAR_RECONNECT_REASON,
  LINEAR_REVOKE_URL,
  LINEAR_TOKEN_URL,
} from "./linearConstants";

const IDENTITY_QUERY = "{ viewer { id name organization { name urlKey } } }";

export interface LinearIntegrationConfig {
  readonly clientId?: string;
  readonly redirectUri: string;
}

/**
 * Linear Integration plugin. It names Linear's OAuth endpoints and identity
 * query; the host port performs PKCE, stores tokens, and attaches them to
 * outbound requests. Token material never appears in observations.
 */
export function createLinearIntegration(
  hostPort: IntegrationHostPort,
  config: LinearIntegrationConfig,
): IntegrationRuntime {
  const snapshot = async (signal?: AbortSignal): Promise<IntegrationObservation> => ({
    kind: "authentication",
    snapshot: await observeAuthentication(hostPort, config, signal),
  });

  return {
    observe: async (command, signal) => {
      if (command.kind === "operation") {
        return {
          kind: "operation",
          operationId: command.operationId,
          result: await executeLinearIssueOperation(
            hostPort,
            command.operationId,
            command.input,
            signal,
          ),
        };
      }
      return snapshot(signal);
    },
    execute: async (command, signal) => {
      if (command.kind === "operation") {
        return {
          kind: "operation",
          operationId: command.operationId,
          result: await executeLinearIssueOperation(
            hostPort,
            command.operationId,
            command.input,
            signal,
          ),
        };
      }
      return {
        kind: "authentication",
        snapshot: await executeAuthentication(hostPort, config, command.command.kind, signal),
      };
    },
    close: async () => {},
  };
}

export default function createLinearIntegrationRuntime(
  hostPort: IntegrationHostPort,
): IntegrationRuntime {
  return createLinearIntegration(hostPort, {
    redirectUri: "http://127.0.0.1:52693/oauth/linear/callback",
  });
}

async function executeAuthentication(
  hostPort: IntegrationHostPort,
  config: LinearIntegrationConfig,
  kind: "setup" | "refresh" | "logout",
  signal?: AbortSignal,
): Promise<IntegrationAuthenticationSnapshot> {
  if (kind === "setup") {
    const clientId = configuredClientId(config.clientId);
    if (clientId === undefined) {
      return unauthorized(LINEAR_OAUTH_UNCONFIGURED);
    }
    const began = await hostPort.beginPkceAuthorization({
      authorizationEndpoint: LINEAR_AUTHORIZE_URL,
      tokenEndpoint: LINEAR_TOKEN_URL,
      clientId,
      redirectUri: config.redirectUri,
      scopes: [...LINEAR_OAUTH_SCOPES],
      extraParams: { prompt: "consent", actor: "user" },
    });
    if (began.kind === "refused") return unauthorized(began.reason);
    return {
      state: "unauthorized",
      capabilities: [],
      remediation: "Open Linear to approve access, then return here.",
      interaction: {
        kind: "authorization-redirect",
        authorizationUri: began.authorizationUrl,
      },
    };
  }
  if (kind === "refresh") {
    const clientId = configuredClientId(config.clientId);
    if (clientId === undefined) return unauthorized(LINEAR_OAUTH_UNCONFIGURED);
    const refreshed = await hostPort.refreshPkceAuthorization({
      scope: "oauth",
      tokenEndpoint: LINEAR_TOKEN_URL,
      clientId,
    });
    if (refreshed.kind === "invalid_grant") return reconnectSnapshot();
    if (refreshed.kind === "failed") return unauthorized(refreshed.reason);
    return observeAuthentication(hostPort, config, signal);
  }
  const revoked = await hostPort.revokeCredential({
    scope: "oauth",
    revokeEndpoint: LINEAR_REVOKE_URL,
  });
  return unauthorized(
    revoked.kind === "revoked"
      ? "Disconnected from Linear on this host."
      : "Disconnected from Linear on this host. Linear may still show this app as authorized.",
  );
}

async function observeAuthentication(
  hostPort: IntegrationHostPort,
  config: LinearIntegrationConfig,
  signal?: AbortSignal,
): Promise<IntegrationAuthenticationSnapshot> {
  const oauth = await hostPort.requestCredential("oauth");
  if (oauth.kind === "refused") return reconnectSnapshot();
  // A refused OAuth credential is an expired grant. Do not consult a personal
  // API key — that fallback is forbidden.
  if (oauth.kind === "granted") {
    return identitySnapshot(hostPort, oauth.reference, "oauth", signal);
  }
  const personal = await hostPort.requestCredential("personal-api-key");
  if (personal.kind === "granted") {
    return identitySnapshot(hostPort, personal.reference, "personal-api-key", signal);
  }
  const clientId = configuredClientId(config.clientId);
  if (clientId === undefined) return unauthorized(LINEAR_OAUTH_UNCONFIGURED);
  return unauthorized("Connect Linear to authorize this host.");
}

async function identitySnapshot(
  hostPort: IntegrationHostPort,
  reference: string,
  source: "oauth" | "personal-api-key",
  signal?: AbortSignal,
): Promise<IntegrationAuthenticationSnapshot> {
  const result = await graphqlWithReference(
    hostPort,
    reference,
    source,
    IDENTITY_QUERY,
    undefined,
    signal,
  );
  if (result.kind === "unauthorized") {
    return source === "personal-api-key" && !result.reconnect
      ? unauthorized("The Linear personal API key was rejected.")
      : reconnectSnapshot();
  }
  if (result.kind === "rate-limited") {
    return { state: "rate-limited", capabilities: [], remediation: LINEAR_ISSUE_RATE_LIMITED };
  }
  if (result.kind !== "ok") {
    return { state: "unavailable", capabilities: [], remediation: LINEAR_ISSUE_UNAVAILABLE };
  }
  const account = readIdentity(result.body, source);
  if (account === undefined) {
    return {
      state: "unavailable",
      capabilities: [],
      remediation: "Linear identity is unavailable.",
    };
  }
  return { state: "ready", account, capabilities: [...linearIssueBrowseCapabilities()] };
}

function readIdentity(
  body: unknown,
  source: "oauth" | "personal-api-key",
): IntegrationAccount | undefined {
  if (!isRecord(body) || !isRecord(body.data)) return undefined;
  const viewer = isRecord(body.data.viewer) ? body.data.viewer : undefined;
  const organization =
    viewer !== undefined && isRecord(viewer.organization) ? viewer.organization : undefined;
  const login =
    readName(organization?.urlKey) ?? readName(organization?.name) ?? readName(viewer?.name);
  if (login === undefined) return undefined;
  return { login, source, scopes: [...LINEAR_OAUTH_SCOPES] };
}

function configuredClientId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 128) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

function unauthorized(remediation: string): IntegrationAuthenticationSnapshot {
  return { state: "unauthorized", capabilities: [], remediation };
}

function reconnectSnapshot(): IntegrationAuthenticationSnapshot {
  return { state: "unauthorized", capabilities: [], remediation: LINEAR_RECONNECT_REASON };
}
