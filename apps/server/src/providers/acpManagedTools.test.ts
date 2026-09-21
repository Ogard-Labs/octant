import { request as httpRequest } from "node:http";
import { BROWSER_TOOL_DEFINITION } from "../browser/browserToolDefinition";
import { describe, expect, it, vi } from "vitest";
import { createAcpManagedToolsBridge } from "./acpManagedTools";

const definition = BROWSER_TOOL_DEFINITION;

describe("ACP managed tool bridge", () => {
  it("serves the exact offered catalogue over an authenticated loopback path", async (context) => {
    const execute = vi.fn(async () => ({
      resultJson: '{"heading":"Example Domain"}',
      isError: false,
    }));
    let bridge;
    try {
      bridge = await createAcpManagedToolsBridge([definition], execute);
    } catch (error) {
      if (error instanceof Error && error.message.includes("listen EPERM")) {
        context.skip("the test sandbox does not permit loopback listeners");
        return;
      }
      throw error;
    }
    try {
      expect(bridge.port).toBeGreaterThan(0);
      const authorization = bridge.server.headers[0];
      if (authorization === undefined) throw new Error("Missing bridge credential.");
      const commonHeaders = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        Authorization: authorization.value,
      };
      const initialize = await fetch(bridge.server.url, {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test-acp", version: "1" },
          },
        }),
      });
      expect(initialize.status).toBe(200);
      const sessionId = initialize.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();
      const headers = {
        ...commonHeaders,
        ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
      };
      await fetch(bridge.server.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
      });
      const listed = await fetch(bridge.server.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      expect(await rpcJson(listed)).toMatchObject({ result: { tools: [definition] } });
      await expect(bridge.attested).resolves.toBeUndefined();
      const resultResponse = await fetch(bridge.server.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "octant_browser", arguments: { operation: "read-page" } },
        }),
      });
      expect(execute).toHaveBeenCalledWith(
        "octant_browser",
        '{"operation":"read-page"}',
        expect.any(AbortSignal),
      );
      expect(await rpcJson(resultResponse)).toMatchObject({
        result: {
          content: [{ type: "text", text: '{"heading":"Example Domain"}' }],
          isError: false,
        },
      });
      const next = vi.fn(async () => ({ resultJson: '{"turn":"next"}', isError: false }));
      const delayedBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "octant_browser", arguments: { operation: "read-page" } },
      });
      const delayed = new Promise<string>((resolve, reject) => {
        const request = httpRequest(
          bridge.server.url,
          {
            method: "POST",
            headers: {
              ...headers,
              Expect: "100-continue",
              "content-length": Buffer.byteLength(delayedBody),
            },
          },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => {
              body += chunk;
            });
            response.on("end", () => resolve(body));
            response.on("error", reject);
          },
        );
        request.on("error", reject);
        request.on("continue", () => {
          bridge.bind(next);
          request.end(delayedBody);
        });
        request.flushHeaders();
      });
      expect(await delayed).toContain("tool-interrupted");
      expect(next).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
      const fresh = await fetch(bridge.server.url, {
        method: "POST",
        headers,
        body: delayedBody.replace('"id":4', '"id":5'),
      });
      expect(await rpcJson(fresh)).toMatchObject({ result: { isError: false } });
      expect(next).toHaveBeenCalledTimes(1);
      bridge.bind(undefined);
      const idle = await fetch(bridge.server.url, {
        method: "POST",
        headers,
        body: delayedBody.replace('"id":4', '"id":6'),
      });
      expect(await rpcJson(idle)).toMatchObject({ result: { isError: true } });
      expect(next).toHaveBeenCalledTimes(1);
      expect(
        (await fetch(bridge.server.url, { method: "POST", headers: commonHeaders })).status,
      ).toBe(400);
      expect(
        (await fetch(bridge.server.url, { headers: { Authorization: "Bearer wrong" } })).status,
      ).toBe(404);
      expect(
        (
          await fetch(bridge.server.url, {
            headers: { ...commonHeaders, origin: "https://example.invalid" },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(bridge.server.url.replace("127.0.0.1", "localhost"), {
            headers: commonHeaders,
          })
        ).status,
      ).toBe(404);
    } finally {
      await bridge.close();
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
