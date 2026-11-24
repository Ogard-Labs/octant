import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createManagedMcpTools } from "./managedMcpTools";

it("keeps the credential tool listed, and leaves the rest to the runtime", async () => {
  const definition = (name: string) => ({
    name,
    description: "A tool.",
    inputSchema: { type: "object" as const, properties: {} },
  });
  const made = createManagedMcpTools(
    [definition("octant_credential"), definition("octant_canvas")],
    async () => ({ resultJson: "{}", isError: false }),
  );
  if (made.kind !== "ready") throw new Error("No server.");
  const [here, there] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([made.server.connect(here), client.connect(there)]);
  const { tools } = await client.listTools();
  expect(tools.map(({ name, _meta }) => [name, _meta?.["anthropic/alwaysLoad"]])).toEqual([
    ["octant_credential", true],
    ["octant_canvas", undefined],
  ]);
  await client.close();
});
