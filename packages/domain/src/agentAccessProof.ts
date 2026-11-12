/**
 * The exact text a bridge signs for one agent-access request, and the host
 * verifies. Every field that decides what the request does is in it: the
 * method, the path and query, a digest of the body, when and with which
 * nonce it was made, which host it was meant for, and which grant and key
 * sign it. A request replayed to another host, path, or grant fails.
 */
export function agentProofPayload(input: {
  readonly method: string;
  readonly pathWithQuery: string;
  /** Lowercase hex SHA-256 of the request body. */
  readonly bodyDigest: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly hostId: string;
  readonly grantId: string;
  readonly fingerprint: string;
}): string {
  return [
    "octant-agent-proof-v1",
    input.method.toUpperCase(),
    input.pathWithQuery,
    input.bodyDigest,
    input.timestamp,
    input.nonce,
    input.hostId,
    input.grantId,
    input.fingerprint,
  ].join("\n");
}

/** The header value carrying a bridge request's proof. */
export function agentProofHeader(input: {
  readonly grantId: string;
  readonly fingerprint: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly signature: string;
}): string {
  return `v1.${input.grantId}.${input.fingerprint}.${input.timestamp}.${input.nonce}.${input.signature}`;
}
