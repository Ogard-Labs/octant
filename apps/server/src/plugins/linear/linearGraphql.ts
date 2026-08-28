import {
  INTEGRATION_CREDENTIAL_REF_HEADER,
  type IntegrationHostPort,
} from "@octant/plugin-api/integration";
import { LINEAR_GRAPHQL_URL, LINEAR_RECONNECT_REASON } from "./linearConstants";

export const LINEAR_ISSUE_UNAVAILABLE = "Linear is unavailable.";
export const LINEAR_ISSUE_UNAUTHORIZED = "Connect Linear to authorize this host.";
export const LINEAR_ISSUE_FORBIDDEN =
  "This host cannot read Linear issues with the current authorization.";
export const LINEAR_ISSUE_RATE_LIMITED = "Linear is rate limited. Try again in a moment.";
export const LINEAR_ISSUE_NOT_FOUND = "That Linear issue is not available.";

export type LinearGraphqlResult =
  | { readonly kind: "ok"; readonly body: unknown }
  | { readonly kind: "unauthorized"; readonly reconnect: boolean }
  | { readonly kind: "rate-limited" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" };

export async function requestLinearCredential(
  hostPort: IntegrationHostPort,
): Promise<
  | {
      readonly kind: "granted";
      readonly reference: string;
      readonly source: "oauth" | "personal-api-key";
    }
  | { readonly kind: "unauthorized"; readonly reconnect: boolean }
  | { readonly kind: "unavailable" }
> {
  const oauth = await hostPort.requestCredential("oauth");
  if (oauth.kind === "refused") return { kind: "unauthorized", reconnect: true };
  if (oauth.kind === "granted")
    return { kind: "granted", reference: oauth.reference, source: "oauth" };
  const personal = await hostPort.requestCredential("personal-api-key");
  if (personal.kind === "granted") {
    return { kind: "granted", reference: personal.reference, source: "personal-api-key" };
  }
  if (personal.kind === "refused") return { kind: "unauthorized", reconnect: false };
  return { kind: "unavailable" };
}

export async function linearGraphql(
  hostPort: IntegrationHostPort,
  query: string,
  variables: Readonly<Record<string, unknown>> | undefined,
  signal?: AbortSignal,
): Promise<LinearGraphqlResult> {
  const credential = await requestLinearCredential(hostPort);
  if (credential.kind !== "granted") return credential;
  return graphqlWithReference(
    hostPort,
    credential.reference,
    credential.source,
    query,
    variables,
    signal,
  );
}

export async function graphqlWithReference(
  hostPort: IntegrationHostPort,
  reference: string,
  source: "oauth" | "personal-api-key",
  query: string,
  variables: Readonly<Record<string, unknown>> | undefined,
  signal?: AbortSignal,
): Promise<LinearGraphqlResult> {
  let response: Response;
  try {
    response = await hostPort.fetch(
      new Request(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [INTEGRATION_CREDENTIAL_REF_HEADER]: reference,
        },
        body: JSON.stringify(variables === undefined ? { query } : { query, variables }),
        ...(signal === undefined ? {} : { signal }),
      }),
    );
  } catch {
    return { kind: "unavailable" };
  }
  if (response.status === 429) return { kind: "rate-limited" };
  if (response.status === 401) {
    const body = await readJson(response);
    const reconnect = source === "oauth" || (isRecord(body) && body.error === "invalid_grant");
    return { kind: "unauthorized", reconnect };
  }
  if (response.status === 403) return { kind: "forbidden" };
  if (!response.ok) return { kind: "unavailable" };
  const body = await readJson(response);
  if (body === undefined) return { kind: "unavailable" };
  const graphqlError = readGraphqlFailure(body);
  if (graphqlError !== undefined) return graphqlError;
  return { kind: "ok", body };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readName(value: unknown, limit = 128): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, limit)
    : undefined;
}

export function boundUtf8(
  value: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return { text: value, truncated: false };
  let end = maxBytes;
  while (end > 0 && ((encoded[end] ?? 0) & 0b11000000) === 0b10000000) end -= 1;
  return { text: new TextDecoder().decode(encoded.subarray(0, end)).trimEnd(), truncated: true };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function readGraphqlFailure(body: unknown): LinearGraphqlResult | undefined {
  if (!isRecord(body) || !Array.isArray(body.errors) || body.errors.length === 0) {
    return undefined;
  }
  for (const entry of body.errors) {
    if (!isRecord(entry)) continue;
    const extensions = isRecord(entry.extensions) ? entry.extensions : undefined;
    const code = typeof extensions?.code === "string" ? extensions.code.toUpperCase() : "";
    if (code.includes("AUTH") || code === "UNAUTHENTICATED" || code === "INVALID_TOKEN") {
      return { kind: "unauthorized", reconnect: true };
    }
    if (code === "FORBIDDEN" || code === "SSO_REQUIRED" || code.includes("SCOPE")) {
      return { kind: "forbidden" };
    }
    if (code.includes("RATE")) return { kind: "rate-limited" };
  }
  return { kind: "unavailable" };
}

export function reconnectReason(reconnect: boolean): string {
  return reconnect ? LINEAR_RECONNECT_REASON : LINEAR_ISSUE_UNAUTHORIZED;
}
