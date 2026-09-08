import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createManagedMcpTools } from "./managedMcpTools";

const definition = {
  name: "octant_browser",
  inputSchema: {
    type: "object",
    properties: { operation: { type: "string" } },
    required: ["operation"],
  },
};

describe("Session-owned app tools", () => {
  it("lists the offered tools and returns the app's answer to an exact named call", async () => {
    const execute = vi.fn(async () => ({
      resultJson: '{"heading":"Example Domain"}',
      isError: false,
    }));
    const managed = createManagedMcpTools([definition], execute);
    if (managed.kind !== "ready") throw new Error("Expected a valid tool catalogue");
    const client = new Client({ name: "test-runtime", version: "1" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await managed.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools).toEqual([definition]);
      const result = await client.callTool({
        name: "octant_browser",
        arguments: { operation: "read-page" },
      });
      expect(execute).toHaveBeenCalledWith(
        "octant_browser",
        '{"operation":"read-page"}',
        expect.any(AbortSignal),
      );
      expect(result).toMatchObject({
        content: [{ type: "text", text: '{"heading":"Example Domain"}' }],
        isError: false,
      });
      expect(await client.callTool({ name: "unoffered", arguments: {} })).toMatchObject({
        isError: true,
      });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await managed.server.close();
    }
  });

  it("forwards the provider session identity when the MCP client supplies it", async () => {
    const execute = vi.fn(async () => ({ resultJson: "{}", isError: false }));
    const managed = createManagedMcpTools([definition], execute);
    if (managed.kind !== "ready") throw new Error("Expected a valid tool catalogue");
    const client = new Client({ name: "test-runtime", version: "1" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await managed.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await client.callTool({
        name: "octant_browser",
        arguments: { operation: "read-page" },
        _meta: { sessionID: "provider-session" },
      });
      expect(execute).toHaveBeenCalledWith(
        "octant_browser",
        '{"operation":"read-page"}',
        expect.any(AbortSignal),
        { sessionId: "provider-session" },
      );
    } finally {
      await client.close();
      await managed.server.close();
    }
  });
});
