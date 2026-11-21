import {
  McpServerConnectionListing,
  McpServerSignInRelayResult,
  McpServerSignInView,
  decodeMcpServerSignInRelayRequest,
  decodeMcpServerSignInRequest,
  type McpServerSignInRelayRequest,
  type McpServerSignInRequest,
} from "@octant/contracts/extension-rpc";
import { decodeHostAnswer } from "@octant/contracts";
import type { MobileRemoteTransport } from "./mobileInboxClient";

const CONNECTIONS_PATH = "/api/extensions/connections";
const SIGN_IN_PATH = "/api/extensions/sign-in";
const RELAY_PATH = "/api/extensions/mcp-sign-in/relay";

/** Lists installed MCP servers and their retained connection state for a paired phone. */
export async function listMobileMcpConnections(input: {
  readonly transport: MobileRemoteTransport;
  readonly signal?: AbortSignal;
}): Promise<McpServerConnectionListing> {
  const response = await input.transport.authenticatedFetch({
    method: "POST",
    path: CONNECTIONS_PATH,
    body: JSON.stringify({ kind: "list" }),
    contentType: "application/json",
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) throw new Error(`Listing connectors failed with ${response.status}.`);
  return decodeHostAnswer(McpServerConnectionListing)(await response.json());
}

/** Reads, begins, polls, or cancels/signs out a hosted connector sign-in over the paired session. */
export async function mobileMcpServerSignIn(input: {
  readonly transport: MobileRemoteTransport;
  readonly request: McpServerSignInRequest;
  readonly signal?: AbortSignal;
}): Promise<McpServerSignInView> {
  const validated = decodeMcpServerSignInRequest(input.request);
  const response = await input.transport.authenticatedFetch({
    method: "POST",
    path: SIGN_IN_PATH,
    body: JSON.stringify(validated),
    contentType: "application/json",
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) throw new Error(`Connector sign-in request failed with ${response.status}.`);
  return decodeHostAnswer(McpServerSignInView)(await response.json());
}

/** Relays a one-time loopback callback address once over the signed paired-device session. */
export async function relayMobileMcpServerSignIn(input: {
  readonly transport: MobileRemoteTransport;
  readonly request: McpServerSignInRelayRequest;
  readonly signal?: AbortSignal;
}): Promise<McpServerSignInRelayResult> {
  const validated = decodeMcpServerSignInRelayRequest(input.request);
  const response = await input.transport.authenticatedFetch({
    method: "POST",
    path: RELAY_PATH,
    body: JSON.stringify(validated),
    contentType: "application/json",
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) throw new Error(`Connector sign-in relay failed with ${response.status}.`);
  return decodeHostAnswer(McpServerSignInRelayResult)(await response.json());
}
