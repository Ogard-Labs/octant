import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { AGENT_PROOF_HEADER, type AgentConnectionFile } from "@octant/contracts";
import { agentProofHeader, agentProofPayload } from "@octant/domain";
import { agentListenerFetch, type AgentListenerFetch } from "./agentAccessTransport";
import { failure, messagesFrom, type JsonObject } from "./mcpCommand";

export const AGENT_MCP_PATH = "/api/agent-access/mcp";
export const AGENT_CLAIM_PATH = "/api/agent-access/claim";

const REFUSED_CREDENTIAL =
  "Octant refused this agent's credential: the grant is revoked or expired, or its key is not confirmed yet. Ask the person to check Settings › Agent access.";

export interface AgentMcpBridgePorts {
  readonly connection: AgentConnectionFile;
  /** The MCP client's messages, one JSON message per line. */
  readonly input: AsyncIterable<string | Uint8Array>;
  /** Protocol frames only. */
  readonly stdout: { readonly write: (chunk: string) => unknown };
  readonly stderr: { readonly write: (chunk: string) => unknown };
  readonly fetch?: AgentListenerFetch;
  readonly now?: () => number;
}

/**
 * `octant agent mcp --connection <file>`: the stdio MCP server an MCP client on
 * another machine starts. It answers nothing itself: every message goes to
 * the host's agent-access endpoint, signed with the key this machine made when
 * it joined, over a connection held to the listener's certificate pin. The
 * host decides everything; this command holds no policy.
 */
export async function runAgentMcpBridge(ports: AgentMcpBridgePorts): Promise<number> {
  const listener =
    ports.fetch ??
    agentListenerFetch({
      origin: ports.connection.origin,
      ...(ports.connection.pin === undefined ? {} : { pin: ports.connection.pin }),
    });
  const privateKey = createPrivateKey(ports.connection.privateKey);
  const now = ports.now ?? Date.now;
  const inFlight = new Set<Promise<void>>();
  const write = (message: unknown) => ports.stdout.write(`${JSON.stringify(message)}\n`);
  for await (const message of messagesFrom(ports.input)) {
    if (message.kind === "malformed") {
      write(message.answer);
      continue;
    }
    const { id, body } = message;
    const signed = signedHeaders(ports.connection, privateKey, body, now());
    const forwarded = listener({
      path: AGENT_MCP_PATH,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        [AGENT_PROOF_HEADER]: signed,
      },
      body,
    })
      .then((response) => {
        if (response.status === 202) return;
        if (response.status === 200) {
          for (const answer of answersIn(response.contentType, response.body)) write(answer);
          return;
        }
        if (id === undefined) return;
        if (response.status === 401) write(failure(id, -32001, REFUSED_CREDENTIAL));
        else if (response.status === 429) {
          write(
            failure(
              id,
              -32002,
              "Octant's limit for this agent is reached for now; try again in a minute.",
            ),
          );
        } else write(failure(id, -32603, `Octant answered ${response.status}.`));
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        ports.stderr.write(`${reason}\n`);
        if (id !== undefined) write(failure(id, -32603, `Octant could not be reached: ${reason}`));
      });
    inFlight.add(forwarded);
    void forwarded.finally(() => inFlight.delete(forwarded));
  }
  await Promise.all(inFlight);
  return 0;
}

/** The proof header for one request body, signed with this machine's key. */
export function signedHeaders(
  connection: Pick<AgentConnectionFile, "grantId" | "fingerprint" | "hostId">,
  privateKey: ReturnType<typeof createPrivateKey>,
  body: string,
  at: number,
): string {
  const timestamp = String(at);
  const nonce = randomBytes(18).toString("base64url");
  const payload = agentProofPayload({
    method: "POST",
    pathWithQuery: AGENT_MCP_PATH,
    bodyDigest: createHash("sha256").update(body, "utf8").digest("hex"),
    timestamp,
    nonce,
    hostId: connection.hostId,
    grantId: String(connection.grantId),
    fingerprint: connection.fingerprint,
  });
  const signature = sign("sha256", Buffer.from(payload, "utf8"), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return agentProofHeader({
    grantId: String(connection.grantId),
    fingerprint: connection.fingerprint,
    timestamp,
    nonce,
    signature,
  });
}

/** The JSON-RPC messages in a JSON body, or in each event of a server-sent stream. */
function answersIn(contentType: string, body: string): ReadonlyArray<JsonObject> {
  const parse = (text: string): JsonObject | undefined => {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as JsonObject)
        : undefined;
    } catch {
      return undefined;
    }
  };
  if (!contentType.includes("text/event-stream")) {
    const single = parse(body);
    return single === undefined ? [] : [single];
  }
  return body
    .replaceAll("\r\n", "\n")
    .split("\n\n")
    .flatMap((event) => {
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).replace(/^ /, ""))
        .join("\n");
      const message = data === "" ? undefined : parse(data);
      return message === undefined ? [] : [message];
    });
}
