import { BROWSER_TOOL_DEFINITION } from "../browser/browserToolDefinition";
import { describe, expect, it, vi } from "vitest";
import { createOpenCodeManagedToolsBridge } from "./openCodeManagedTools";

const definition = BROWSER_TOOL_DEFINITION;

describe("OpenCode managed tool bridge", () => {
  it("serves only the offered catalogue over an authenticated loopback path", async () => {
    const execute = vi.fn(async () => ({
      resultJson: '{"heading":"Example Domain"}',
      isError: false,
    }));
    const bridge = await createOpenCodeManagedToolsBridge([definition], execute);
    try {
      let attested = false;
      const attestation = bridge.attested.then(() => {
        attested = true;
      });
      expect(attested).toBe(false);
      const initialize = await fetch(bridge.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test-opencode", version: "1" },
          },
        }),
      });
      expect(initialize.status).toBe(200);
      expect(attested).toBe(false);
      const sessionId = initialize.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();
      const headers = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
      };
      await fetch(bridge.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
      });
      const listed = await fetch(bridge.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      expect(await rpcJson(listed)).toMatchObject({ result: { tools: [definition] } });
      await attestation;
      expect(attested).toBe(true);
      const resultResponse = await fetch(bridge.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "octant_browser", arguments: { operation: "read-page" } },
        }),
      });
      const result = await rpcJson(resultResponse);
      expect(execute).toHaveBeenCalledWith(
        "octant_browser",
        '{"operation":"read-page"}',
        expect.any(AbortSignal),
      );
      expect(result).toMatchObject({
        result: {
          content: [{ type: "text", text: '{"heading":"Example Domain"}' }],
          isError: false,
        },
      });
      const foreign = await fetch(new URL(`${bridge.url}/foreign`));
      expect(foreign.status).toBe(404);
      const wrongHost = await fetch(bridge.url.replace("127.0.0.1", "localhost"));
      expect(wrongHost.status).toBe(404);
      const browserOrigin = await fetch(bridge.url, {
        headers: { origin: "https://example.invalid" },
      });
      expect(browserOrigin.status).toBe(404);
    } finally {
      await bridge.close();
    }
  });
});

async function rpcJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(body) as unknown;
  }
  const data = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());
  const payload = data.at(-1);
  if (payload === undefined) throw new Error("MCP response did not contain an SSE payload.");
  return JSON.parse(payload) as unknown;
}
