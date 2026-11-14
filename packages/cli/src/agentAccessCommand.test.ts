import { createHash, verify } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_PROOF_HEADER, decodeAgentConnectionFile } from "@octant/contracts";
import { agentProofPayload } from "@octant/domain";
import { runAgentMcpBridge } from "./agentAccessBridge";
import { resolveAgentAccessCliCommand, runAgentAccessJoin } from "./agentAccessCommand";
import { agentLoopbackFetch, type AgentListenerFetch } from "./agentAccessTransport";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const code = {
  origin: "https://10.0.0.5:8443",
  hostId: "40000000-0000-4000-8000-000000000001",
  grantId: "10000000-0000-4000-8000-000000000001",
  ticketId: "50000000-0000-4000-8000-000000000001",
  ticketProof: "cHJvb2Y",
  pin: `sha256-${"A".repeat(43)}`,
};
const connectionCode = `octant-agent-1.${Buffer.from(JSON.stringify(code)).toString("base64url")}`;

function sink() {
  const chunks: string[] = [];
  return { write: (chunk: string) => chunks.push(chunk), text: () => chunks.join("") };
}

describe("octant agent-access", () => {
  it("parses a grant's scope, takes Full access when the person names it, and refuses an unknown level", () => {
    expect(
      resolveAgentAccessCliCommand(["create", "Home bot"], {
        project: "repo,site",
        access: "auto",
        direct: true,
        "turns-per-day": "20",
      }),
    ).toMatchObject({
      action: "create",
      name: "Home bot",
      projects: ["repo", "site"],
      level: "auto",
      direct: true,
      turnsPerDay: 20,
      days: 30,
    });
    expect(
      resolveAgentAccessCliCommand(["create", "Bot"], { project: "repo", access: "full-access" }),
    ).toMatchObject({ action: "create", level: "full-access" });
    expect(
      resolveAgentAccessCliCommand(["create", "Bot"], { project: "repo", access: "everything" }),
    ).toBeUndefined();
    expect(resolveAgentAccessCliCommand(["revoke", "Bot"], { "stop-turns": true })).toEqual({
      action: "revoke",
      grant: "Bot",
      stopTurns: true,
    });
    expect(resolveAgentAccessCliCommand(["join"], {})).toBeUndefined();
  });

  it("joins with a key made on this machine and keeps the private half in an owner-only file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-agent-join-"));
    directories.push(directory);
    const out = join(directory, "agent.json");
    let claimed: Record<string, string> = {};
    const fetch: AgentListenerFetch = async ({ path, body }) => {
      expect(path).toBe("/api/agent-access/claim");
      claimed = JSON.parse(body) as Record<string, string>;
      return { status: 202, contentType: "application/json", body: "{}" };
    };
    const stdout = sink();
    const exit = await runAgentAccessJoin({
      command: { action: "join", code: connectionCode, out, label: "laptop" },
      fetch,
      stdout,
      stderr: sink(),
    });
    expect(exit).toBe(0);
    const file = decodeAgentConnectionFile(JSON.parse(readFileSync(out, "utf8")));
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(claimed).toMatchObject({
      ticketId: code.ticketId,
      ticketProof: code.ticketProof,
      label: "laptop",
    });
    // The host sees only the public half, and its fingerprint is what the person confirms.
    expect(claimed.publicKey).toBe(file.publicKey);
    expect(JSON.stringify(claimed)).not.toContain("PRIVATE KEY");
    expect(stdout.text()).toContain(
      `octant agent-access confirm 10000000 ${file.fingerprint.slice(0, 16)}`,
    );
  });

  it("says the code is used or expired when the host refuses the claim", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-agent-join-"));
    directories.push(directory);
    const stderr = sink();
    const exit = await runAgentAccessJoin({
      command: { action: "join", code: connectionCode, out: join(directory, "a.json"), label: "x" },
      fetch: async () => ({ status: 401, contentType: "application/json", body: "{}" }),
      stdout: sink(),
      stderr,
    });
    expect(exit).toBe(1);
    expect(stderr.text()).toContain("expired, was used already");
  });
});

describe("the agent bridge", () => {
  it("signs each message so the host can verify it, and reports a refused credential plainly", async () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-agent-bridge-"));
    directories.push(directory);
    const out = join(directory, "agent.json");
    await runAgentAccessJoin({
      command: { action: "join", code: connectionCode, out, label: "laptop" },
      fetch: async () => ({ status: 202, contentType: "application/json", body: "{}" }),
      stdout: sink(),
      stderr: sink(),
    });
    const connection = decodeAgentConnectionFile(JSON.parse(readFileSync(out, "utf8")));
    const requests: Array<{ headers: Readonly<Record<string, string>>; body: string }> = [];
    const stdout = sink();
    await runAgentMcpBridge({
      connection,
      input: Readable.from([
        '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n',
        '{"jsonrpc":"2.0","id":2,"method":"ping"}\n',
      ]),
      stdout,
      stderr: sink(),
      now: () => 1_700_000_000_000,
      fetch: async (request) => {
        requests.push(request);
        return JSON.parse(request.body).id === 1
          ? {
              status: 200,
              contentType: "text/event-stream",
              body: `: keepalive\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n`,
            }
          : { status: 401, contentType: "application/json", body: '{"error":"unauthorized"}' };
      },
    });
    const first = requests[0];
    const proof = first?.headers[AGENT_PROOF_HEADER] ?? "";
    const [, grantId = "", fingerprint = "", timestamp = "", nonce = "", signature = ""] =
      proof.split(".");
    const payload = agentProofPayload({
      method: "POST",
      pathWithQuery: "/api/agent-access/mcp",
      bodyDigest: createHash("sha256")
        .update(first?.body ?? "")
        .digest("hex"),
      timestamp,
      nonce,
      hostId: code.hostId,
      grantId,
      fingerprint,
    });
    expect(
      verify(
        "sha256",
        Buffer.from(payload),
        { key: connection.publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    const answers = stdout
      .text()
      .trim()
      .split("\n")
      .map(
        (line) => JSON.parse(line) as { id: number; result?: unknown; error?: { code: number } },
      );
    expect(answers.find((answer) => answer.id === 1)?.result).toEqual({ tools: [] });
    expect(answers.find((answer) => answer.id === 2)?.error?.code).toBe(-32001);
  });

  it("reaches the host on this computer over loopback with only the signed proof, and refuses any other address", async () => {
    const received: Array<{ readonly url: string; readonly headers: IncomingHttpHeaders }> = [];
    const server = createServer((request, response) => {
      received.push({ url: request.url ?? "", headers: request.headers });
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      const answer = await agentLoopbackFetch(`http://127.0.0.1:${String(address.port)}`)({
        path: "/api/agent-access/mcp",
        headers: { "content-type": "application/json", [AGENT_PROOF_HEADER]: "v1.proof" },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      });
      expect(answer.status).toBe(200);
      expect(received.map((request) => request.url)).toEqual(["/api/agent-access/mcp"]);
      expect(received[0]?.headers[AGENT_PROOF_HEADER]).toBe("v1.proof");
      expect(received[0]?.headers["x-octant-desktop-secret"]).toBeUndefined();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    await expect(
      agentLoopbackFetch("http://192.168.1.20:4800")({
        path: "/api/agent-access/mcp",
        headers: {},
        body: "{}",
      }),
    ).rejects.toThrow("not a loopback address");
  });
});
